import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';
import { resolveWorkspace, getRequirementsPath, getTasksPath, readWorkspaceConfig } from '../core/config.js';
import { readSession, createSession, updateSessionPhase } from '../core/session.js';
import { Session } from '../types/index.js';
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
  taskTimeout?: string;
  verifyEachTask?: boolean;
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

// --- Workspace state detection ---

interface WorkspaceState {
  phase: 'init' | 'run';
  hasRequirements: boolean;
  hasTasks: boolean;
  hasReview: boolean;
  taskCounts: { total: number; pending: number; inProgress: number; done: number };
  allTasksDone: boolean;
}

async function detectWorkspaceState(workspace: string, session: Session): Promise<WorkspaceState> {
  const requirementsPath = getRequirementsPath(workspace);
  const reviewPath = path.join(workspace, '.devloop', 'review.md');

  let hasRequirements = false;
  let hasTasks = false;
  let hasReview = false;
  let taskCounts = { total: 0, pending: 0, inProgress: 0, done: 0 };

  try { await fs.access(requirementsPath); hasRequirements = true; } catch {}
  try { await fs.access(reviewPath); hasReview = true; } catch {}

  try {
    const tasksPath = getTasksPath(workspace);
    const taskList = await parseTasks(tasksPath);
    hasTasks = taskList.tasks.length > 0;
    taskCounts = {
      total: taskList.tasks.length,
      pending: taskList.tasks.filter(t => t.status === 'pending').length,
      inProgress: taskList.tasks.filter(t => t.status === 'in-progress').length,
      done: taskList.tasks.filter(t => t.status === 'done').length,
    };
  } catch {}

  return {
    phase: session.phase,
    hasRequirements,
    hasTasks,
    hasReview,
    taskCounts,
    allTasksDone: hasTasks && taskCounts.done === taskCounts.total,
  };
}

// --- Dynamic menu ---

interface MenuItem {
  key: string;
  label: string;
  action: string;
}

function buildMenuOptions(state: WorkspaceState): MenuItem[] {
  const items: MenuItem[] = [];
  let key = 1;

  if (state.allTasksDone) {
    // All tasks completed — show completion-oriented options
    if (state.hasReview) {
      items.push({ key: String(key++), label: 'View the review', action: 'view-review' });
    }
    items.push({ key: String(key++), label: 'Archive and start next phase', action: 'archive-describe' });
    if (state.hasReview) {
      items.push({ key: String(key++), label: 'Archive and start next phase (informed by review)', action: 'archive-review' });
    }
  } else {
    // Not all done — show work-continuation options
    if (state.phase === 'init' || !state.hasTasks) {
      items.push({ key: String(key++), label: 'Continue working on requirements', action: 'continue-requirements' });
    }
    if (state.hasTasks && !state.allTasksDone) {
      const { done, total } = state.taskCounts;
      items.push({ key: String(key++), label: `Continue running tasks (${done}/${total} done)`, action: 'continue-run' });
    }
    items.push({ key: String(key++), label: 'Archive and start new requirements', action: 'archive-describe' });
  }

  items.push({ key: String(key++), label: 'Cancel', action: 'cancel' });
  return items;
}

// --- Command entry point ---

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

  // Detect workspace state and show summary
  const state = await detectWorkspaceState(workspace, session);

  if (state.hasTasks) {
    const { done, total, inProgress, pending } = state.taskCounts;
    if (state.allTasksDone) {
      console.log(chalk.green(`\nAll ${total} tasks completed.`));
      if (state.hasReview) {
        console.log(chalk.gray('Review document available.'));
      }
    } else {
      console.log(chalk.gray(`\nTasks: ${done}/${total} done, ${inProgress} in progress, ${pending} pending`));
    }
  } else if (state.phase === 'init') {
    console.log(chalk.gray('\nNo tasks yet (still in requirements phase).'));
  }

  console.log();

  // Build and display contextual menu
  const menuItems = buildMenuOptions(state);

  console.log(chalk.cyan('What would you like to do?'));
  for (const item of menuItems) {
    console.log(chalk.white(`  ${item.key}. ${item.label}`));
  }
  console.log();

  const validKeys = menuItems.map(m => m.key).join('/');
  const choice = await promptChoice(`Enter choice (${validKeys}): `);

  const selected = menuItems.find(m => m.key === choice);
  if (!selected) {
    console.log(chalk.red('Invalid choice.'));
    return;
  }

  switch (selected.action) {
    case 'continue-requirements':
      await continueRequirements(workspace, session.sessionId);
      break;
    case 'continue-run':
      await continueRun(workspace, options);
      break;
    case 'archive-describe':
      await startNextIteration(workspace, currentIteration);
      break;
    case 'archive-review':
      await startNextIterationFromReview(workspace, currentIteration);
      break;
    case 'view-review':
      await viewReview(workspace);
      break;
    case 'cancel':
      console.log(chalk.gray('Cancelled.'));
      break;
  }
}

