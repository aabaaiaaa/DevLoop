import chalk from 'chalk';
import { createSpinner, Spinner } from './spinner.js';
import { spawn as spawnProcess } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { DevLoopConfig, IterationLog, ActiveTask, Task, Progress, ClaudeErrorType, WorkerState, WorkerResult, WorktreeInfo, ToolEvent } from '../types/index.js';
import { parseTasks, getNextTask, getAvailableTasks, updateTaskStatus } from '../parser/tasks.js';
import { readProgress, appendIteration, getCompletedTaskIds } from '../parser/progress.js';
import { invokeClaudeAutomated, buildTaskPrompt, isApiError } from './claude.js';
import { createSession, readSession, writeSession, updateSessionPhase, updateSessionIteration, setActiveTasks, getActiveTasks } from './session.js';
import { commitIteration, commitInterruptedWork, ensureGitRepo, getUncommittedChanges, configureForParallel } from './git.js';
import { createWorktree, prepareWorktree, mergeWorktree, getWorktreeDiff, cleanupWorktree, cleanupStaleWorktrees } from './worktree.js';
import { AsyncMutex } from './mutex.js';
import { readProjectUsage, addProjectUsage } from './config.js';
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
 * Extract verification command patterns from the verification field.
 * Looks for backtick-enclosed commands, then falls back to common command prefixes.
 */
