import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import chalk from 'chalk';
import { resolveWorkspace, getRequirementsPath, resolveFeaturePath } from '../core/config.js';
import { createSession, readSession } from '../core/session.js';
import { createFeatureSession, readFeatureSession } from '../core/feature-session.js';
import { spawnClaudeInteractive } from '../core/claude.js';
import { requireClaudeInstalled } from './shared.js';
import { generateRequirementsTemplate } from '../parser/requirements.js';

function generateWorkspaceClaudeMd(workspace: string): string {
  const platform = os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'macOS' : 'Linux';

  return `# CLAUDE.md

This file provides guidance to Claude Code when working in this workspace.

## Environment

- **Platform**: ${platform}
- **Workspace**: ${workspace}
${platform === 'Windows' ? '- Use Windows-compatible commands (e.g., use backslashes in paths, no Unix-specific commands)\n' : ''}
## Current Task

You are helping the user create a **requirements.md** file for their project.

### Your Job

1. Ask the user what they want to build
2. Break down their project into small, manageable tasks (each ~30 minutes of work)
3. Write tasks to \`requirements.md\` in the format below
4. Ensure tasks have clear dependencies where needed

### Task Format

Each task in requirements.md MUST follow this exact format:

\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.

### TASK-002: Another task
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-001
- **Description**: This task depends on TASK-001 completing first.
\`\`\`

### Rules

- Task IDs must be sequential: TASK-001, TASK-002, TASK-003, etc.
- Status should always be \`pending\` for new tasks
- Priority: \`high\`, \`medium\`, or \`low\`
- Dependencies: \`none\` or comma-separated task IDs (e.g., \`TASK-001, TASK-002\`)
- Keep descriptions clear and actionable
- The requirements.md file already exists at: ${path.join(workspace, 'requirements.md')}
`;
}

interface InitOptions {
  workspace?: string;
  feature?: string;
  force?: boolean;
}

async function promptUser(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes' || answer === '');
    });
  });
}

function generateFeatureClaudeMd(workspace: string, featureName: string, requirementsPath: string): string {
  const platform = os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'macOS' : 'Linux';

  return `# CLAUDE.md

This file provides guidance to Claude Code when working in this workspace.

## Environment

- **Platform**: ${platform}
- **Workspace**: ${workspace}
- **Feature Mode**: ${featureName}
${platform === 'Windows' ? '- Use Windows-compatible commands (e.g., use backslashes in paths, no Unix-specific commands)\n' : ''}
## Current Task

You are helping the user create a **${requirementsPath}** file for the "${featureName}" feature.

### Your Job

1. Ask the user what they want to build for this feature
2. Break down the feature into small, manageable tasks (each ~30 minutes of work)
3. Write tasks to \`${requirementsPath}\` in the format below
4. Ensure tasks have clear dependencies where needed

### Task Format

Each task in ${requirementsPath} MUST follow this exact format:

\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.

### TASK-002: Another task
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-001
- **Description**: This task depends on TASK-001 completing first.
\`\`\`

### Rules

- Task IDs must be sequential: TASK-001, TASK-002, TASK-003, etc.
- Status should always be \`pending\` for new tasks
- Priority: \`high\`, \`medium\`, or \`low\`
- Dependencies: \`none\` or comma-separated task IDs (e.g., \`TASK-001, TASK-002\`)
- Keep descriptions clear and actionable
- The requirements file is at: ${requirementsPath}
`;
}

