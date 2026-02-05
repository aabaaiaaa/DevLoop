import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import chalk from 'chalk';
import { readWorkspaceConfig, writeWorkspaceConfig } from './config.js';

/**
 * Format a DevLoop internal commit message using the configured format
 * @param action - What DevLoop is doing (e.g., "Initialize workspace", "Start run")
 */
export function formatDevloopCommit(format: string | undefined, action: string): string {
  if (format) {
    return format.replace(/\{action\}/g, action).trim();
  }
  return `DevLoop: ${action}`;
}

/**
 * Get the DevLoop commit message for an action, using workspace config if available
 */
export async function getDevloopCommitMessage(workspace: string, action: string): Promise<string> {
  const config = await readWorkspaceConfig(workspace);
  return formatDevloopCommit(config.devloopCommitFormat, action);
}

/**
 * Save a DevLoop commit format to workspace config, extracting {action} placeholder if possible
 */
export async function saveDevloopCommitFormat(workspace: string, userMessage: string, defaultAction: string): Promise<void> {
  // Try to detect if the user's message contains the default action text
  // If so, replace it with {action} placeholder for reuse
  let format: string;

  if (userMessage.includes(defaultAction)) {
    format = userMessage.replace(defaultAction, '{action}');
  } else {
    // User provided a completely custom message, save as-is with {action} appended
    // unless it already looks like it has a placeholder pattern
    if (userMessage.includes('{action}')) {
      format = userMessage;
    } else {
      // Can't infer a pattern, just save the literal message
      // Future commits will use default format
      format = userMessage;
    }
  }

  const config = await readWorkspaceConfig(workspace);
  config.devloopCommitFormat = format;
  await writeWorkspaceConfig(workspace, config);
}

/**
 * Execute a git command and return the result
 */
async function execGit(args: string[], cwd: string): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout.trim(),
        error: stderr.trim() || undefined
      });
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        output: '',
        error: err.message
      });
    });
  });
}

/**
 * Check if git is available on the system
 */
export async function isGitAvailable(): Promise<boolean> {
  const result = await execGit(['--version'], process.cwd());
  return result.success;
}

/**
 * Check if the workspace is inside a git repository
 * Uses git rev-parse to properly detect repos (handles nested dirs, submodules, etc.)
 */
export async function isGitRepo(workspace: string): Promise<boolean> {
  const result = await execGit(['rev-parse', '--is-inside-work-tree'], workspace);
  return result.success && result.output.trim() === 'true';
}

/**
 * Get the root directory of the git repository containing the workspace
 */
export async function getGitRoot(workspace: string): Promise<string | null> {
  const result = await execGit(['rev-parse', '--show-toplevel'], workspace);
  if (result.success && result.output.trim()) {
    return result.output.trim();
  }
  return null;
}

/**
 * Initialize a new git repository in the workspace
 */
export async function initGitRepo(workspace: string): Promise<boolean> {
  const result = await execGit(['init'], workspace);
  return result.success;
}

/**
 * Default .gitignore patterns for common development files
 */
const DEFAULT_GITIGNORE_PATTERNS = `# Dependencies
node_modules/
vendor/
.pnp/
.pnp.js

# Build outputs
dist/
build/
out/
*.tsbuildinfo

# Environment files
.env
.env.local
.env.*.local

# IDE and editor files
.idea/
.vscode/
*.swp
*.swo
*~

# OS files
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Test coverage
coverage/
.nyc_output/

# Misc
*.bak
*.tmp
`;

/**
 * Ensure .gitignore exists with sensible defaults.
 * If .gitignore doesn't exist, creates one.
 * If it exists but is missing critical patterns, appends them.
 * Creates .gitignore at the git root, not necessarily the workspace.
 */
