import * as fs from 'fs/promises';
import * as path from 'path';

export interface CommitFormatDetection {
  detected: boolean;
  format?: string;
  formatFailed?: string;
  source?: string;
}

export interface CommitVariables {
  feature?: string;
  iteration: number;
  status: 'Complete' | 'Attempted';
  taskId: string;
  title: string;
}

/**
 * Detects commit message format from git hooks and config files
 */
export async function detectCommitFormat(workspace: string): Promise<CommitFormatDetection> {
  // Check commitlint config
  const commitlintFormat = await checkCommitlint(workspace);
  if (commitlintFormat) {
    return {
      detected: true,
      format: commitlintFormat.format,
      formatFailed: commitlintFormat.formatFailed,
      source: 'commitlint'
    };
  }

  // Check git hooks
  const gitHookFormat = await checkGitHooks(workspace);
  if (gitHookFormat) {
    return {
      detected: true,
      format: gitHookFormat.format,
      formatFailed: gitHookFormat.formatFailed,
      source: 'git hook'
    };
  }

  // Check husky
  const huskyFormat = await checkHusky(workspace);
  if (huskyFormat) {
    return {
      detected: true,
      format: huskyFormat.format,
      formatFailed: huskyFormat.formatFailed,
      source: 'husky'
    };
  }

  return { detected: false };
}

/**
 * Applies commit message template with variable substitution
 */
export function formatCommitMessage(template: string, variables: CommitVariables): string {
  return template
    .replace(/\{feature\}/g, variables.feature || '')
    .replace(/\{iteration\}/g, String(variables.iteration))
    .replace(/\{status\}/g, variables.status)
    .replace(/\{taskId\}/g, variables.taskId)
    .replace(/\{title\}/g, variables.title)
    .trim();
}

/**
 * Check commitlint configuration files
 */
async function checkCommitlint(workspace: string): Promise<{ format: string; formatFailed: string } | null> {
  const configFiles = [
    '.commitlintrc',
    '.commitlintrc.json',
    '.commitlintrc.js',
    'commitlint.config.js'
  ];

  for (const configFile of configFiles) {
    const configPath = path.join(workspace, configFile);

    try {
      await fs.access(configPath);

      // If commitlint config exists, assume conventional commits
      // Suggest format based on conventional commits pattern
      return {
        format: 'feat({feature}): {title}',
        formatFailed: 'wip({feature}): {title}'
      };
    } catch {
      // File doesn't exist, try next
    }
  }

  return null;
}

/**
 * Check git hooks for commit message patterns
 */
async function checkGitHooks(workspace: string): Promise<{ format: string; formatFailed: string } | null> {
  const hookPaths = [
    path.join(workspace, '.git', 'hooks', 'commit-msg'),
    path.join(workspace, '.git', 'hooks', 'pre-commit')
  ];

  for (const hookPath of hookPaths) {
    try {
      const content = await fs.readFile(hookPath, 'utf-8');

      // Check for conventional commits pattern
      if (/\^?\(feat\|fix\|docs\|chore\)/i.test(content)) {
        return {
          format: 'feat({feature}): {title}',
          formatFailed: 'wip({feature}): {title}'
        };
      }

      // Check for Jira-style pattern
      if (/\[A-Z\]\+-\\d\+/i.test(content) || /\^?\[A-Z\]\+-\\d\+/i.test(content)) {
        return {
          format: '[{taskId}] {status} - {title}',
          formatFailed: '[{taskId}] {status} - {title}'
        };
      }
    } catch {
      // File doesn't exist or can't be read, try next
    }
  }

  return null;
}

/**
 * Check husky configuration
 */
async function checkHusky(workspace: string): Promise<{ format: string; formatFailed: string } | null> {
  // Check .husky/commit-msg
  const huskyHookPath = path.join(workspace, '.husky', 'commit-msg');

  try {
    const content = await fs.readFile(huskyHookPath, 'utf-8');

    // If it mentions commitlint, use conventional commits
    if (/commitlint/.test(content)) {
      return {
        format: 'feat({feature}): {title}',
        formatFailed: 'wip({feature}): {title}'
      };
    }
  } catch {
    // File doesn't exist
  }

  // Check package.json for husky config
  try {
    const packageJsonPath = path.join(workspace, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

    if (packageJson.husky?.hooks?.['commit-msg']) {
      const hook = packageJson.husky.hooks['commit-msg'];

      if (/commitlint/.test(hook)) {
        return {
          format: 'feat({feature}): {title}',
          formatFailed: 'wip({feature}): {title}'
        };
      }
    }
  } catch {
    // File doesn't exist or invalid JSON
  }

  return null;
}