export async function initCommand(options: InitOptions): Promise<void> {
  await requireClaudeInstalled();

  const workspace = await resolveWorkspace(options.workspace);

  // Feature mode
  if (options.feature) {
    try {
      const { featureName, requirementsPath, progressPath } = resolveFeaturePath(workspace, options.feature);

      console.log(chalk.blue.bold('\n=== DevLoop Init (Feature Mode) ===\n'));

      // Show workflow guide
      console.log(chalk.white('Feature workflow:'));
      console.log(chalk.gray(`  1. devloop init --feature ${featureName}    - Create feature requirements (this step)`));
      console.log(chalk.gray(`  2. devloop status --feature ${featureName}  - View feature tasks`));
      console.log(chalk.gray(`  3. devloop run --feature ${featureName}     - Execute feature tasks`));
      console.log(chalk.gray(`  4. devloop feature list                     - List all features`));
      console.log();
      console.log(chalk.gray(`Workspace: ${workspace}`));
      console.log(chalk.gray(`Feature: ${featureName}`));

      // Check if feature file already exists
      let requirementsExists = false;
      let adoptExisting = false;
      try {
        await fs.access(requirementsPath);
        requirementsExists = true;
      } catch {
        // File doesn't exist
      }

      // Check if feature session already exists
      const existingSession = await readFeatureSession(workspace, featureName);

      if (requirementsExists) {
        if (existingSession && !options.force) {
          // Both requirements and session exist - already initialized
          console.log(chalk.yellow('\nFeature already initialized.'));
          console.log(chalk.gray(`Use "devloop continue --feature ${featureName}" to resume, or --force to reinitialize.`));
          return;
        } else if (!existingSession) {
          // Feature file exists but no session - adopt the existing file
          adoptExisting = true;
          console.log(chalk.cyan(`\nFound existing ${requirementsPath} - adopting it.`));
          console.log(chalk.gray('Setting up feature infrastructure...'));
        }
        // If --force is used, we'll overwrite below
      } else {
        // Feature file doesn't exist - prompt to create
        console.log(chalk.yellow(`\nFeature file doesn't exist: ${requirementsPath}`));
        const shouldCreate = await promptUser(chalk.cyan('Create it? (Y/n): '));

        if (!shouldCreate) {
          console.log(chalk.gray('Cancelled.'));
          return;
        }

        // Ensure requirements directory exists
        const requirementsDir = path.dirname(requirementsPath);
        await fs.mkdir(requirementsDir, { recursive: true });
      }

      // Create requirements template only if not adopting existing file
      if (!adoptExisting && !requirementsExists) {
        const template = generateRequirementsTemplate(featureName);
        await fs.writeFile(requirementsPath, template, 'utf-8');
        console.log(chalk.green(`Created: ${requirementsPath}`));
      } else if (adoptExisting) {
        console.log(chalk.green(`Using existing: ${requirementsPath}`));
      }

      // Create workspace CLAUDE.md to give Claude context about environment and task
      const claudeMdPath = path.join(workspace, 'CLAUDE.md');
      const claudeMdContent = generateFeatureClaudeMd(workspace, featureName, requirementsPath);
      await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');
      console.log(chalk.green(`Created: ${claudeMdPath}`));

      // Create feature session for init phase
      await createFeatureSession(workspace, featureName, 'init');

      console.log(chalk.cyan('\nStarting interactive Claude session...'));
      if (adoptExisting) {
        console.log(chalk.gray('Claude can help you review and refine your existing requirements.'));
        console.log(chalk.gray('Or exit with Ctrl+C or /exit if your requirements are ready.'));
      } else {
        console.log(chalk.gray('Describe your feature and Claude will help break it into tasks.'));
        console.log(chalk.gray('Each task should be small (~30 mins of work).'));
      }
      console.log(chalk.gray('Exit with Ctrl+C or /exit when done.\n'));

      // Show the task format Claude should use
      console.log(chalk.yellow('Task format for feature requirements:'));
      console.log(chalk.gray('  ### TASK-001: Task title'));
      console.log(chalk.gray('  - **Status**: pending'));
      console.log(chalk.gray('  - **Priority**: high/medium/low'));
      console.log(chalk.gray('  - **Dependencies**: none (or TASK-XXX)'));
      console.log(chalk.gray('  - **Description**: What needs to be done'));
      console.log();

      // Spawn interactive Claude (no initial prompt - let user drive)
      const child = spawnClaudeInteractive(workspace, null);

      // Handle process exit
      child.on('close', (code) => {
        console.log(chalk.blue('\n\nSession ended.'));
        if (code === 0) {
          console.log(chalk.green('Feature requirements ready at:'), requirementsPath);
          console.log(chalk.gray(`Run "devloop status --feature ${featureName}" to see your tasks.`));
          console.log(chalk.gray(`Run "devloop run --feature ${featureName}" to start executing tasks.`));
        }
      });

      return;
    } catch (error) {
      if (error instanceof Error) {
        console.log(chalk.red(error.message));
      } else {
        console.log(chalk.red(`Error: ${error}`));
      }
      process.exit(1);
    }
  }

  // Legacy mode (unchanged)
  const requirementsPath = getRequirementsPath(workspace);

  console.log(chalk.blue.bold('\n=== DevLoop Init ===\n'));

  // Show workflow guide
  console.log(chalk.white('Typical workflow:'));
  console.log(chalk.gray('  1. devloop init          - Create requirements.md (this step)'));
  console.log(chalk.gray('  2. devloop status        - View tasks and progress'));
  console.log(chalk.gray('  3. devloop run -n 10     - Execute tasks in a loop'));
  console.log(chalk.gray('  4. devloop continue      - Resume requirements or run later'));
  console.log();
  console.log(chalk.gray(`Workspace: ${workspace}`));

  // Check if requirements.md already exists
  let requirementsExists = false;
  let adoptExisting = false;
  try {
    await fs.access(requirementsPath);
    requirementsExists = true;
  } catch {
    // File doesn't exist
  }

  // Check if session already exists
  const existingSession = await readSession(workspace);

  if (requirementsExists) {
    if (existingSession && !options.force) {
      // Both requirements and session exist - already initialized
      console.log(chalk.yellow('\nWorkspace already initialized.'));
      console.log(chalk.gray('Use "devloop continue" to resume, or --force to reinitialize.'));
      return;
    } else if (!existingSession) {
      // requirements.md exists but no session - adopt the existing file
      adoptExisting = true;
      console.log(chalk.cyan('\nFound existing requirements.md - adopting it.'));
      console.log(chalk.gray('Setting up DevLoop infrastructure...'));
    }
    // If --force is used, we'll overwrite below
  }

  // Create requirements template only if not adopting existing file
  if (!adoptExisting) {
    const template = generateRequirementsTemplate('My Project');
    await fs.writeFile(requirementsPath, template, 'utf-8');
    console.log(chalk.green(`Created: ${requirementsPath}`));
  } else {
    console.log(chalk.green(`Using existing: ${requirementsPath}`));
  }

  // Create workspace CLAUDE.md to give Claude context about environment and task
  const claudeMdPath = path.join(workspace, 'CLAUDE.md');
  const claudeMdContent = generateWorkspaceClaudeMd(workspace);
  await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');
  console.log(chalk.green(`Created: ${claudeMdPath}`));

  // Create session for init phase
  await createSession(workspace, 'init');

  console.log(chalk.cyan('\nStarting interactive Claude session...'));
  if (adoptExisting) {
    console.log(chalk.gray('Claude can help you review and refine your existing requirements.'));
    console.log(chalk.gray('Or exit with Ctrl+C or /exit if your requirements are ready.'));
  } else {
    console.log(chalk.gray('Describe your project and Claude will help break it into tasks.'));
    console.log(chalk.gray('Each task should be small (~30 mins of work).'));
  }
  console.log(chalk.gray('Exit with Ctrl+C or /exit when done.\n'));

  // Show the task format Claude should use
  console.log(chalk.yellow('Task format for requirements.md:'));
  console.log(chalk.gray('  ### TASK-001: Task title'));
  console.log(chalk.gray('  - **Status**: pending'));
  console.log(chalk.gray('  - **Priority**: high/medium/low'));
  console.log(chalk.gray('  - **Dependencies**: none (or TASK-XXX)'));
  console.log(chalk.gray('  - **Description**: What needs to be done'));
  console.log();

  // Spawn interactive Claude (no initial prompt - let user drive)
  const child = spawnClaudeInteractive(workspace, null);

  // Handle process exit
  child.on('close', (code) => {
    console.log(chalk.blue('\n\nSession ended.'));
    if (code === 0) {
      console.log(chalk.green('Requirements file is ready at:'), requirementsPath);
      console.log(chalk.gray('Run "devloop status" to see your tasks.'));
      console.log(chalk.gray('Run "devloop run" to start executing tasks.'));
    }
  });
}