export async function ensureGitignore(workspace: string, verbose: boolean = false): Promise<boolean> {
  // Find the git root - .gitignore should be there
  const gitRoot = await getGitRoot(workspace);
  const targetDir = gitRoot || workspace;
  const gitignorePath = path.join(targetDir, '.gitignore');

  try {
    // Check if .gitignore exists
    let existingContent = '';
    try {
      existingContent = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // File doesn't exist, will create it
    }

    // Critical patterns that should always be present
    const criticalPatterns = ['node_modules/', '.env'];
    const missingPatterns: string[] = [];

    for (const pattern of criticalPatterns) {
      // Check if pattern exists (accounting for variations like "node_modules" vs "node_modules/")
      const patternBase = pattern.replace(/\/$/, '');
      const hasPattern = existingContent.split('\n').some(line => {
        const trimmed = line.trim().replace(/\/$/, '');
        return trimmed === patternBase || trimmed === pattern;
      });
      if (!hasPattern) {
        missingPatterns.push(pattern);
      }
    }

    if (!existingContent) {
      // No .gitignore, create with defaults
      await fs.writeFile(gitignorePath, DEFAULT_GITIGNORE_PATTERNS, 'utf-8');
      console.log(chalk.green(`Created .gitignore at ${gitignorePath}`));
      return true;
    } else if (missingPatterns.length > 0) {
      // .gitignore exists but missing critical patterns
      const additions = `\n# Added by DevLoop\n${missingPatterns.join('\n')}\n`;
      await fs.appendFile(gitignorePath, additions, 'utf-8');
      console.log(chalk.green(`Added to .gitignore: ${missingPatterns.join(', ')}`));
      return true;
    }

    if (verbose) {
      console.log(chalk.gray('.gitignore already has required patterns'));
    }
    return false; // No changes needed
  } catch (error) {
    console.log(chalk.yellow(`Warning: Failed to ensure .gitignore: ${error}`));
    return false;
  }
}

/**
 * Detect if a git error is related to a pre-commit or commit-msg hook
 */
function isHookError(error: string): boolean {
  const hookIndicators = [
    'hook',
    'pre-commit',
    'commit-msg',
    'husky',
    'commitlint',
    'conventional commit',
    'commit message',
    'does not match'
  ];
  const lowerError = error.toLowerCase();
  return hookIndicators.some(indicator => lowerError.includes(indicator));
}

/**
 * Remove any 'nul' file that may have been created (Windows artifact).
 * These files can block git commits and are never needed.
 */
async function removeNulFile(workspace: string): Promise<void> {
  const nulPath = path.join(workspace, 'nul');
  try {
    await fs.unlink(nulPath);
  } catch {
    // File doesn't exist or couldn't be deleted - that's fine
  }
  // Also try to unstage it from git if it was added
  await execGit(['rm', '--cached', '--ignore-unmatch', 'nul'], workspace);
}

/**
 * Stage all changes and commit with the given message
 * Returns true if commit was made, false if nothing to commit or error
 */