// --- Action handlers ---

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
  // CLI flag takes precedence, fall back to workspace config
  let verifyEachTask = options.verifyEachTask;
  if (verifyEachTask === undefined) {
    const wsConfig = await readWorkspaceConfig(workspace);
    verifyEachTask = wsConfig.verifyEachTask;
  }

  const config = buildRunConfig({
    workspace,
    maxIterations: options.maxIterations,
    tokenLimit: options.tokenLimit,
    costLimit: options.costLimit,
    taskTimeout: options.taskTimeout,
    verifyEachTask,
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

async function viewReview(workspace: string): Promise<void> {
  const reviewPath = path.join(workspace, '.devloop', 'review.md');
  try {
    const content = await fs.readFile(reviewPath, 'utf-8');
    console.log(chalk.cyan('\n--- Review ---\n'));
    console.log(content);
    console.log(chalk.cyan('\n--- End Review ---\n'));
  } catch {
    console.log(chalk.red('review.md not found.'));
  }
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
    // Can't parse tasks, proceed anyway
  }

  await archiveAndSpawnNextIteration(workspace, currentIteration, false);
}

async function startNextIterationFromReview(workspace: string, currentIteration: number): Promise<void> {
  await archiveAndSpawnNextIteration(workspace, currentIteration, true);
}

async function archiveAndSpawnNextIteration(
  workspace: string,
  currentIteration: number,
  includeReview: boolean
): Promise<void> {
  console.log(chalk.cyan(`\nArchiving iteration ${currentIteration}...`));

  // 1. Archive current iteration
  await archiveIteration(workspace, currentIteration);
  console.log(chalk.green(`  Archived to .devloop/archive/iteration-${currentIteration}/`));

  // 2. Load prior context for CLAUDE.md (now includes review from archive)
  const priorContext = await loadPriorContext(workspace, currentIteration);

  // 3. Generate context-aware CLAUDE.md
  const claudeDir = path.join(workspace, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const claudeMdContent = generateWorkspaceClaudeMd(workspace, {
    iterationNumber: currentIteration,
    requirements: priorContext.requirements,
    tasks: priorContext.tasks,
    progress: priorContext.progress,
    review: includeReview ? priorContext.review : undefined,
  });
  await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');
  const reviewNote = includeReview && priorContext.review ? ' and review' : '';
  console.log(chalk.green(`  Updated CLAUDE.md with prior work context${reviewNote}`));

  // 4. Create new session with incremented iteration
  const newIteration = currentIteration + 1;
  await createSession(workspace, 'init', newIteration);

  // 5. Detect and configure commit format
  const initAction = `Start iteration ${newIteration}`;
  const commitConfig = await detectAndConfigureCommitFormat(workspace, initAction);

  console.log(chalk.cyan(`\nStarting iteration ${newIteration}...`));
  console.log(chalk.yellow.bold('\n--- Tips ---'));
  if (includeReview && priorContext.review) {
    console.log(chalk.yellow('  Claude has context from your previous iteration and the review document.'));
    console.log(chalk.yellow('  It will use the review recommendations to inform the next phase of work.'));
  } else {
    console.log(chalk.yellow('  Claude has context from your previous iteration — describe what to build next.'));
  }
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
