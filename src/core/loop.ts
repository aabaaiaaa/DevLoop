import chalk from 'chalk';
import { createSpinner, Spinner } from './spinner.js';
import { spawn as spawnProcess } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { DevLoopConfig, IterationLog, ActiveTask, Task, Progress, ClaudeErrorType } from '../types/index.js';
import { parseTasks, getNextTask, updateTaskStatus } from '../parser/tasks.js';
import { readProgress, appendIteration, getCompletedTaskIds } from '../parser/progress.js';
import { invokeClaudeAutomated, buildTaskPrompt, isApiError } from './claude.js';
import { createSession, readSession, writeSession, updateSessionPhase, updateSessionIteration } from './session.js';
import { commitIteration, commitInterruptedWork, ensureGitRepo, getUncommittedChanges } from './git.js';
import { createLogger, Logger } from './logger.js';
import { promptUser, printBanner } from '../commands/shared.js';
import * as fs from 'fs/promises';

// Graceful shutdown state
let stopRequested = false;
let rawModeActive = false;
let activeSpinner: Spinner | null = null;

// Terminal title management
let originalTitle: string | null = null;

function setTerminalTitle(title: string): void {
  // Save original title on first call
  if (originalTitle === null) {
    originalTitle = 'Terminal'; // Default fallback
  }
  // ANSI escape sequence to set terminal title (works on most terminals)
  process.stdout.write(`\x1b]0;${title}\x07`);
}

function restoreTerminalTitle(): void {
  if (originalTitle !== null) {
    process.stdout.write(`\x1b]0;${originalTitle}\x07`);
  }
}

// Format a duration in seconds to human-readable h/m/s
function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

// Elapsed time tracker for spinner
function formatElapsed(startTime: number): string {
  return formatDuration(Math.floor((Date.now() - startTime) / 1000));
}

/**
 * Write Claude's raw output to a per-task log file in .devloop/logs/.
 * Each file is named TASK-XXX.log (overwritten on retry so only the latest attempt is kept).
 */
async function writeTaskLog(
  workspacePath: string,
  taskId: string,
  taskTitle: string,
  iteration: number,
  prompt: string,
  result: { success: boolean; output: string; rawOutput: string; error?: string; duration: number },
  loggerRef: Logger
): Promise<void> {
  try {
    const logsDir = path.join(workspacePath, '.devloop', 'logs');
    await fs.mkdir(logsDir, { recursive: true });

    const logPath = path.join(logsDir, `${taskId}.log`);
    const header = [
      `Task: ${taskId} - ${taskTitle}`,
      `Iteration: ${iteration}`,
      `Timestamp: ${new Date().toISOString()}`,
      `Duration: ${formatDuration(Math.round(result.duration / 1000))}`,
      `Result: ${result.success ? 'success' : 'failure'}`,
      result.error ? `Error: ${result.error}` : null,
      '='.repeat(80),
      '',
      '--- PROMPT ---',
      prompt,
      '',
      '--- CLAUDE RAW OUTPUT ---',
      result.rawOutput,
      '',
      '--- CLAUDE RESULT ---',
      result.output || '(no result text)',
    ].filter(line => line !== null).join('\n');

    await fs.writeFile(logPath, header, 'utf-8');
  } catch (err) {
    loggerRef.error(`Failed to write task log for ${taskId}`, err);
  }
}

/**
 * Open a file with the platform's default application.
 * Fire-and-forget — does not wait for the application to close.
 */