export async function gitCommit(workspace: string, message: string, verbose: boolean = false): Promise<{ committed: boolean; error?: string; isHookFailure?: boolean }> {
  // Remove any 'nul' file (Windows artifact that blocks commits)
  await removeNulFile(workspace);

  // Stage all changes (including .devloop and .claude)
  const addResult = await execGit(['add', '-A'], workspace);
  if (!addResult.success) {
    console.log(chalk.yellow(`Git add failed: ${addResult.error}`));
    return { committed: false, error: addResult.error };
  }

  // Check if there are changes to commit
  const statusResult = await execGit(['status', '--porcelain'], workspace);
  if (!statusResult.success) {
    console.log(chalk.yellow(`Git status failed: ${statusResult.error}`));
    return { committed: false, error: statusResult.error };
  }

  // If nothing staged, nothing to commit
  if (!statusResult.output.trim()) {
    if (verbose) {
      console.log(chalk.gray('Git status shows no changes after staging'));
    }
    return { committed: false };
  }

  if (verbose) {
    console.log(chalk.gray(`Staged changes:\n${statusResult.output}`));
  }

  // Commit the changes
  const commitResult = await execGit(['commit', '-m', message], workspace);
  if (!commitResult.success) {
    const errorText = commitResult.error || '';
    const hookFailure = isHookError(errorText);

    if (hookFailure) {
      console.log(chalk.yellow(`\nGit commit failed due to a hook:`));
      console.log(chalk.gray(errorText));
      console.log(chalk.cyan(`\nThe commit message was: "${message}"`));
      console.log(chalk.yellow(`\nTo fix this, set a custom commit message format:`));
      console.log(chalk.white(`  devloop config set devloopCommitFormat "<your-format>"`));
      console.log(chalk.gray(`\nUse {action} placeholder for the action description.`));
      console.log(chalk.gray(`Example: "chore(devloop): {action}"`));
      return { committed: false, error: errorText, isHookFailure: true };
    }

    console.log(chalk.yellow(`Git commit failed: ${commitResult.error}`));
    return { committed: false, error: commitResult.error };
  }

  return { committed: true };
}

/**
 * Ensure the workspace has a git repository.
 * If git is available and no repo exists, initialize one and commit initial files.
 * Returns info about what was done.
 */
export async function ensureGitRepo(workspace: string, verbose: boolean = false): Promise<{
  gitAvailable: boolean;
  wasInitialized: boolean;
  initialCommit: boolean;
}> {
  const gitAvailable = await isGitAvailable();

  if (!gitAvailable) {
    if (verbose) {
      console.log(chalk.gray('Git not available - skipping version control'));
    }
    return { gitAvailable: false, wasInitialized: false, initialCommit: false };
  }

  const isRepo = await isGitRepo(workspace);

  if (isRepo) {
    if (verbose) {
      console.log(chalk.gray('Git repository already exists'));
    }
    // Ensure .gitignore exists even for existing repos
    await ensureGitignore(workspace, verbose);
    return { gitAvailable: true, wasInitialized: false, initialCommit: false };
  }

  // Initialize new repo
  if (verbose) {
    console.log(chalk.cyan('Initializing git repository...'));
  }

  const initSuccess = await initGitRepo(workspace);
  if (!initSuccess) {
    if (verbose) {
      console.log(chalk.yellow('Failed to initialize git repository'));
    }
    return { gitAvailable: true, wasInitialized: false, initialCommit: false };
  }

  // Ensure .gitignore exists before initial commit
  await ensureGitignore(workspace, verbose);

  // Make initial commit with all existing files
  const commitResult = await gitCommit(workspace, 'DevLoop: Initial commit', verbose);

  if (verbose) {
    if (commitResult.committed) {
      console.log(chalk.green('Git repository initialized with initial commit'));
    } else if (commitResult.error) {
      console.log(chalk.yellow(`Git init succeeded but initial commit failed: ${commitResult.error}`));
    } else {
      console.log(chalk.green('Git repository initialized (no files to commit)'));
    }
  }

  return {
    gitAvailable: true,
    wasInitialized: true,
    initialCommit: commitResult.committed
  };
}

/**
 * Check if there are uncommitted changes in the workspace
 * Returns the list of changed files if any
 */
export async function getUncommittedChanges(workspace: string, ignorePaths?: string[]): Promise<{ hasChanges: boolean; files: string[] }> {
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    return { hasChanges: false, files: [] };
  }

  const isRepo = await isGitRepo(workspace);
  if (!isRepo) {
    return { hasChanges: false, files: [] };
  }

  const statusResult = await execGit(['status', '--porcelain'], workspace);
  if (!statusResult.success || !statusResult.output.trim()) {
    return { hasChanges: false, files: [] };
  }

  // Parse the porcelain output to get file names
  let files = statusResult.output
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.substring(3).trim()); // Remove status prefix (e.g., " M ", "?? ")

  // Filter out ignored paths
  if (ignorePaths && ignorePaths.length > 0) {
    files = files.filter(file => {
      // Normalize path separators for cross-platform matching
      const normalizedFile = file.replace(/\\/g, '/');
      // Check if any ignored path appears anywhere in the file path
      return !ignorePaths.some(ignorePath => normalizedFile.includes(ignorePath));
    });
  }

  return { hasChanges: files.length > 0, files };
}

