import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';
import { resolveWorkspace, getRequirementsPath, getTasksPath } from '../core/config.js';
import { readSession, createSession, updateSessionPhase } from '../core/session.js';
import { spawnClaudeInteractive } from '../core/claude.js';
import { requireClaudeInstalled, buildRunConfig, promptUser as promptYesNo, printBanner } from './shared.js';
import { runLoop } from '../core/loop.js';
import { parseTasks } from '../parser/tasks.js';
import { archiveIteration, loadPriorContext } from '../core/archive.js';
import { generateWorkspaceClaudeMd, commitWithRetry, detectAndConfigureCommitFormat } from './init.js';
import { ensureGitRepo } from '../core/git.js';

interface ContinueOptions {
  workspace?: string;
  maxIterations?: string;
  tokenLimit?: string;
  costLimit?: string;
  verbose?: boolean;
}

async function promptChoice(question: string): Promise<string> {
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
  const session = await readSession(workspace);

  const currentIteration = session?.iteration || 1;

  printBanner(`Continue (Iteration ${currentIteration})`);
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
  console.log(chalk.white('  3. Archive and start new requirements'));
  console.log(chalk.white('  4. Cancel'));
  console.log();

  const choice = await promptChoice('Enter choice (1/2/3/4): ');

  switch (choice) {
    case '1':
      await continueRequirements(workspace, session.sessionId);
      break;
    case '2':
      await continueRun(workspace, options);
      break;
    case '3':
      await startNextIteration(workspace, currentIteration);
      break;
    case '4':
      console.log(chalk.gray('Cancelled.'));
      break;
    default:
      console.log(chalk.red('Invalid choice.'));
  }
}

async function continueRequirements(workspace: string, sessionId: string | null): Promise<void> {
  await updateSessionPhase(workspace, 'init');

  console.log(chalk.cyan('\nResuming requirements session...'));
  console.log(chalk.gray('Continue refining your requirements with Claude.'));
  console.log(chalk.gray('Exit with Ctrl+C or /exit when done.\n'));

  const child = spawnClaudeInteractive(workspace, sessionId);

  child.on('error', (err) => {
    console.log(chalk.red(`\nFailed to start Claude: ${err.message}`));
  });

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
  const config = buildRunConfig({
    workspace,
    maxIterations: options.maxIterations,
    tokenLimit: options.tokenLimit,
    costLimit: options.costLimit,
    verbose: options.verbose,
    dryRun: false,
    sessionAction: 'update'
  });

  if (isNaN(config.maxIterations) || config.maxIterations < 1) {
    console.log(chalk.red('Error: max-iterations must be a positive number'));
    process.exit(1);
  }

  await runLoop(config);
}

async function startNextIteration(workspace: string, currentIteration: number): Promise<void> {
  // Warn if tasks are still incomplete
  const tasksPath = getTasksPath(workspace);
  try {
    const taskList = await parseTasks(tasksPath);
    const pending = taskList.tasks.filter(t => t.status === 'pending');
    const inProgress = taskList.tasks.filter(t => t.status === 'in-progress');
    const incomplete = pending.length + inProgress.length;

    if (incomplete > 0) {
      console.log(chalk.yellow(`\nWarning: ${incomplete} task(s) are still incomplete.`));
      console.log(chalk.gray('Archiving will move current requirements to archive and start fresh.'));
      const shouldContinue = await promptYesNo(chalk.cyan('Continue? (y/N): '), false);
      if (!shouldContinue) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }
    }
  } catch {
    // Can't parse requirements, proceed anyway
  }

  console.log(chalk.cyan(`\nArchiving iteration ${currentIteration}...`));

  // 1. Archive current iteration
  await archiveIteration(workspace, currentIteration);
  console.log(chalk.green(`  Archived to .devloop/archive/iteration-${currentIteration}/`));

  // 2. Load prior context for CLAUDE.md
  const priorContext = await loadPriorContext(workspace, currentIteration);

  // 3. Generate context-aware CLAUDE.md
  const claudeDir = path.join(workspace, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const claudeMdContent = generateWorkspaceClaudeMd(workspace, {
    iterationNumber: currentIteration,
    requirements: priorContext.requirements,
    tasks: priorContext.tasks,
    progress: priorContext.progress
  });
  await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');
  console.log(chalk.green(`  Updated CLAUDE.md with prior work context`));

  // 4. Create new session with incremented iteration
  const newIteration = currentIteration + 1;
  await createSession(workspace, 'init', newIteration);

  // 5. Detect and configure commit format
  const initAction = `Start iteration ${newIteration}`;
  const commitConfig = await detectAndConfigureCommitFormat(workspace, initAction);

  console.log(chalk.cyan(`\nStarting iteration ${newIteration}...`));
  console.log(chalk.yellow.bold('\n--- Tips ---'));
  console.log(chalk.yellow('  Claude has context from your previous iteration — describe what to build next.'));
  console.log(chalk.yellow('  When the new requirements and tasks are ready, exit with Ctrl+C or /exit.'));
  console.log(chalk.yellow('------------\n'));

  // 6. Spawn interactive Claude for new requirements
  const child = spawnClaudeInteractive(workspace, null);

  child.on('error', (err) => {
    console.log(chalk.red(`\nFailed to start Claude: ${err.message}`));
  });

  child.on('close', async (code) => {
    try {
      console.log(chalk.blue('\n\nSession ended.'));
      if (code === 0) {
        await ensureGitRepo(workspace);
        await commitWithRetry(workspace, commitConfig.message, commitConfig.action);

        console.log(chalk.green(`\nIteration ${newIteration} requirements ready.`));
        console.log(chalk.gray('Run "devloop status" to see your tasks.'));
        console.log(chalk.gray('Run "devloop run" to start executing tasks.'));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`\nError during post-session setup: ${msg}`));
    }
  });
}
