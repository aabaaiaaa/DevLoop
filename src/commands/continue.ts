import * as readline from 'readline';
import chalk from 'chalk';
import { resolveWorkspace, getRequirementsPath, resolveFeaturePath, getFeatureRequirementsPath } from '../core/config.js';
import { readSession, updateSessionPhase } from '../core/session.js';
import { readFeatureSession } from '../core/feature-session.js';
import { spawnClaudeInteractive } from '../core/claude.js';
import { requireClaudeInstalled, buildRunConfig } from './shared.js';
import { runLoop } from '../core/loop.js';

interface ContinueOptions {
  workspace?: string;
  feature?: string;
  maxIterations?: string;
  tokenLimit?: string;
  verbose?: boolean;
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function continueCommand(options: ContinueOptions): Promise<void> {
  await requireClaudeInstalled();

  const workspace = await resolveWorkspace(options.workspace);

  // Feature mode
  if (options.feature) {
    try {
      const { featureName, requirementsPath, progressPath } = resolveFeaturePath(workspace, options.feature);
      const session = await readFeatureSession(workspace, featureName);

      console.log(chalk.blue.bold('\n=== DevLoop Continue (Feature Mode) ===\n'));
      console.log(chalk.gray(`Workspace: ${workspace}`));
      console.log(chalk.gray(`Feature: ${featureName}`));

      if (!session) {
        console.log(chalk.yellow('\nNo existing session found for this feature.'));
        console.log(chalk.gray(`Run "devloop init --feature ${featureName}" to start.`));
        return;
      }

      console.log(chalk.gray(`Current phase: ${session.phase}`));
      console.log(chalk.gray(`Started: ${session.startedAt}`));

      if (session.phase === 'run') {
        console.log(chalk.gray(`Last iteration: ${session.lastIteration}`));
      }

      console.log();

      console.log(chalk.cyan('What would you like to do?'));
      console.log(chalk.white('  1. Continue working on requirements'));
      console.log(chalk.white('  2. Continue running tasks'));
      console.log(chalk.white('  3. Cancel'));
      console.log();

      const choice = await promptUser('Enter choice (1/2/3): ');

      switch (choice) {
        case '1':
          await continueFeatureRequirements(workspace, featureName, requirementsPath, session.sessionId);
          break;
        case '2':
          await continueFeatureRun(workspace, featureName, requirementsPath, progressPath, options);
          break;
        case '3':
          console.log(chalk.gray('Cancelled.'));
          break;
        default:
          console.log(chalk.red('Invalid choice.'));
      }

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

  // Legacy mode
  const session = await readSession(workspace);

  console.log(chalk.blue.bold('\n=== DevLoop Continue ===\n'));
  console.log(chalk.gray(`Workspace: ${workspace}`));

  if (!session) {
    console.log(chalk.yellow('\nNo existing session found.'));
    console.log(chalk.gray('Run "devloop init" to start a new project.'));
    return;
  }

  console.log(chalk.gray(`Current phase: ${session.phase}`));
  console.log(chalk.gray(`Started: ${session.startedAt}`));

  if (session.phase === 'run') {
    console.log(chalk.gray(`Last iteration: ${session.lastIteration}`));
  }

  console.log();

  // Ask user what they want to do
  console.log(chalk.cyan('What would you like to do?'));
  console.log(chalk.white('  1. Continue working on requirements'));
  console.log(chalk.white('  2. Continue running tasks'));
  console.log(chalk.white('  3. Cancel'));
  console.log();

  const choice = await promptUser('Enter choice (1/2/3): ');

  switch (choice) {
    case '1':
      await continueRequirements(workspace, session.sessionId);
      break;
    case '2':
      await continueRun(workspace, options);
      break;
    case '3':
      console.log(chalk.gray('Cancelled.'));
      break;
    default:
      console.log(chalk.red('Invalid choice.'));
  }
}

async function continueRequirements(workspace: string, sessionId: string | null): Promise<void> {
  await updateSessionPhase(workspace, 'init');

  console.log(chalk.cyan('\nResuming requirements session...'));
  console.log(chalk.gray('Continue refining your requirements.md with Claude.'));
  console.log(chalk.gray('Exit with Ctrl+C or /exit when done.\n'));

  const child = spawnClaudeInteractive(workspace, sessionId);

  child.on('close', (code) => {
    console.log(chalk.blue('\n\nSession ended.'));
    if (code === 0) {
      const requirementsPath = getRequirementsPath(workspace);
      console.log(chalk.green('Requirements file is at:'), requirementsPath);
      console.log(chalk.gray('Run "devloop status" to see your tasks.'));
      console.log(chalk.gray('Run "devloop run" to start executing tasks.'));
    }
  });
}

async function continueRun(workspace: string, options: ContinueOptions): Promise<void> {
  await updateSessionPhase(workspace, 'run');

  const config = buildRunConfig({
    workspace,
    maxIterations: options.maxIterations,
    tokenLimit: options.tokenLimit,
    verbose: options.verbose,
    dryRun: false
  });

  await runLoop(config);
}

async function continueFeatureRequirements(workspace: string, featureName: string, requirementsPath: string, sessionId: string | null): Promise<void> {
  console.log(chalk.cyan('\nResuming feature requirements session...'));
  console.log(chalk.gray(`Continue refining your ${requirementsPath} with Claude.`));
  console.log(chalk.gray('Exit with Ctrl+C or /exit when done.\n'));

  const child = spawnClaudeInteractive(workspace, sessionId);

  child.on('close', (code) => {
    console.log(chalk.blue('\n\nSession ended.'));
    if (code === 0) {
      console.log(chalk.green('Feature requirements file is at:'), requirementsPath);
      console.log(chalk.gray(`Run "devloop status --feature ${featureName}" to see your tasks.`));
      console.log(chalk.gray(`Run "devloop run --feature ${featureName}" to start executing tasks.`));
    }
  });
}

async function continueFeatureRun(workspace: string, featureName: string, requirementsPath: string, progressPath: string, options: ContinueOptions): Promise<void> {
  const config = buildRunConfig({
    workspace,
    requirementsPath,
    progressPath,
    maxIterations: options.maxIterations,
    tokenLimit: options.tokenLimit,
    verbose: options.verbose,
    dryRun: false,
    featureName
  });

  await runLoop(config);
}