/**
 * Get a diff summary of uncommitted changes
 */
export async function getUncommittedDiff(workspace: string): Promise<string | null> {
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    return null;
  }

  const isRepo = await isGitRepo(workspace);
  if (!isRepo) {
    return null;
  }

  // Get diff of tracked files (staged and unstaged)
  const diffResult = await execGit(['diff', 'HEAD', '--stat'], workspace);
  if (!diffResult.success || !diffResult.output.trim()) {
    // Try just unstaged changes if HEAD doesn't exist yet
    const diffUnstagedResult = await execGit(['diff', '--stat'], workspace);
    if (diffUnstagedResult.success && diffUnstagedResult.output.trim()) {
      return diffUnstagedResult.output;
    }
    return null;
  }

  return diffResult.output;
}

/**
 * Commit uncommitted changes from a previous interrupted session
 * This preserves the partial work in git history before starting fresh
 */
export async function commitInterruptedWork(
  workspace: string,
  taskId?: string,
  taskTitle?: string,
  verbose: boolean = false
): Promise<boolean> {
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    return false;
  }

  const isRepo = await isGitRepo(workspace);
  if (!isRepo) {
    return false;
  }

  // Build action description
  let action: string;
  if (taskId && taskTitle) {
    action = `Interrupted work on ${taskId} - ${taskTitle}`;
  } else if (taskId) {
    action = `Interrupted work on ${taskId}`;
  } else {
    action = 'Interrupted work from previous session';
  }

  // Use devloopCommitFormat if configured
  const workspaceConfig = await readWorkspaceConfig(workspace);
  const message = formatDevloopCommit(workspaceConfig.devloopCommitFormat, action);

  const result = await gitCommit(workspace, message, verbose);

  if (verbose && result.committed) {
    console.log(chalk.gray(`  Git: Committed interrupted work`));
  } else if (result.error) {
    console.log(chalk.yellow(`  Git: Failed to commit interrupted work - ${result.error}`));
  }

  return result.committed;
}

/**
 * Commit changes after an iteration
 */
export async function commitIteration(
  workspace: string,
  iteration: number,
  taskId: string | null,
  taskTitle: string | null,
  success: boolean,
  verbose: boolean = false,
  featureName?: string
): Promise<{ committed: boolean; hookFailure?: boolean }> {
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    return { committed: false };
  }

  const isRepo = await isGitRepo(workspace);
  if (!isRepo) {
    return { committed: false };
  }

  // Load workspace config for commit format
  const workspaceConfig = await readWorkspaceConfig(workspace);

  // Build the action description
  const featurePrefix = featureName ? `[${featureName}] ` : '';
  const actionDescription = taskId && taskTitle
    ? `${featurePrefix}${success ? 'Complete' : 'Attempted'} ${taskId} - ${taskTitle}`
    : `${featurePrefix}Iteration ${iteration}`;

  // Use devloopCommitFormat if configured, otherwise default
  const message = formatDevloopCommit(workspaceConfig.devloopCommitFormat, actionDescription);

  const result = await gitCommit(workspace, message, verbose);

  if (verbose && result.committed) {
    console.log(chalk.gray(`  Git: Committed iteration ${iteration}`));
  } else if (result.isHookFailure) {
    // Hook failure message already printed by gitCommit
    return { committed: false, hookFailure: true };
  } else if (result.error) {
    console.log(chalk.yellow(`  Git: Commit failed - ${result.error}`));
  }

  return { committed: result.committed };
}