function extractVerificationCommands(verification: string): string[] {
  const commands: string[] = [];

  // Extract backtick-enclosed commands: `npm test`, `tsc --noEmit`, etc.
  const backtickMatches = verification.match(/`([^`]+)`/g);
  if (backtickMatches) {
    for (const m of backtickMatches) {
      commands.push(m.slice(1, -1).trim());
    }
  }

  // Extract quoted commands: "npm test", etc.
  const quotedMatches = verification.match(/"([^"]+)"/g);
  if (quotedMatches) {
    for (const m of quotedMatches) {
      const cmd = m.slice(1, -1).trim();
      // Only include if it looks like a command (starts with common tool names)
      if (/^(npm|node|npx|tsc|python|pytest|go |make|cargo|dotnet|jest|vitest|mocha)/.test(cmd)) {
        commands.push(cmd);
      }
    }
  }

  return commands;
}

/**
 * Estimate work vs verification time from tool events.
 * Finds the first bash command that matches the verification pattern
 * and splits the timeline at that point.
 */
function estimateWorkVerificationSplit(
  toolEvents: ToolEvent[],
  verification: string,
  taskStartTime: number,
  taskEndTime: number
): { workMs: number; verifyMs: number } | null {
  if (toolEvents.length === 0 || !verification) return null;

  const verifyCommands = extractVerificationCommands(verification);
  if (verifyCommands.length === 0) return null;

  // Find the first bash tool call whose command matches a verification pattern
  for (const event of toolEvents) {
    if (event.toolName?.toLowerCase() !== 'bash' || !event.command) continue;

    const cmd = event.command.trim();
    for (const verifyCmd of verifyCommands) {
      // Match if the command starts with or contains the verification command
      if (cmd.startsWith(verifyCmd) || cmd.includes(verifyCmd)) {
        const workMs = event.timestamp - taskStartTime;
        const verifyMs = taskEndTime - event.timestamp;
        // Sanity check: both should be positive and verification should be < total
        if (workMs > 0 && verifyMs > 0) {
          return { workMs, verifyMs };
        }
      }
    }
  }

  return null;
}

/**
 * Aggregate tool usage counts and durations from tool events.
 * Duration of tool call N = timestamp of N+1 - timestamp of N.
 * Duration of the last tool call = taskEndTime - timestamp of last.
 */
function aggregateToolUsage(
  toolEvents: ToolEvent[],
  taskEndTime: number
): Map<string, { count: number; durationMs: number }> {
  const stats = new Map<string, { count: number; durationMs: number }>();
  for (let i = 0; i < toolEvents.length; i++) {
    const event = toolEvents[i];
    const name = event.toolName || 'unknown';
    const nextTimestamp = i + 1 < toolEvents.length ? toolEvents[i + 1].timestamp : taskEndTime;
    const duration = Math.max(0, nextTimestamp - event.timestamp);

    const existing = stats.get(name) || { count: 0, durationMs: 0 };
    existing.count += 1;
    existing.durationMs += duration;
    stats.set(name, existing);
  }
  return stats;
}

/**
 * Display tool usage stats and timing breakdown for a completed task.
 */
function displayTaskStats(
  toolEvents: ToolEvent[],
  verification: string | undefined,
  taskStartTime: number,
  taskEndTime: number
): { workDuration?: string; verificationDuration?: string } {
  const result: { workDuration?: string; verificationDuration?: string } = {};

  // Tool usage stats with durations
  const toolStats = aggregateToolUsage(toolEvents, taskEndTime);
  if (toolStats.size > 0) {
    const parts = Array.from(toolStats.entries())
      .sort((a, b) => b[1].durationMs - a[1].durationMs)  // sort by total time descending
      .map(([name, { count, durationMs }]) => {
        const dur = formatDuration(Math.round(durationMs / 1000));
        return `${name}: ${count} (${dur})`;
      });
    console.log(chalk.gray(`    Tools: ${parts.join(', ')}`));
  }

  // Work vs verification split
  if (verification) {
    const split = estimateWorkVerificationSplit(toolEvents, verification, taskStartTime, taskEndTime);
    if (split) {
      const workDur = formatDuration(Math.round(split.workMs / 1000));
      const verifyDur = formatDuration(Math.round(split.verifyMs / 1000));
      const verifyPct = Math.round((split.verifyMs / (split.workMs + split.verifyMs)) * 100);
      console.log(chalk.gray(`    Timing: ~${workDur} work, ~${verifyDur} verification (${verifyPct}%)`));
      result.workDuration = workDur;
      result.verificationDuration = verifyDur;
    }
  }

  return result;
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
 * Write an active task marker to the session file (single task - backward compat wrapper).
 */
async function setActiveTask(
  workspacePath: string,
  activeTask: ActiveTask | null
): Promise<void> {
  await setActiveTasks(workspacePath, activeTask ? [activeTask] : []);
}

/**
 * Read active task marker from session. Returns null if no crash marker.
 */
async function getActiveTask(
  workspacePath: string
): Promise<ActiveTask | null> {
  const tasks = await getActiveTasks(workspacePath);
  return tasks.length > 0 ? tasks[0] : null;
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
  /** Override max workers for testing */
  maxWorkers?: number;
  /** Skip worktree-based parallel execution (use sequential loop) */
  skipWorktrees?: boolean;
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
  const maxWorkers = overrides?.maxWorkers ?? config.maxWorkers ?? 5;
  console.log(chalk.gray(`Max workers: ${maxWorkers}`));
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

    // Configure git for parallel worktree execution
    if (gitSetup.gitAvailable && maxWorkers > 1) {
      await configureForParallel(config.workspacePath);
      // Clean up stale worktrees from previous crashed runs
      const cleaned = await cleanupStaleWorktrees(config.workspacePath);
      if (cleaned > 0) {
        console.log(chalk.gray(`Git: Cleaned up ${cleaned} stale worktree branch(es)`));
      }
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

  // Load cumulative project usage (persists across archives/iterations)
  const projectUsage = await readProjectUsage(config.workspacePath);
  let projectTokens = {
    input: projectUsage.inputTokens,
    output: projectUsage.outputTokens,
    cacheWrite: projectUsage.cacheCreationTokens,
    cacheRead: projectUsage.cacheReadTokens,
    total: projectUsage.totalTokens
  };
  let projectCost = projectUsage.costUsd;

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
    console.log();
  }

  if (projectTokens.total > 0) {
    console.log(chalk.gray(`Project lifetime: ${projectTokens.total.toLocaleString()} tokens, $${projectCost.toFixed(4)} (~$${pricePerMillion(projectCost, projectTokens.total)}/M)`));
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

  // Determine if we can use parallel execution (requires git)
  const useParallel = gitSetup.gitAvailable && maxWorkers > 1 && !overrides?.skipWorktrees;

  if (useParallel) {
    console.log(chalk.green(`Parallel execution: ENABLED (up to ${maxWorkers} workers)`));
  }

  // --- Parallel Worker Pool ---
  const fileMutex = new AsyncMutex();
  const mergeMutex = new AsyncMutex();
  const activeWorkers = new Map<string, WorkerState>();
  const mergeFailureCounts = new Map<string, number>();
  const priorDiffs = new Map<string, string>();
  let iterationCounter = startIteration;
  let apiErrorDetected = false;
  let hookFailureDetected = false;
  let allTasksComplete = false;

  while (!stopRequested && !apiErrorDetected && !hookFailureDetected) {
    // Check token limit
    if (config.tokenLimit && sessionTokens.total >= config.tokenLimit) {
      console.log(chalk.yellow(`\nSession token limit reached: ${sessionTokens.total.toLocaleString()} / ${config.tokenLimit.toLocaleString()}`));
      break;
    }

    // Check cost limit
    if (config.costLimit && sessionCost >= config.costLimit) {
      console.log(chalk.yellow(`\nSession cost limit reached: $${sessionCost.toFixed(4)} / $${config.costLimit.toFixed(2)}`));
      break;
    }

    // Check iteration limit
    if (iterationCounter > endIteration) {
      console.log(chalk.yellow(`\nIteration limit reached (${config.maxIterations})`));
      break;
    }

    // Parse tasks fresh
    let taskList;
    try {
      taskList = await parseTasks(config.tasksPath);
    } catch (error) {
      spinner.fail(chalk.red(`Failed to parse tasks: ${error}`));
      break;
    }

    // Check if all tasks are done
    const doneTasks = taskList.tasks.filter(t => t.status === 'done');
    const totalTasks = taskList.tasks.length;

    if (doneTasks.length === totalTasks && activeWorkers.size === 0) {
      setTerminalTitle(`DevLoop: All ${doneTasks.length} tasks complete!`);
      console.log(chalk.green.bold('\n✓ All tasks completed!'));
      allTasksComplete = true;
      break;
    }

    // Commit interrupted work before starting fresh (only once)
    if (hasInterruptedWork && !overrides?.skipGit) {
      const firstAvailable = getNextTask(taskList);
      if (firstAvailable) {
        console.log(chalk.cyan(`\nCommitting interrupted work (likely from ${firstAvailable.id})...`));
        const committed = await commitInterruptedWork(
          config.workspacePath, firstAvailable.id, firstAvailable.title, config.verbose
        );
        if (!committed) {
          console.log(chalk.red.bold('\n⚠ Failed to commit uncommitted changes'));
          console.log(chalk.yellow('Please resolve this manually and run "devloop continue" to resume.'));
          break;
        }
        console.log(chalk.green('Interrupted work committed. Starting fresh.'));
      }
      hasInterruptedWork = false;
    }

    // Find available tasks (not active, deps met)
    const activeIds = new Set(activeWorkers.keys());
    const available = getAvailableTasks(taskList, activeIds);

    // How many new workers can we start?
    const effectiveMaxWorkers = useParallel ? maxWorkers : 1;
    const slotsAvailable = effectiveMaxWorkers - activeWorkers.size;
    const tasksToStart = available.slice(0, Math.max(0, slotsAvailable));

    // If no active workers and no available tasks, we're done or deadlocked
    if (activeWorkers.size === 0 && tasksToStart.length === 0) {
      const pendingTasks = taskList.tasks.filter(t => t.status === 'pending');
      if (pendingTasks.length > 0) {
        console.log(chalk.yellow('\nNo available tasks (all remaining tasks have unmet dependencies)'));
        console.log(chalk.gray('Blocked tasks:'));
        for (const task of pendingTasks) {
          console.log(chalk.gray(`  - ${task.id}: depends on ${task.dependencies.join(', ')}`));
        }
      }
      break;
    }

    // Start new workers
    for (const task of tasksToStart) {
      if (iterationCounter > endIteration) break;
      if (config.dryRun) {
        console.log(chalk.yellow(`  [DRY RUN] Would execute ${task.id}: ${task.title}`));
        iterationCounter++;
        continue;
      }

      const isRetry = task.status === 'in-progress';
      const priorDiff = priorDiffs.get(task.id);
      const mergeFailCount = mergeFailureCounts.get(task.id) || 0;
      const taskIteration = iterationCounter;
      iterationCounter++;

      // Mark task as in-progress (mutex-protected)
      const release = await fileMutex.acquire();
      try {
        await updateTaskStatus(config.tasksPath, task.id, 'in-progress');
      } finally {
        release();
      }

      logger.info(`Starting worker for ${task.id} - ${task.title} (iteration ${taskIteration})`);
      console.log(chalk.cyan(`\n  Starting ${task.id}: ${task.title} (${doneTasks.length}/${totalTasks} done)${priorDiff ? ' (re-applying prior changes)' : ''}`));

      // Create the worker promise
      const workerPromise = (async (): Promise<WorkerResult> => {
        const taskStartTime = Date.now();
        let worktree: WorktreeInfo | undefined;
        const toolEvents: ToolEvent[] = [];

        try {
          // Create worktree if parallel, otherwise work in main workspace
          const useWorktreeForTask = useParallel && mergeFailCount < 2;
          let workDir: string;

          if (useWorktreeForTask) {
            worktree = await createWorktree(config.workspacePath, task.id);
            await prepareWorktree(worktree, config.workspacePath);
            workDir = worktree.worktreePath;
          } else {
            // Sequential fallback (no git, or merge failed too many times)
            workDir = config.workspacePath;
          }

          // Build prompt with context
          const promptOpts = {
            isRetry,
            priorDiff: priorDiff || undefined,
            isParallel: useParallel && activeWorkers.size > 0
          };
          const prompt = buildTaskPrompt(
            task, config.requirementsPath, config.tasksPath, config.progressPath,
            workDir, promptOpts
          );

          // Invoke Claude with tool event tracking
          const result = await invoke(prompt, workDir, {
            verbose: config.verbose,
            onToolCall: (event) => { toolEvents.push(event); }
          });

          // Re-enable raw mode after child process
          if (!overrides?.skipStdin) ensureStdinListening();

          return {
            taskId: task.id,
            taskTitle: task.title,
            claudeResult: result,
            worktree: worktree || { worktreePath: config.workspacePath, branchName: '', taskId: task.id },
            priorDiff,
            mergeFailureCount: mergeFailCount,
            toolEvents,
            verification: task.verification
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            taskId: task.id,
            taskTitle: task.title,
            claudeResult: {
              success: false,
              output: '',
              rawOutput: '',
              error: errorMessage,
              errorType: 'unknown' as ClaudeErrorType,
              duration: Date.now() - taskStartTime
            },
            worktree: worktree || { worktreePath: config.workspacePath, branchName: '', taskId: task.id },
            priorDiff,
            mergeFailureCount: mergeFailCount,
            toolEvents,
            verification: task.verification
          };
        }
      })();

      activeWorkers.set(task.id, {
        task,
        worktree: { worktreePath: '', branchName: `devloop/${task.id}`, taskId: task.id },
        promise: workerPromise,
        startTime: Date.now()
      });

      // Update crash markers
      const activeTasksList: ActiveTask[] = [...activeWorkers.values()].map(w => ({
        taskId: w.task.id,
        taskTitle: w.task.title,
        iterationNumber: taskIteration,
        startedAt: new Date().toISOString()
      }));
      await setActiveTasks(config.workspacePath, activeTasksList);

      // Update terminal title
      setTerminalTitle(
        `DevLoop: ${activeWorkers.size} active | ${doneTasks.length}/${totalTasks} done`
      );
    }

    // If no active workers (e.g., dry run only), continue
    if (activeWorkers.size === 0) continue;

    // Show spinner for active workers
    const activeNames = [...activeWorkers.keys()].join(', ');
    spinner.start(chalk.cyan(`  Working: ${activeNames} (${activeWorkers.size} active, ${doneTasks.length}/${totalTasks} done)`));
    activeSpinner = spinner;

    // Wait for any worker to complete
    const completed = await Promise.race(
      [...activeWorkers.entries()].map(([taskId, worker]) =>
        worker.promise.then(result => ({ taskId, result }))
      )
    );

    spinner.stop();
    activeSpinner = null;

    // Capture worker start time before removing
    const workerStartTime = activeWorkers.get(completed.taskId)?.startTime ?? Date.now();

    // Remove completed worker
    activeWorkers.delete(completed.taskId);

    // Simulate graceful stop for testing
    if (overrides?.stopAfterIterations !== undefined) {
      const iterationsCompleted = iterationTimings.length + 1;
      if (iterationsCompleted >= overrides.stopAfterIterations) {
        stopRequested = true;
      }
    }

    const result = completed.result;
    const claudeResult = result.claudeResult;
    const duration = formatDuration(Math.round(claudeResult.duration / 1000));

    logger.info(`Worker ${result.taskId} finished: success=${claudeResult.success}, duration=${claudeResult.duration}ms`);

    // Update token tracking
    if (claudeResult.tokenUsage) {
      sessionTokens.input += claudeResult.tokenUsage.inputTokens;
      sessionTokens.output += claudeResult.tokenUsage.outputTokens;
      sessionTokens.cacheWrite += claudeResult.tokenUsage.cacheCreationTokens;
      sessionTokens.cacheRead += claudeResult.tokenUsage.cacheReadTokens;
      sessionTokens.total += claudeResult.tokenUsage.totalTokens;
      sessionCost += claudeResult.tokenUsage.costUsd;

      projectTokens.input += claudeResult.tokenUsage.inputTokens;
      projectTokens.output += claudeResult.tokenUsage.outputTokens;
      projectTokens.cacheWrite += claudeResult.tokenUsage.cacheCreationTokens;
      projectTokens.cacheRead += claudeResult.tokenUsage.cacheReadTokens;
      projectTokens.total += claudeResult.tokenUsage.totalTokens;
      projectCost += claudeResult.tokenUsage.costUsd;
    }

    // Collect timing data
    iterationTimings.push({
      iteration: iterationCounter - 1,
      taskId: result.taskId,
      taskTitle: result.taskTitle,
      durationMs: claudeResult.duration,
      success: claudeResult.success,
      errorType: claudeResult.success ? undefined : claudeResult.errorType
    });

    // Record in progress.md (mutex-protected)
    // Estimate work vs verification timing
    const workerEndTime = workerStartTime + claudeResult.duration;
    const timingSplitForLog = result.verification
      ? estimateWorkVerificationSplit(result.toolEvents, result.verification, workerStartTime, workerEndTime)
      : null;

    const iterationLog: IterationLog = {
      iteration: iterationCounter - 1,
      timestamp: new Date().toISOString(),
      taskAttempted: result.taskId,
      taskCompleted: claudeResult.success ? result.taskId : null,
      summary: claudeResult.success
        ? `Completed ${result.taskTitle}`
        : `Failed: ${claudeResult.error?.split('\n')[0] || 'Unknown error'}`,
      duration,
      exitStatus: claudeResult.success ? 'success' : 'error',
      errorType: claudeResult.success ? undefined : claudeResult.errorType,
      errorDetail: claudeResult.success ? undefined : claudeResult.error,
      tokenUsage: claudeResult.tokenUsage,
      workDuration: timingSplitForLog ? formatDuration(Math.round(timingSplitForLog.workMs / 1000)) : undefined,
      verificationDuration: timingSplitForLog ? formatDuration(Math.round(timingSplitForLog.verifyMs / 1000)) : undefined
    };

    {
      const release = await fileMutex.acquire();
      try {
        const currentTasks = await parseTasks(config.tasksPath);
        await appendIteration(config.progressPath, currentTasks.tasks.length, iterationLog);
      } finally {
        release();
      }
    }

    // Write task log
    const prompt = buildTaskPrompt(
      { id: result.taskId, title: result.taskTitle, description: '', verification: '', status: 'in-progress', dependencies: [] },
      config.requirementsPath, config.tasksPath, config.progressPath,
      result.worktree.worktreePath, { priorDiff: result.priorDiff }
    );
    await writeTaskLog(config.workspacePath, result.taskId, result.taskTitle, iterationCounter - 1, prompt, claudeResult, logger);

    if (claudeResult.success) {
      const tokenInfo = claudeResult.tokenUsage
        ? ` [${claudeResult.tokenUsage.totalTokens.toLocaleString()} tokens]`
        : '';

      // Try to merge if using worktrees
      if (useParallel && result.worktree.branchName) {
        const mergeRelease = await mergeMutex.acquire();
        try {
          // Get the task's verification command for post-merge verification
          const currentTasks = await parseTasks(config.tasksPath);
          const taskDef = currentTasks.tasks.find(t => t.id === result.taskId);
          const verification = taskDef?.verification;

          const mergeResult = await mergeWorktree(
            config.workspacePath, result.worktree, result.taskTitle,
            verification, config.verbose
          );

          if (mergeResult.success) {
            // Mark task done (mutex-protected)
            const release = await fileMutex.acquire();
            let doneCount = 0;
            try {
              await updateTaskStatus(config.tasksPath, result.taskId, 'done');
              const updated = await parseTasks(config.tasksPath);
              doneCount = updated.tasks.filter(t => t.status === 'done').length;
            } finally {
              release();
            }

            spinner.succeed(chalk.green(`  Merged ${result.taskId} (${duration})${tokenInfo} (${doneCount}/${totalTasks} done)`));

            // Clean up
            priorDiffs.delete(result.taskId);
            mergeFailureCounts.delete(result.taskId);

            // Show token info and task stats
            if (claudeResult.tokenUsage) {
              const t = claudeResult.tokenUsage;
              console.log(chalk.gray(`    ${t.totalTokens.toLocaleString()} tokens ($${t.costUsd.toFixed(4)}) | Session: $${sessionCost.toFixed(4)}`));
            }
            const workerEndTime = workerStartTime + claudeResult.duration;
            const timingSplit = displayTaskStats(
              result.toolEvents, result.verification,
              workerStartTime, workerEndTime
            );
          } else {
            // Merge failed — save diff and re-queue
            const failCount = (mergeFailureCounts.get(result.taskId) || 0) + 1;
            mergeFailureCounts.set(result.taskId, failCount);

            const diff = await getWorktreeDiff(config.workspacePath, result.worktree.branchName);
            if (diff) {
              priorDiffs.set(result.taskId, diff);
            }

            const reason = mergeResult.verificationFailed ? 'post-merge verification failed' : 'merge conflict';
            if (failCount >= 2) {
              spinner.fail(chalk.yellow(`  ${result.taskId}: ${reason} (will retry sequentially)`));
            } else {
              spinner.fail(chalk.yellow(`  ${result.taskId}: ${reason} — will re-apply changes (attempt ${failCount}/2)`));
            }

            // Revert task to pending for re-queue (unless it'll be sequential fallback)
            const release = await fileMutex.acquire();
            try {
              await updateTaskStatus(config.tasksPath, result.taskId, 'pending');
            } finally {
              release();
            }
          }
        } finally {
          mergeRelease();
        }

        // Clean up worktree
        await cleanupWorktree(result.worktree, config.workspacePath);

      } else {
        // Sequential mode (no worktree) — commit directly on main
        const release = await fileMutex.acquire();
        let doneCount = 0;
        try {
          await updateTaskStatus(config.tasksPath, result.taskId, 'done');
          const updated = await parseTasks(config.tasksPath);
          doneCount = updated.tasks.filter(t => t.status === 'done').length;
        } finally {
          release();
        }

        spinner.succeed(chalk.green(`  Completed ${result.taskId} (${duration})${tokenInfo} (${doneCount}/${totalTasks} done)`));

        // Show token info and task stats
        if (claudeResult.tokenUsage) {
          const t = claudeResult.tokenUsage;
          console.log(chalk.gray(`    ${t.totalTokens.toLocaleString()} tokens ($${t.costUsd.toFixed(4)}) | Session: $${sessionCost.toFixed(4)}`));
        }
        const workerEndTime = workerStartTime + claudeResult.duration;
        displayTaskStats(result.toolEvents, result.verification, workerStartTime, workerEndTime);

        if (!overrides?.skipGit) {
          const commitResult = await commitIteration(
            config.workspacePath, iterationCounter - 1,
            result.taskId, result.taskTitle, true, config.verbose
          );
          if (commitResult.hookFailure) {
            hookFailureDetected = true;
            console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
          }
        }

        priorDiffs.delete(result.taskId);
        mergeFailureCounts.delete(result.taskId);
      }
    } else {
      // Task failed
      spinner.fail(chalk.red(`  Failed ${result.taskId} - ${claudeResult.error?.split('\n')[0] || 'Unknown error'}`));

      // Check for API error
      if (isApiError(claudeResult.errorType)) {
        logger.error(`API error detected: ${claudeResult.errorType}`);
        console.log(chalk.red.bold('\n⚠ API Error Detected - Stopping DevLoop'));
        console.log(chalk.red(`  Error Type: ${claudeResult.errorType}`));
        apiErrorDetected = true;
      } else {
        console.log(chalk.yellow('  Will retry on next cycle...'));
      }

      // Clean up worktree on failure
      if (useParallel && result.worktree.branchName) {
        await cleanupWorktree(result.worktree, config.workspacePath);
      }
    }

    // Update crash markers
    const remainingTasks: ActiveTask[] = [...activeWorkers.values()].map(w => ({
      taskId: w.task.id,
      taskTitle: w.task.title,
      iterationNumber: iterationCounter,
      startedAt: new Date().toISOString()
    }));
    await setActiveTasks(config.workspacePath, remainingTasks);

    // Update session
    await updateSessionIteration(config.workspacePath, iterationCounter - 1);

    // Check graceful stop
    if (stopRequested) {
      console.log(chalk.yellow('\nStopping as requested.'));
      // Wait for remaining workers
      if (activeWorkers.size > 0) {
        const remaining = await Promise.allSettled(
          [...activeWorkers.values()].map(w => w.promise)
        );
        // Process remaining results (simplified — just mark and clean up)
        for (const settled of remaining) {
          if (settled.status === 'fulfilled') {
            const r = settled.value;
            if (r.claudeResult.success && useParallel && r.worktree.branchName) {
              const mergeRelease = await mergeMutex.acquire();
              try {
                const mr = await mergeWorktree(config.workspacePath, r.worktree, r.taskTitle, undefined, config.verbose);
                if (mr.success) {
                  const release = await fileMutex.acquire();
                  try { await updateTaskStatus(config.tasksPath, r.taskId, 'done'); } finally { release(); }
                  spinner.succeed(chalk.green(`  Merged ${r.taskId} (completed during shutdown)`));
                }
              } finally {
                mergeRelease();
              }
              await cleanupWorktree(r.worktree, config.workspacePath);
            }
            // Update tokens
            if (r.claudeResult.tokenUsage) {
              sessionTokens.total += r.claudeResult.tokenUsage.totalTokens;
              sessionCost += r.claudeResult.tokenUsage.costUsd;
            }
          }
        }
        activeWorkers.clear();
      }
      console.log(chalk.gray('Run "devloop continue" to resume.'));
      break;
    }

    // Small delay to avoid tight loop
    await sleep(500);
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

  // Persist session usage to cumulative project totals
  const successfulTasks = iterationTimings.filter(t => t.success);
  const uniqueCompletedTasks = new Set(successfulTasks.map(t => t.taskId)).size;
  if (sessionTokens.total > 0 || iterationTimings.length > 0) {
    const updatedUsage = await addProjectUsage(
      config.workspacePath,
      sessionTokens,
      sessionCost,
      iterationTimings.length,
      uniqueCompletedTasks
    );

    // Show project lifetime totals
    displayRunStatistics(iterationTimings, sessionTokens, sessionCost, sessionStartTime, finalProgress, finalTaskList);
    if (updatedUsage.totalTokens > sessionTokens.total) {
      // Only show project totals if there's history beyond this session
      console.log(chalk.gray(`  Project lifetime: ${updatedUsage.totalTokens.toLocaleString()} tokens, $${updatedUsage.costUsd.toFixed(4)}, ${updatedUsage.totalIterations} iterations, ${updatedUsage.totalTasksCompleted} tasks completed`));
      console.log();
    }
  } else {
    displayRunStatistics(iterationTimings, sessionTokens, sessionCost, sessionStartTime, finalProgress, finalTaskList);
  }

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

  // Clear any remaining crash markers
  await setActiveTasks(config.workspacePath, []);

  // Run final code review when ALL tasks completed
  if (allTasksComplete || (finalProgress && finalProgress.completed === finalProgress.totalTasks)) {
    await runFinalReview(config, invoke, logger, overrides?.skipGit, overrides?.skipStdin);
  }

  // Show next steps when all tasks are done
  if (allTasksComplete || (finalProgress && finalProgress.completed === finalProgress.totalTasks)) {
    console.log(chalk.green('All tasks complete!'));
    console.log(chalk.cyan('Run "devloop continue" to start the next iteration.'));
    console.log(chalk.gray('Or clean up: rm -rf .devloop .claude'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