function openFile(filePath: string): void {
  try {
    if (process.platform === 'win32') {
      spawnProcess('cmd', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawnProcess('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawnProcess('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Silently fail — the file path is printed to console as fallback
  }
}

/**
 * Run a final code review after all tasks complete.
 * Claude reviews the project against requirements and writes a report.
 */
async function runFinalReview(
  config: DevLoopConfig,
  invoke: typeof invokeClaudeAutomated,
  loggerRef: Logger,
  skipGit?: boolean,
  skipOpen?: boolean
): Promise<void> {
  const reviewPath = path.join(config.workspacePath, '.devloop', 'review.md');

  console.log(chalk.cyan('\nRunning final code review...'));
  const spinner = createSpinner();
  const startTime = Date.now();
  spinner.start(chalk.cyan('  Claude reviewing project...'));

  const prompt = `You are performing a final code review of this project.

WORKSPACE: ${config.workspacePath}

1. Read the requirements document at: ${config.requirementsPath}
2. Read the task list at: ${config.tasksPath}
3. Review all source code in the workspace

Write a comprehensive review report in markdown format covering:

## Requirements vs Implementation
- Are all requirements met? Flag any gaps or partial implementations.
- Are there features in the code that aren't in the requirements (scope creep)?

## Code Quality
- Are there any bugs, logic errors, or edge cases not handled?
- Is error handling adequate?
- Are there any security concerns?

## Testing
- Is test coverage adequate for the requirements?
- Are there untested edge cases?

## Recommendations
- What should be improved or addressed before this is production-ready?

## Future Considerations
- What features or improvements could be added next?
- Are there architectural decisions that should be revisited as the project grows?
- What technical debt was introduced that should be addressed?

Write the report directly to: ${reviewPath}
Do NOT modify any source code or project files. This is a read-only review.
The ONLY file you should create or write to is the review report at the path above.`;

  try {
    const result = await invoke(prompt, config.workspacePath, {
      verbose: config.verbose
    });

    spinner.stop();

    if (result.success) {
      // Check if the review file was actually written by Claude
      try {
        await fs.access(reviewPath);
      } catch {
        // Claude didn't write the file — write the output as the review
        if (result.output) {
          await fs.writeFile(reviewPath, result.output, 'utf-8');
        }
      }

      console.log(chalk.green(`  Review complete (${formatDuration(Math.round(result.duration / 1000))})`));
      console.log(chalk.gray(`  Report: ${reviewPath}`));

      // Commit the review file
      if (!skipGit) {
        await commitIteration(config.workspacePath, 0, 'REVIEW', 'Final code review', true, config.verbose);
      }

      // Open the review file for the developer
      if (!skipOpen) openFile(reviewPath);
    } else {
      console.log(chalk.yellow(`  Review failed: ${result.error?.split('\n')[0] || 'Unknown error'}`));
      console.log(chalk.gray('  You can review the project manually.'));
    }
  } catch (err) {
    spinner.stop();
    loggerRef.error('Final review failed', err);
    console.log(chalk.yellow('  Review step failed — skipping.'));
  }
}

// Per-iteration timing data collected during the run (for end-of-run statistics)
interface IterationTiming {
  iteration: number;
  taskId: string;
  taskTitle: string;
  durationMs: number;
  success: boolean;
  errorType?: ClaudeErrorType;
}

// Token totals shape used by the run loop
interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

function displayRunStatistics(
  timings: IterationTiming[],
  sessionTokens: TokenTotals,
  sessionCost: number,
  sessionStartTime: number,
  finalProgress: Progress | null,
  taskList: Task[] | null
): void {
  printBanner('Complete');

  if (timings.length === 0) {
    if (finalProgress) {
      console.log(chalk.gray(`Tasks completed: ${finalProgress.completed}/${finalProgress.totalTasks}`));
    }
    console.log(chalk.gray('No iterations ran this session.'));
    return;
  }

  // Helper to calculate price per million tokens
  const pricePerMillion = (cost: number, tokens: number): string => {
    if (tokens === 0) return '0.00';
    return ((cost / tokens) * 1_000_000).toFixed(2);
  };

  const wallClockSec = Math.round((Date.now() - sessionStartTime) / 1000);
  const successTimings = timings.filter(t => t.success);
  const failedTimings = timings.filter(t => !t.success);

  // --- Overview ---
  console.log(chalk.white.bold('--- Run Statistics ---\n'));

  console.log(chalk.gray(`  Duration:        `) + chalk.white(formatDuration(wallClockSec)));
  console.log(
    chalk.gray(`  Iterations:      `) +
    chalk.white(String(timings.length)) +
    chalk.gray(` (`) +
    chalk.green(`${successTimings.length} successful`) +
    (failedTimings.length > 0
      ? chalk.gray(`, `) + chalk.red(`${failedTimings.length} failed`)
      : '') +
    chalk.gray(`)`)
  );

  if (finalProgress) {
    console.log(chalk.gray(`  Tasks completed: `) + chalk.white(`${finalProgress.completed}/${finalProgress.totalTasks}`));
  }

  if (successTimings.length > 0) {
    const avgMs = successTimings.reduce((sum, t) => sum + t.durationMs, 0) / successTimings.length;
    console.log(chalk.gray(`  Avg time/task:   `) + chalk.white(formatDuration(Math.round(avgMs / 1000))));
  } else {
    console.log(chalk.gray(`  Avg time/task:   `) + chalk.gray('N/A'));
  }

  // --- Longest / Shortest ---
  if (successTimings.length > 1) {
    // Deduplicate: if a task was retried, use the successful attempt's timing
    const taskTimings = new Map<string, IterationTiming>();
    for (const t of successTimings) {
      taskTimings.set(t.taskId, t);
    }
    const uniqueTimings = Array.from(taskTimings.values());

    if (uniqueTimings.length > 1) {
      const sorted = [...uniqueTimings].sort((a, b) => b.durationMs - a.durationMs);
      const longest = sorted[0];
      const shortest = sorted[sorted.length - 1];

      const lookupTitle = (t: IterationTiming): string => {
        const task = taskList?.find(tk => tk.id === t.taskId);
        return task?.title || t.taskTitle;
      };

      console.log();
      console.log(
        chalk.gray(`  Longest task:    `) +
        chalk.yellow(formatDuration(Math.round(longest.durationMs / 1000)).padEnd(8)) +
        chalk.cyan(longest.taskId) + chalk.gray(` - ${lookupTitle(longest)}`)
      );
      console.log(
        chalk.gray(`  Shortest task:   `) +
        chalk.green(formatDuration(Math.round(shortest.durationMs / 1000)).padEnd(8)) +
        chalk.cyan(shortest.taskId) + chalk.gray(` - ${lookupTitle(shortest)}`)
      );
    }
  }

  // --- Failure Analysis ---
  if (failedTimings.length > 0) {
    console.log();
    console.log(chalk.gray(`  Failures:`));

    // Group failures by task ID
    const failuresByTask = new Map<string, IterationTiming[]>();
    for (const t of failedTimings) {
      const existing = failuresByTask.get(t.taskId) || [];
      existing.push(t);
      failuresByTask.set(t.taskId, existing);
    }

    const successTaskIds = new Set(successTimings.map(t => t.taskId));

    for (const [taskId, failures] of failuresByTask) {
      const count = failures.length;
      const overcome = successTaskIds.has(taskId);
      const suffix = overcome
        ? chalk.green('succeeded')
        : chalk.yellow('still in-progress');
      const plural = count === 1 ? 'attempt' : 'attempts';
      console.log(
        chalk.gray(`    `) +
        chalk.cyan(taskId.padEnd(12)) +
        chalk.gray(`${count} failed ${plural} → `) + suffix
      );
    }

    // Error type breakdown
    const errorCounts = new Map<string, number>();
    for (const t of failedTimings) {
      const type = t.errorType || 'unknown';
      errorCounts.set(type, (errorCounts.get(type) || 0) + 1);
    }
    const errorParts = Array.from(errorCounts.entries())
      .map(([type, count]) => `${count}× ${type}`);
    console.log(chalk.gray(`  Error types:     `) + chalk.red(errorParts.join(', ')));
  }

  // --- Token / Cost Summary ---
  if (sessionTokens.total > 0) {
    console.log();
    console.log(
      chalk.gray(`  Session cost:    `) +
      chalk.white(`$${sessionCost.toFixed(4)}`) +
      chalk.gray(` (${sessionTokens.total.toLocaleString()} tokens, ~$${pricePerMillion(sessionCost, sessionTokens.total)}/M)`)
    );
    if (successTimings.length > 0) {
      const avgCost = sessionCost / successTimings.length;
      console.log(chalk.gray(`  Avg cost/task:   `) + chalk.white(`$${avgCost.toFixed(4)}`));
    }
  }

  console.log();
}

// Spinner state for activity updates
interface SpinnerState {
  baseText: string;
  currentActivity: string | null;
  startTime: number;
  interval: NodeJS.Timeout | null;
}

// Start a spinner with elapsed time updates
function startTimedSpinner(spinner: Spinner, baseText: string, startTime: number, verbose: boolean, terminalTitle?: string): SpinnerState {
  const state: SpinnerState = {
    baseText,
    currentActivity: null,
    startTime,
    interval: null
  };

  if (verbose) {
    console.log(chalk.cyan(baseText));
    return state;
  }

  spinner.start(chalk.cyan(`${baseText} (0s)`));

  // Update spinner text and terminal title with elapsed time every second
  // Re-setting terminal title periodically ensures it stays visible even if
  // child processes (like Claude CLI) try to set their own title
  state.interval = setInterval(() => {
    const elapsed = formatElapsed(startTime);
    const activityText = state.currentActivity
      ? `${state.baseText} - ${state.currentActivity} (${elapsed})`
      : `${state.baseText} (${elapsed})`;
    spinner.text = chalk.cyan(activityText);
    if (terminalTitle) {
      setTerminalTitle(terminalTitle);
    }
  }, 1000);

  return state;
}

// Update spinner with current activity
function updateSpinnerActivity(state: SpinnerState, activity: string): void {
  state.currentActivity = activity;
}

/**
 * Setup graceful shutdown via stdin keypress.
 *
 * Q key = graceful stop (wait for current task to complete, then stop)
 * Ctrl+C = natural process kill (kills Claude too — this is the force stop)
 *
 * When stdin is a TTY, raw mode is used so keypresses arrive immediately.
 * On Windows (especially Git Bash/mintty), stdin may not be detected as a TTY.
 * In that case, a line-buffered fallback is used ('q' + Enter).
 */
function setupGracefulShutdown(): () => void {
  const isTTY = process.stdin.isTTY;

  if (isTTY) {
    try {
      process.stdin.setRawMode(true);
      rawModeActive = true;
    } catch {
      // setRawMode can fail on some platforms
      rawModeActive = false;
    }
  }

  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const onData = (key: string) => {
    // Use trim() to handle line-buffered input (e.g. 'q\r\n' from non-raw mode,
    // or if raw mode was reset by a child process on Windows)
    const trimmed = key.trim().toLowerCase();
    if (trimmed === 'q') {
      if (!stopRequested) {
        stopRequested = true;
        // Use spinner methods to persist the message above the spinner line,
        // otherwise the spinner's redraw overwrites plain console.log output
        if (activeSpinner && activeSpinner.isSpinning) {
          activeSpinner.stopAndPersist({
            symbol: chalk.yellow('>>'),
            text: chalk.yellow('Graceful stop requested - will stop after current task completes.')
          });
          activeSpinner.start(activeSpinner.text);
        } else {
          console.log(chalk.yellow('\n>> Graceful stop requested - will stop after current task completes.'));
        }
      }
    } else if (key === '\x03') {
      // Ctrl+C in raw mode — force stop
      console.log(chalk.red('\n\nForce stopping...'));
      process.exit(1);
    }
  };

  process.stdin.on('data', onData);

  // Return cleanup function
  return () => {
    process.stdin.removeListener('data', onData);
    if (isTTY && rawModeActive) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore — may already be unset
      }
      rawModeActive = false;
    }
    process.stdin.pause();
    stopRequested = false;
  };
}

/**
 * Re-enable raw mode and resume stdin.
 * Called after operations that may disrupt stdin (child process spawns,
 * readline usage). On Windows, spawning child processes via cmd.exe can
 * reset the console input mode, disabling raw mode.
 */
function ensureStdinListening(): void {
  if (process.stdin.isTTY && !rawModeActive) {
    try {
      process.stdin.setRawMode(true);
      rawModeActive = true;
    } catch {
      // Best effort
    }
  }
  process.stdin.resume();
}

/**
 * Write an active task marker to the session file.
 * Used to detect crashes on next run.
 */
async function setActiveTask(
  workspacePath: string,
  activeTask: ActiveTask | null
): Promise<void> {
  try {
    const session = await readSession(workspacePath);
    if (session) {
      session.activeTask = activeTask;
      await writeSession(workspacePath, session);
    }
  } catch {
    // Best-effort — don't let marker writes break the loop
  }
}

/**
 * Read active task marker from session. Returns null if no crash marker.
 */
async function getActiveTask(
  workspacePath: string
): Promise<ActiveTask | null> {
  try {
    const session = await readSession(workspacePath);
    return session?.activeTask ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the last N lines from the debug log.
 */
function readDebugLogTail(workspacePath: string, lines: number = 20): string[] {
  try {
    const logPath = path.join(workspacePath, '.devloop', 'debug.log');
    if (!fsSync.existsSync(logPath)) return [];
    const content = fsSync.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n').filter(l => l.trim());
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Check for crash marker from a previous run and prompt the user.
 * Returns true if we should continue, false if user wants to exit.
 */
async function checkCrashMarker(
  config: DevLoopConfig,
  logger: Logger
): Promise<boolean> {
  const activeTask = await getActiveTask(config.workspacePath);
  if (!activeTask) return true;

  logger.info(`Crash marker detected: ${activeTask.taskId} (iteration ${activeTask.iterationNumber})`);

  console.log(chalk.red.bold('\n⚠ Previous run crashed!\n'));
  console.log(chalk.red(`  Task: ${activeTask.taskId} - ${activeTask.taskTitle}`));
  console.log(chalk.red(`  Iteration: ${activeTask.iterationNumber}`));
  console.log(chalk.red(`  Started at: ${activeTask.startedAt}`));

  // Show recent debug log
  const logLines = readDebugLogTail(config.workspacePath, 20);
  if (logLines.length > 0) {
    console.log(chalk.gray('\n  Recent debug log:'));
    for (const line of logLines) {
      console.log(chalk.gray(`    ${line}`));
    }
  }

  console.log();
  const shouldContinue = await promptUser(chalk.cyan('Previous run crashed. Continue? (Y/n): '));

  if (!shouldContinue) {
    console.log(chalk.yellow('Exiting. Inspect the workspace and fix any issues before running again.'));
    return false;
  }

  // Clear the crash marker
  await setActiveTask(config.workspacePath, null);
  return true;
}

export interface RunLoopOverrides {
  /** Replace the Claude invocation function (for testing with mocks) */
  invoker?: typeof invokeClaudeAutomated;
  /** Skip stdin raw mode and graceful shutdown setup (for testing) */
  skipStdin?: boolean;
  /** Skip all git operations (for testing) */
  skipGit?: boolean;
  /** Request graceful stop after this many iterations (for testing Q key behavior) */
  stopAfterIterations?: number;
}

export async function runLoop(config: DevLoopConfig, overrides?: RunLoopOverrides): Promise<void> {
  // Reset module-level state in case of previous run in same process
  stopRequested = false;
  rawModeActive = false;

  const invoke = overrides?.invoker ?? invokeClaudeAutomated;
  const sessionStartTime = Date.now();
  const spinner = createSpinner();
  const cleanupShutdownHandler = overrides?.skipStdin ? (() => {}) : setupGracefulShutdown();
  const logger = createLogger(config.workspacePath);

  logger.info(`Loop starting: maxIterations=${config.maxIterations}, workspace=${config.workspacePath}`);

  // Check for crash marker from previous run (before any changes to workspace)
  const shouldContinue = await checkCrashMarker(config, logger);
  if (!shouldContinue) {
    cleanupShutdownHandler();
    return;
  }

  // Re-enable raw mode in case readline in promptUser paused/disrupted stdin
  if (!overrides?.skipStdin) ensureStdinListening();

  // Set initial terminal title
  setTerminalTitle(`DevLoop: Starting...`);

  printBanner('Starting');
  if (rawModeActive) {
    console.log(chalk.yellow('Tip: Press Q to stop after the current task completes.'));
  } else {
    console.log(chalk.yellow('Tip: Type q + Enter to stop after the current task completes.'));
  }
  console.log(chalk.gray(`Workspace: ${config.workspacePath}`));
  console.log(chalk.gray(`Requirements: ${config.requirementsPath}`));
  console.log(chalk.gray(`Tasks: ${config.tasksPath}`));
  console.log(chalk.gray(`Progress: ${config.progressPath}`));
  console.log(chalk.gray(`Max iterations: ${config.maxIterations}`));
  if (config.tokenLimit) {
    console.log(chalk.gray(`Token limit: ${config.tokenLimit.toLocaleString()} (per session)`));
  }
  if (config.costLimit) {
    console.log(chalk.gray(`Cost limit: $${config.costLimit.toFixed(2)} (per session)`));
  }
  console.log(chalk.green(`Workspace restriction: ENABLED (--add-dir)`));

  if (config.dryRun) {
    console.log(chalk.yellow('DRY RUN MODE - No changes will be made'));
  }

  console.log();

  // Ensure git repo is set up for version control
  let gitSetup = { gitAvailable: false, wasInitialized: false };
  let hasInterruptedWork = false;

  if (!overrides?.skipGit) {
    gitSetup = await ensureGitRepo(config.workspacePath, config.verbose);
    if (gitSetup.gitAvailable) {
      if (gitSetup.wasInitialized) {
        console.log(chalk.green('Git: Repository initialized with initial commit'));
      } else {
        console.log(chalk.green('Git: Version control enabled'));
      }
    } else {
      console.log(chalk.yellow('Git: Not available - changes will not be versioned'));
    }

    // Check for uncommitted changes (potential interrupted work)
    // Ignore .devloop/ changes as these are session files updated at run start
    if (gitSetup.gitAvailable) {
      const uncommitted = await getUncommittedChanges(config.workspacePath, ['.devloop/', '.claude/']);
      if (uncommitted.hasChanges) {
        hasInterruptedWork = true;
        console.log(chalk.yellow('\nDetected uncommitted changes (possible interrupted work):'));
        for (const file of uncommitted.files.slice(0, 10)) {
          console.log(chalk.gray(`  - ${file}`));
        }
        if (uncommitted.files.length > 10) {
          console.log(chalk.gray(`  ... and ${uncommitted.files.length - 10} more files`));
        }
      }
    }
  }

  console.log();

  // Create/update session AFTER uncommitted changes check to avoid false positives
  if (config.sessionAction === 'create') {
    await createSession(config.workspacePath, 'run');
  } else if (config.sessionAction === 'update') {
    await updateSessionPhase(config.workspacePath, 'run');
  }

  // Load existing progress to determine starting iteration and token usage
  const existingProgress = await readProgress(config.progressPath);
  const startIteration = existingProgress ? existingProgress.iterations.length + 1 : 1;

  // Calculate project totals from previous iterations (for display)
  let projectTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
  let projectCost = 0;
  if (existingProgress) {
    for (const iter of existingProgress.iterations) {
      if (iter.tokenUsage) {
        projectTokens.input += iter.tokenUsage.inputTokens;
        projectTokens.output += iter.tokenUsage.outputTokens;
        projectTokens.cacheWrite += iter.tokenUsage.cacheCreationTokens;
        projectTokens.cacheRead += iter.tokenUsage.cacheReadTokens;
        projectTokens.total += iter.tokenUsage.totalTokens;
        projectCost += iter.tokenUsage.costUsd;
      }
    }
  }

  // Track session tokens separately (for limit checking)
  let sessionTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
  let sessionCost = 0;

  // Collect per-iteration timing data for end-of-run statistics
  const iterationTimings: IterationTiming[] = [];

  // Helper to calculate price per million tokens
  const pricePerMillion = (cost: number, tokens: number): string => {
    if (tokens === 0) return '0.00';
    return ((cost / tokens) * 1_000_000).toFixed(2);
  };

  // maxIterations is additional iterations to run, not absolute count
  const endIteration = startIteration + config.maxIterations - 1;

  if (existingProgress && existingProgress.iterations.length > 0) {
    console.log(chalk.yellow(`Resuming from iteration ${startIteration}`));
    console.log(chalk.gray(`Previously completed: ${existingProgress.completed} tasks`));
    console.log(chalk.gray(`Will run up to ${config.maxIterations} more iterations (${startIteration}-${endIteration})`));
    if (projectTokens.total > 0) {
      console.log(chalk.gray(`Project tokens: ${projectTokens.total.toLocaleString()} total`));
      console.log(chalk.gray(`  In: ${projectTokens.input.toLocaleString()} | Out: ${projectTokens.output.toLocaleString()} | Cache +${projectTokens.cacheWrite.toLocaleString()}/-${projectTokens.cacheRead.toLocaleString()}`));
      console.log(chalk.gray(`Project cost: $${projectCost.toFixed(4)} (~$${pricePerMillion(projectCost, projectTokens.total)}/M)`));
    }
    console.log();
  }

  // Cross-reference tasks against progress.md to detect
  // tasks falsely marked done (e.g. Claude edited status before interruption)
  {
    const progress = await readProgress(config.progressPath);
    const completedIds = progress ? getCompletedTaskIds(progress) : new Set<string>();
    const preReqs = await parseTasks(config.tasksPath);
    let fixed = 0;
    for (const task of preReqs.tasks) {
      if (task.status === 'done' && !completedIds.has(task.id)) {
        await updateTaskStatus(config.tasksPath, task.id, 'pending');
        console.log(chalk.yellow(`  Reverted ${task.id} to pending (marked done but no completion log)`));
        fixed++;
      } else if (task.status === 'in-progress' && completedIds.has(task.id)) {
        await updateTaskStatus(config.tasksPath, task.id, 'done');
        console.log(chalk.green(`  Promoted ${task.id} to done (completion log found)`));
        fixed++;
      } else if (task.status === 'pending' && completedIds.has(task.id)) {
        await updateTaskStatus(config.tasksPath, task.id, 'done');
        console.log(chalk.green(`  Promoted ${task.id} to done (completion log found)`));
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log(chalk.yellow(`  Fixed ${fixed} task status(es) via cross-reference.\n`));
    }
  }

  for (let i = startIteration; i <= endIteration; i++) {
    // Check for graceful stop request
    if (stopRequested) {
      console.log(chalk.yellow('\nStopping as requested.'));
      break;
    }

    // Check token limit before starting iteration (session tokens only)
    if (config.tokenLimit && sessionTokens.total >= config.tokenLimit) {
      console.log(chalk.yellow(`\nSession token limit reached: ${sessionTokens.total.toLocaleString()} / ${config.tokenLimit.toLocaleString()}`));
      console.log(chalk.yellow('Stopping to prevent rate limit errors.'));
      break;
    }

    // Check cost limit before starting iteration (session cost only)
    if (config.costLimit && sessionCost >= config.costLimit) {
      console.log(chalk.yellow(`\nSession cost limit reached: $${sessionCost.toFixed(4)} / $${config.costLimit.toFixed(2)}`));
      console.log(chalk.yellow('Stopping to control costs.'));
      break;
    }

    const iterationStart = new Date();

    // Parse tasks fresh each iteration
    spinner.start(chalk.cyan(`Iteration ${i}: Reading tasks...`));

    let taskList;
    try {
      taskList = await parseTasks(config.tasksPath);
    } catch (error) {
      spinner.fail(chalk.red(`Failed to parse tasks: ${error}`));
      break;
    }

    spinner.stop();

    // Check if all tasks are done
    const pendingTasks = taskList.tasks.filter(t => t.status === 'pending');
    const inProgressTasks = taskList.tasks.filter(t => t.status === 'in-progress');
    const doneTasks = taskList.tasks.filter(t => t.status === 'done');

    if (pendingTasks.length === 0 && inProgressTasks.length === 0) {
      setTerminalTitle(`DevLoop: All ${doneTasks.length} tasks complete!`);
      console.log(chalk.green.bold('\n✓ All tasks completed!'));
      console.log(chalk.gray(`Completed ${doneTasks.length} tasks in ${i - 1} iterations.`));
      break;
    }

    // Get next task based on dependencies and priority
    const nextTask = getNextTask(taskList);

    if (!nextTask) {
      console.log(chalk.yellow('\nNo available tasks (all remaining tasks have unmet dependencies)'));
      console.log(chalk.gray('Blocked tasks:'));
      for (const task of pendingTasks) {
        console.log(chalk.gray(`  - ${task.id}: depends on ${task.dependencies.join(', ')}`));
      }
      break;
    }

    // Commit interrupted work before starting fresh (only on first iteration)
    if (hasInterruptedWork && !overrides?.skipGit) {
      console.log(chalk.cyan(`\nCommitting interrupted work (likely from ${nextTask.id})...`));
      const committed = await commitInterruptedWork(
        config.workspacePath,
        nextTask.id,
        nextTask.title,
        config.verbose
      );
      if (committed) {
        console.log(chalk.green('Interrupted work committed. Starting fresh.'));
      } else {
        // Failed to commit uncommitted changes - stop and let user fix it
        console.log(chalk.red.bold('\n⚠ Failed to commit uncommitted changes'));
        console.log(chalk.red('DevLoop detected uncommitted changes but could not commit them.'));
        console.log(chalk.yellow('\nPlease resolve this manually:'));
        console.log(chalk.gray('  1. Run "git status" to see the uncommitted changes'));
        console.log(chalk.gray('  2. Either commit them: git add -A && git commit -m "message"'));
        console.log(chalk.gray('  3. Or discard them: git checkout -- . && git clean -fd'));
        console.log(chalk.gray('  4. Then run "devloop continue" to resume\n'));
        break;
      }
      hasInterruptedWork = false; // Only handle once
    }

    // Update terminal title with current task
    const totalTasks = taskList.tasks.length;
    const completedTasks = doneTasks.length;
    setTerminalTitle(`DevLoop: ${i}/${endIteration} - ${nextTask.id} (${completedTasks}/${totalTasks} done)`);

    logger.info(`Iteration ${i}: Starting ${nextTask.id} - ${nextTask.title}`);

    console.log(chalk.cyan(`\nIteration ${i}: ${nextTask.id} - ${nextTask.title}`));
    console.log(chalk.gray(`  Description: ${nextTask.description}`));
    console.log(chalk.yellow(`  ${rawModeActive ? 'Press Q' : 'Type q + Enter'} to stop after this task`) + chalk.gray(' | Ctrl+C to force stop'));

    if (config.dryRun) {
      console.log(chalk.yellow(`  [DRY RUN] Would execute this task`));
      continue;
    }

    // Build prompt and invoke Claude with timed spinner
    const taskStartTime = Date.now();
    const currentTitle = `DevLoop: ${i}/${endIteration} - ${nextTask.id} (${completedTasks}/${totalTasks} done)`;
    let spinnerState: SpinnerState | null = null;

    try {
      // Detect retry: task was already in-progress (getNextTask returns in-progress first)
      const isRetry = nextTask.status === 'in-progress';

      // Mark task as in-progress before invoking Claude
      await updateTaskStatus(config.tasksPath, nextTask.id, 'in-progress');

      // Set crash marker before invoking Claude
      await setActiveTask(config.workspacePath, {
        taskId: nextTask.id,
        taskTitle: nextTask.title,
        iterationNumber: i,
        startedAt: new Date().toISOString()
      });

      activeSpinner = spinner;
      spinnerState = startTimedSpinner(
        spinner,
        `  Claude working on ${nextTask.id}`,
        taskStartTime,
        config.verbose,
        currentTitle
      );

      const prompt = buildTaskPrompt(nextTask, config.requirementsPath, config.tasksPath, config.progressPath, config.workspacePath, isRetry);
      const result = await invoke(prompt, config.workspacePath, {
        verbose: config.verbose,
        onProgress: (activity) => {
          updateSpinnerActivity(spinnerState!, activity);
        }
      });

      // Stop the spinner interval
      if (spinnerState.interval) {
        clearInterval(spinnerState.interval);
      }
      activeSpinner = null;

      // Re-enable raw mode — child process spawn can reset console mode on Windows
      if (!overrides?.skipStdin) ensureStdinListening();

      // Simulate graceful stop for testing (mimics Q key press during a task)
      if (overrides?.stopAfterIterations !== undefined) {
        const iterationsRun = iterationTimings.length + 1; // +1 for current (not yet pushed)
        if (iterationsRun >= overrides.stopAfterIterations) {
          stopRequested = true;
        }
      }

      logger.info(`Iteration ${i}: Claude finished - success=${result.success}, exitCode=${result.exitCode}, signal=${result.signal}, duration=${result.duration}ms`);
      if (!result.success) {
        logger.error(`Iteration ${i}: ${result.errorType} - ${result.error}`);
      }

      // Update token tracking (both session and project)
      if (result.tokenUsage) {
        sessionTokens.input += result.tokenUsage.inputTokens;
        sessionTokens.output += result.tokenUsage.outputTokens;
        sessionTokens.cacheWrite += result.tokenUsage.cacheCreationTokens;
        sessionTokens.cacheRead += result.tokenUsage.cacheReadTokens;
        sessionTokens.total += result.tokenUsage.totalTokens;
        sessionCost += result.tokenUsage.costUsd;

        projectTokens.input += result.tokenUsage.inputTokens;
        projectTokens.output += result.tokenUsage.outputTokens;
        projectTokens.cacheWrite += result.tokenUsage.cacheCreationTokens;
        projectTokens.cacheRead += result.tokenUsage.cacheReadTokens;
        projectTokens.total += result.tokenUsage.totalTokens;
        projectCost += result.tokenUsage.costUsd;
      }

      const duration = formatDuration(Math.round(result.duration / 1000));

      // Collect timing data for end-of-run statistics
      iterationTimings.push({
        iteration: i,
        taskId: nextTask.id,
        taskTitle: nextTask.title,
        durationMs: result.duration,
        success: result.success,
        errorType: result.success ? undefined : result.errorType
      });

      // Record iteration with error details and token usage
      const iterationLog: IterationLog = {
        iteration: i,
        timestamp: iterationStart.toISOString(),
        taskAttempted: nextTask.id,
        taskCompleted: result.success ? nextTask.id : null,
        summary: result.success
          ? `Completed ${nextTask.title}`
          : `Failed: ${result.error?.split('\n')[0] || 'Unknown error'}`,
        duration,
        exitStatus: result.success ? 'success' : 'error',
        errorType: result.success ? undefined : result.errorType,
        errorDetail: result.success ? undefined : result.error,
        tokenUsage: result.tokenUsage
      };

      // Update progress file
      await appendIteration(config.progressPath, taskList.tasks.length, iterationLog);

      // Write task log for later inspection
      await writeTaskLog(config.workspacePath, nextTask.id, nextTask.title, i, prompt, result, logger);

      // Update session
      await updateSessionIteration(config.workspacePath, i);

      if (result.success) {
        const tokenInfo = result.tokenUsage
          ? ` [${result.tokenUsage.totalTokens.toLocaleString()} tokens]`
          : '';
        if (config.verbose) {
          console.log(chalk.green(`  ✓ Completed ${nextTask.id} (${duration})${tokenInfo}`));
        } else {
          spinner.succeed(chalk.green(`  Completed ${nextTask.id} (${duration})${tokenInfo}`));
        }
        // Show detailed token usage breakdown
        if (result.tokenUsage) {
          const t = result.tokenUsage;
          console.log(chalk.gray(`    This iteration: ${t.totalTokens.toLocaleString()} tokens ($${t.costUsd.toFixed(4)}, ~$${pricePerMillion(t.costUsd, t.totalTokens)}/M)`));
          console.log(chalk.gray(`      In: ${t.inputTokens.toLocaleString()} | Out: ${t.outputTokens.toLocaleString()} | Cache +${t.cacheCreationTokens.toLocaleString()}/-${t.cacheReadTokens.toLocaleString()}`));
          console.log(chalk.gray(`    Session: ${sessionTokens.total.toLocaleString()} tokens ($${sessionCost.toFixed(4)}, ~$${pricePerMillion(sessionCost, sessionTokens.total)}/M)`));
          console.log(chalk.gray(`    Project: ${projectTokens.total.toLocaleString()} tokens ($${projectCost.toFixed(4)}, ~$${pricePerMillion(projectCost, projectTokens.total)}/M)`));
        }
      } else {
        if (config.verbose) {
          console.log(chalk.red(`  ✗ Failed ${nextTask.id} - ${result.error}`));
        } else {
          spinner.fail(chalk.red(`  Failed ${nextTask.id} - ${result.error}`));
        }

        // Check if this is an API error (not a task failure)
        if (isApiError(result.errorType)) {
          logger.error(`API error detected, stopping loop: ${result.errorType} - ${result.error}`);
          console.log(chalk.red.bold('\n⚠ API Error Detected - Stopping DevLoop\n'));
          console.log(chalk.red(`  Error Type: ${result.errorType}`));
          console.log(chalk.red(`  Details: ${result.error}`));
          console.log(chalk.yellow('\n  This is an API-level error, not a task failure.'));
          console.log(chalk.yellow('  Please resolve the issue before continuing.\n'));

          // Clear crash marker before breaking
          await setActiveTask(config.workspacePath, null);
          break;
        }

        // Task failure - continue to next iteration (future attempt may succeed)
        console.log(chalk.yellow('  Continuing to next task...'));
      }

      // Update task status in tasks file (DevLoop owns status, not Claude)
      // On success: mark done. On failure: leave as in-progress (getNextTask
      // prioritizes in-progress tasks, so it will be retried next iteration)
      if (result.success) {
        await updateTaskStatus(config.tasksPath, nextTask.id, 'done');
      }

      // Clear crash marker before committing so session.json is clean in the commit
      await setActiveTask(config.workspacePath, null);

      // Commit iteration changes to git (if available)
      if (!overrides?.skipGit) {
        const commitResult = await commitIteration(
          config.workspacePath,
          i,
          nextTask.id,
          nextTask.title,
          result.success,
          config.verbose
        );

        // Stop loop if commit failed due to a hook
        if (commitResult.hookFailure) {
          console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
          console.log(chalk.gray('Fix the commit message format and run "devloop run" again.'));
          break;
        }
      }

      // Check if graceful stop was requested during this task
      if (stopRequested) {
        if (result.success) {
          console.log(chalk.yellow(`\nTask ${nextTask.id} completed. Stopping as requested.`));
        } else {
          console.log(chalk.yellow(`\nStopping as requested.`));
        }
        console.log(chalk.gray('Run "devloop continue" to resume.'));
        break;
      }

    } catch (iterationError) {
      // Stop spinner if still running
      if (spinnerState?.interval) {
        clearInterval(spinnerState.interval);
      }
      spinner.stop();

      logger.error(`Iteration ${i}: Unhandled exception`, iterationError);

      const errorMessage = iterationError instanceof Error
        ? iterationError.message
        : String(iterationError);

      console.log(chalk.red.bold(`\n  ⚠ Iteration ${i} crashed: ${errorMessage}`));

      // Collect timing data for crash
      iterationTimings.push({
        iteration: i,
        taskId: nextTask.id,
        taskTitle: nextTask.title,
        durationMs: Date.now() - taskStartTime,
        success: false,
        errorType: 'unknown'
      });

      // Record crash in progress.md
      try {
        const crashLog: IterationLog = {
          iteration: i,
          timestamp: iterationStart.toISOString(),
          taskAttempted: nextTask.id,
          taskCompleted: null,
          summary: `Crashed: ${errorMessage}`,
          duration: formatDuration(Math.round((Date.now() - taskStartTime) / 1000)),
          exitStatus: 'error',
          errorType: 'unknown',
          errorDetail: iterationError instanceof Error ? iterationError.stack : String(iterationError)
        };

        if (taskList) {
          await appendIteration(config.progressPath, taskList.tasks.length, crashLog);
        }
      } catch {
        logger.error('Failed to record crash in progress.md');
      }

      // Clear crash marker so next run doesn't show stale info
      await setActiveTask(config.workspacePath, null);

      console.log(chalk.yellow('  Continuing to next iteration...'));
      continue;
    }

    // Small delay between iterations to avoid rate limiting
    await sleep(1000);
  }

  // Clean up signal handler
  cleanupShutdownHandler();

  logger.info('Loop complete');

  // Final summary with statistics
  const finalProgress = await readProgress(config.progressPath);

  let finalTaskList: Task[] | null = null;
  try {
    const parsed = await parseTasks(config.tasksPath);
    finalTaskList = parsed.tasks;
  } catch {
    // Best effort - titles will fall back to stored values in timings
  }

  displayRunStatistics(iterationTimings, sessionTokens, sessionCost, sessionStartTime, finalProgress, finalTaskList);

  // Set final terminal title
  if (finalProgress) {
    if (stopRequested) {
      setTerminalTitle(`DevLoop: Stopped (${finalProgress.completed}/${finalProgress.totalTasks} tasks)`);
    } else if (finalProgress.completed === finalProgress.totalTasks) {
      setTerminalTitle(`DevLoop: Complete! (${finalProgress.totalTasks} tasks)`);
    } else {
      setTerminalTitle(`DevLoop: Done (${finalProgress.completed}/${finalProgress.totalTasks} tasks)`);
    }
  } else {
    setTerminalTitle('DevLoop: Complete');
  }

  // Run final code review when ALL tasks completed
  if (finalProgress && finalProgress.completed === finalProgress.totalTasks) {
    await runFinalReview(config, invoke, logger, overrides?.skipGit, overrides?.skipStdin);
  }

  // Show next steps when all tasks are done
  if (finalProgress && finalProgress.completed === finalProgress.totalTasks) {
    console.log(chalk.green('All tasks complete!'));
    console.log(chalk.cyan('Run "devloop continue" to start the next iteration.'));
    console.log(chalk.gray('Or clean up: rm -rf .devloop .claude'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
