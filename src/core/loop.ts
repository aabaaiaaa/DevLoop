import chalk from 'chalk';
import { createSpinner, Spinner } from './spinner.js';
import { spawn as spawnProcess } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { DevLoopConfig, IterationLog, ActiveTask, Task, Progress, ClaudeErrorType, ToolEvent } from '../types/index.js';
import { parseTasks, getNextTask, getAvailableTasks, updateTaskStatus } from '../parser/tasks.js';
import { readProgress, appendIteration, getCompletedTaskIds } from '../parser/progress.js';
import { invokeClaudeAutomated, buildTaskPrompt, buildBatchPrompt, parseBatchResults, isApiError } from './claude.js';
import { createSession, readSession, writeSession, updateSessionPhase, updateSessionIteration, setActiveTask, getActiveTask } from './session.js';
import { commitIteration, commitInterruptedWork, ensureGitRepo, getUncommittedChanges } from './git.js';
import { readProjectUsage, addProjectUsage } from './config.js';
import { createLogger, Logger } from './logger.js';
import { promptUser, printBanner } from '../commands/shared.js';
import * as fs from 'fs/promises';

// Graceful shutdown state
let stopRequested = false;
let rawModeActive = false;
let activeSpinner: Spinner | null = null;
let inVerificationPhase = false;
let killVerificationProcess: (() => void) | null = null;

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
  console.log(chalk.gray('  Cross-referencing requirements against implementation, reviewing'));
  console.log(chalk.gray('  code quality, test coverage, and generating recommendations.'));
  const spinner = createSpinner();
  const startTime = Date.now();
  const spinnerState = startTimedSpinner(
    spinner,
    '  Reviewing project',
    startTime,
    config.verbose,
    'DevLoop: Final code review'
  );

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
      verbose: config.verbose,
      onProgress: (activity) => { updateSpinnerActivity(spinnerState, activity); }
    });

    if (spinnerState.interval) clearInterval(spinnerState.interval);
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
    if (spinnerState.interval) clearInterval(spinnerState.interval);
    spinner.stop();
    loggerRef.error('Final review failed', err);
    console.log(chalk.yellow('  Review step failed — skipping.'));
  }
}

/**
 * Run consolidated test verification after all tasks complete.
 * Collects all verification commands, consolidates duplicates, runs tests,
 * and fixes failures with up to 3 retry cycles.
 */
async function runDeferredVerification(
  config: DevLoopConfig,
  completedTasks: Task[],
  invoke: typeof invokeClaudeAutomated,
  loggerRef: Logger,
  skipGit?: boolean
): Promise<boolean> {
  const logPath = path.join(config.workspacePath, '.devloop', 'logs', 'VERIFICATION.log');

  console.log(chalk.cyan(`\nRunning consolidated test verification (${completedTasks.length} tasks)...`));
  console.log(chalk.gray('  Verification criteria to consolidate:'));
  for (const t of completedTasks) {
    console.log(chalk.gray(`    ${t.id}: ${t.verification}`));
  }
  console.log(chalk.gray('  Claude will consolidate overlapping test commands into the minimum'));
  console.log(chalk.gray('  number of suite runs, then fix and retest any failures.'));
  if (rawModeActive) {
    console.log(chalk.yellow('  Press Q to skip verification and proceed to review.'));
  } else {
    console.log(chalk.yellow('  Type q + Enter to skip verification and proceed to review.'));
  }
  // Reset stopRequested so we can detect Q presses during verification
  stopRequested = false;
  inVerificationPhase = true;
  const spinner = createSpinner();
  const startTime = Date.now();
  const spinnerState = startTimedSpinner(
    spinner,
    '  Verifying all tasks',
    startTime,
    config.verbose,
    'DevLoop: Verifying all tasks'
  );
  activeSpinner = spinner;

  const taskList = completedTasks.map(t =>
    `### ${t.id}: ${t.title}\n- Description: ${t.description}\n- Verification: ${t.verification}`
  ).join('\n\n');

  const prompt = `You are performing consolidated test verification for a completed development project.
Type-checking and linting were already done per-task. Your job is to run the TEST SUITES.

WORKSPACE RESTRICTION:
You are ONLY allowed to work within: ${config.workspacePath}
- Do NOT read, write, or modify any files outside this directory
- Do NOT run commands that affect files outside this directory
- All file paths must be within the workspace
- Do NOT modify any files in .devloop/ or .claude/ directories

CONTEXT FILES:
1. READ the full requirements document at: ${config.requirementsPath}
2. The task list at ${config.tasksPath} contains all tasks.
3. READ the progress file at: ${config.progressPath} (if it exists)

COMPLETED TASKS AND THEIR VERIFICATION CRITERIA:

${taskList}

STEP 1 — CONSOLIDATE TEST COMMANDS:
Look at all the verification commands above. Many tasks target the SAME test suite
with different filters (e.g., \`npm test -- --grep "calculator"\`, \`npm test -- --grep "parser"\`).
Instead of running each filtered command separately, consolidate them:
- Multiple \`npm test -- --grep X\` commands → run \`npm test\` ONCE (full suite)
- Multiple \`npx jest src/foo.test.ts\` commands → run \`npx jest\` ONCE (full suite)
- Multiple \`pytest tests/foo/\` commands → run \`pytest\` ONCE
- Different test runners (npm test + pytest) → run each runner once
The goal is the MINIMUM number of test suite executions that covers all verifications.

EXCEPTION for long-running E2E/integration test suites (Playwright, Cypress, Selenium, etc.):
Do NOT consolidate these into a full suite run. Instead, run only the specific E2E test
files that cover functionality changed by the completed tasks. Full E2E suites can take
30+ minutes — only run the full E2E suite if a task's verification explicitly requires it.

STEP 2 — RUN THE CONSOLIDATED TESTS:
Run each consolidated test command. Record which tests pass and which fail.

STEP 3 — FIX FAILURES (if any):
If tests fail:
  a. Use the task descriptions above to identify which task's changes likely caused each failure
  b. Fix the issue in the relevant code
  c. Re-run ONLY the specific failing tests (not the full suite again)
  d. Repeat up to 3 fix cycles
  e. A single fix may resolve multiple failures — that's fine

IMPORTANT:
- You may modify source code to fix test failures
- Do NOT modify any files in .devloop/ or .claude/ directories
- If you cannot fix a failure after 3 attempts, report which tests still fail and why

STEP 4 — SUMMARY:
Report:
- Which consolidated test commands were run
- Initial results (pass/fail counts)
- What fixes were applied and which tasks they related to
- What retries were performed and their outcomes
- Any remaining failures`;

  try {
    const result = await invoke(prompt, config.workspacePath, {
      verbose: config.verbose,
      onProgress: (activity) => { updateSpinnerActivity(spinnerState, activity); },
      onSpawn: (kill) => { killVerificationProcess = kill; },
      taskTimeout: config.taskTimeout
    });

    if (spinnerState.interval) clearInterval(spinnerState.interval);
    spinner.stop();
    activeSpinner = null;
    killVerificationProcess = null;

    const duration = formatDuration(Math.round(result.duration / 1000));
    inVerificationPhase = false;
    const wasSkipped = stopRequested;
    stopRequested = false; // Reset so it doesn't affect the rest of the flow

    // User pressed Q during verification — treat as skipped
    if (wasSkipped) {
      console.log(chalk.yellow(`  Verification skipped by user (${duration})`));

      // Log the skip to progress.md
      const skipLog: IterationLog = {
        iteration: 0,
        timestamp: new Date().toISOString(),
        taskAttempted: 'VERIFICATION',
        taskCompleted: null,
        summary: 'Consolidated verification skipped by user',
        duration,
        exitStatus: 'success',
        tokenUsage: result.tokenUsage
      };
      try {
        const tasks = await parseTasks(config.tasksPath);
        await appendIteration(config.progressPath, tasks.tasks.length, skipLog);
      } catch {}

      return true; // Treat as passed — don't block review or report incomplete
    }

    // Write verification log
    await writeTaskLog(config.workspacePath, 'VERIFICATION', 'Consolidated test verification', 0, prompt, result, loggerRef);

    // Log to progress.md
    const iterationLog: IterationLog = {
      iteration: 0,
      timestamp: new Date().toISOString(),
      taskAttempted: 'VERIFICATION',
      taskCompleted: null,  // Not a real task — don't count in completed tally
      summary: result.success
        ? 'Consolidated verification passed'
        : `Consolidated verification failed: ${result.error?.split('\n')[0] || 'Tests did not pass'}`,
      duration,
      exitStatus: result.success ? 'success' : 'error',
      tokenUsage: result.tokenUsage
    };

    try {
      const tasks = await parseTasks(config.tasksPath);
      await appendIteration(config.progressPath, tasks.tasks.length, iterationLog);
    } catch {
      // Best effort progress logging
    }

    if (result.success) {
      console.log(chalk.green(`  Verification passed (${duration})`));
      if (result.tokenUsage) {
        console.log(chalk.gray(`    ${result.tokenUsage.totalTokens.toLocaleString()} tokens ($${result.tokenUsage.costUsd.toFixed(4)})`));
      }

      // Commit any fixes made during verification
      if (!skipGit) {
        await commitIteration(config.workspacePath, 0, 'VERIFICATION', 'Verification fixes', true, config.verbose);
      }

      return true;
    } else {
      console.log(chalk.red(`  Verification failed (${duration})`));
      console.log(chalk.gray(`  Log: ${logPath}`));
      if (result.output) {
        // Print the last few lines of output as a summary
        const lines = result.output.trim().split('\n');
        const summary = lines.slice(-5).join('\n');
        console.log(chalk.gray(summary));
      }
      return false;
    }
  } catch (err) {
    inVerificationPhase = false;
    stopRequested = false;
    killVerificationProcess = null;
    if (spinnerState.interval) clearInterval(spinnerState.interval);
    spinner.stop();
    activeSpinner = null;
    loggerRef.error('Consolidated verification failed', err);
    console.log(chalk.yellow('  Verification step failed — skipping.'));
    return false;
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
      if (inVerificationPhase) {
        // During verification, Q is a one-way skip (kills processes, can't undo)
        if (!stopRequested) {
          stopRequested = true;
          if (killVerificationProcess) killVerificationProcess();
          const message = 'Skipping verification — killing test processes and proceeding to review.';
          if (activeSpinner && activeSpinner.isSpinning) {
            activeSpinner.stopAndPersist({ symbol: chalk.yellow('>>'), text: chalk.yellow(message) });
            activeSpinner.start(activeSpinner.text);
          } else {
            console.log(chalk.yellow(`\n>> ${message}`));
          }
        }
      } else {
        // During tasks, Q toggles stop on/off
        stopRequested = !stopRequested;
        const message = stopRequested
          ? 'Graceful stop requested - will stop after current task/batch completes. Press Q again to cancel.'
          : 'Stop cancelled - will continue after current task/batch completes.';
        const symbol = stopRequested ? chalk.yellow('>>') : chalk.green('>>');
        const color = stopRequested ? chalk.yellow : chalk.green;
        if (activeSpinner && activeSpinner.isSpinning) {
          activeSpinner.stopAndPersist({ symbol, text: color(message) });
          activeSpinner.start(activeSpinner.text);
        } else {
          console.log(color(`\n>> ${message}`));
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
    console.log(chalk.yellow('Tip: Press Q to stop after the current task completes (press again to cancel).'));
  } else {
    console.log(chalk.yellow('Tip: Type q + Enter to stop after the current task completes (again to cancel).'));
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
  if (config.taskTimeout) {
    console.log(chalk.gray(`Task timeout: ${formatDuration(config.taskTimeout / 1000)}`));
  }
  console.log(chalk.gray(`Verification: ${config.verifyEachTask ? 'per-task' : 'consolidated (tests run after all tasks)'}`));
  if (config.maxParallelTasks && config.maxParallelTasks > 1) {
    console.log(chalk.gray(`Parallel tasks: up to ${config.maxParallelTasks} per batch`));
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
    // Preserve the iteration number from the existing session (set during archive flow)
    const existingSession = await readSession(config.workspacePath);
    await createSession(config.workspacePath, 'run', existingSession?.iteration);
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

    if (doneTasks.length === totalTasks) {
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

    // Find available tasks
    const availableTasks = getAvailableTasks(taskList, new Set());
    const maxParallel = config.maxParallelTasks ?? 5;

    if (availableTasks.length === 0) {
      const pendingTasks = taskList.tasks.filter(t => t.status === 'pending');
      if (pendingTasks.length > 0) {
        console.log(chalk.yellow('\nNo available tasks (all remaining tasks have unmet dependencies)'));
        console.log(chalk.gray('Blocked tasks:'));
        for (const t of pendingTasks) {
          console.log(chalk.gray(`  - ${t.id}: depends on ${t.dependencies.join(', ')}`));
        }
      }
      break;
    }

    if (config.dryRun) {
      for (const t of availableTasks.slice(0, maxParallel)) {
        console.log(chalk.yellow(`  [DRY RUN] Would execute ${t.id}: ${t.title}`));
      }
      iterationCounter++;
      continue;
    }

    // Decide: batch execution (2+ tasks, parallel enabled) or single-task
    const useBatch = availableTasks.length >= 2 && maxParallel >= 2;
    const batch = useBatch ? availableTasks.slice(0, maxParallel) : null;
    const task = useBatch ? null : availableTasks[0];

    if (batch) {
      // === BATCH EXECUTION PATH ===
      const taskIteration = iterationCounter;
      iterationCounter++;
      const batchIds = batch.map(t => t.id);
      const batchLabel = batchIds.join(', ');

      // Mark all batch tasks as in-progress
      for (const t of batch) {
        await updateTaskStatus(config.tasksPath, t.id, 'in-progress');
      }

      logger.info(`Starting batch: ${batchLabel} (iteration ${taskIteration})`);
      console.log(chalk.cyan(`\n  Batch: ${batch.length} tasks in parallel (${doneTasks.length}/${totalTasks} done)`));
      for (const t of batch) {
        console.log(chalk.cyan(`    ${t.id}: ${t.title}`));
        console.log(chalk.gray(`      Description: ${t.description}`));
        console.log(chalk.gray(`      Verification: ${t.verification}`));
      }
      if (rawModeActive) {
        console.log(chalk.yellow(`    Press Q to stop after this batch completes.`));
      }

      // Set crash marker with first task in batch
      await setActiveTask(config.workspacePath, {
        taskId: batchIds[0],
        taskTitle: `Batch: ${batchLabel}`,
        iterationNumber: taskIteration,
        startedAt: new Date().toISOString()
      });

      // Build batch prompt and invoke
      const batchStartTime = Date.now();
      const batchPrompt = buildBatchPrompt(
        batch, config.requirementsPath, config.tasksPath, config.progressPath,
        config.workspacePath, config.verifyEachTask ?? false
      );

      const termTitle = `DevLoop: Batch (${batch.length} tasks) | ${doneTasks.length}/${totalTasks} done`;
      const spinnerState = startTimedSpinner(
        spinner,
        `  Batch: ${batch.length} tasks (${doneTasks.length}/${totalTasks} done)`,
        batchStartTime,
        config.verbose,
        termTitle
      );
      activeSpinner = spinner;

      const batchToolEvents: ToolEvent[] = [];
      let claudeResult;
      try {
        claudeResult = await invoke(batchPrompt, config.workspacePath, {
          verbose: config.verbose,
          onProgress: (activity) => { updateSpinnerActivity(spinnerState, activity); },
          onToolCall: (event) => { batchToolEvents.push(event); },
          taskTimeout: config.taskTimeout
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        claudeResult = {
          success: false,
          output: '',
          rawOutput: '',
          error: errorMessage,
          errorType: 'unknown' as ClaudeErrorType,
          duration: Date.now() - batchStartTime
        };
      }

      if (spinnerState.interval) clearInterval(spinnerState.interval);
      spinner.stop();
      activeSpinner = null;

      if (!overrides?.skipStdin) ensureStdinListening();

      // Simulate graceful stop for testing
      if (overrides?.stopAfterIterations !== undefined) {
        const iterationsCompleted = iterationTimings.length + 1;
        if (iterationsCompleted >= overrides.stopAfterIterations) {
          stopRequested = true;
        }
      }

      const duration = formatDuration(Math.round(claudeResult.duration / 1000));

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

      // Check for API error on the entire batch invocation
      if (!claudeResult.success && isApiError(claudeResult.errorType)) {
        logger.error(`API error during batch: ${claudeResult.errorType}`);
        spinner.fail(chalk.red(`  Batch failed - ${claudeResult.error?.split('\n')[0] || 'Unknown error'}`));
        console.log(chalk.red.bold('\n⚠ API Error Detected - Stopping DevLoop'));
        console.log(chalk.red(`  Error Type: ${claudeResult.errorType}`));
        apiErrorDetected = true;

        // Log batch failure
        iterationTimings.push({
          iteration: taskIteration,
          taskId: batchIds[0],
          taskTitle: `Batch: ${batchLabel}`,
          durationMs: claudeResult.duration,
          success: false,
          errorType: claudeResult.errorType
        });
      } else {
        // Parse per-task results from Claude's output
        const batchResults = parseBatchResults(claudeResult.output || '', batchIds);
        const succeededIds: string[] = [];
        const failedIds: string[] = [];

        for (const t of batch) {
          const result = batchResults.get(t.id);
          if (result?.success) {
            await updateTaskStatus(config.tasksPath, t.id, 'done');
            succeededIds.push(t.id);
            console.log(chalk.green(`  ✓ ${t.id}: ${t.title}`));
          } else {
            // Leave in-progress for retry
            failedIds.push(t.id);
            console.log(chalk.red(`  ✗ ${t.id}: ${result?.error || 'No result reported'}`));
          }
        }

        const updated = await parseTasks(config.tasksPath);
        const doneCount = updated.tasks.filter(t => t.status === 'done').length;
        const tokenInfo = claudeResult.tokenUsage
          ? ` [${claudeResult.tokenUsage.totalTokens.toLocaleString()} tokens]`
          : '';
        console.log(chalk.cyan(`  Batch: ${succeededIds.length}/${batch.length} succeeded (${duration})${tokenInfo} (${doneCount}/${totalTasks} done)`));

        if (claudeResult.tokenUsage) {
          const t = claudeResult.tokenUsage;
          console.log(chalk.gray(`    ${t.totalTokens.toLocaleString()} tokens ($${t.costUsd.toFixed(4)}) | Session: $${sessionCost.toFixed(4)}`));
        }
        displayTaskStats(batchToolEvents, undefined, batchStartTime, batchStartTime + claudeResult.duration);

        // Collect timing data (one entry per batch)
        iterationTimings.push({
          iteration: taskIteration,
          taskId: batchIds[0],
          taskTitle: `Batch: ${batchLabel} (${succeededIds.length}/${batch.length})`,
          durationMs: claudeResult.duration,
          success: succeededIds.length > 0,
          errorType: succeededIds.length === 0 ? 'task_failure' : undefined
        });

        // Log to progress.md
        const iterationLog: IterationLog = {
          iteration: taskIteration,
          timestamp: new Date().toISOString(),
          taskAttempted: batchLabel,
          taskCompleted: succeededIds.length > 0 ? succeededIds.join(', ') : null,
          summary: `Batch: ${succeededIds.length}/${batch.length} succeeded`,
          duration,
          exitStatus: succeededIds.length > 0 ? 'success' : 'error',
          tokenUsage: claudeResult.tokenUsage
        };

        try {
          await appendIteration(config.progressPath, totalTasks, iterationLog);
        } catch {
          // Best effort
        }

        // Write batch log
        await writeTaskLog(config.workspacePath, `BATCH-${taskIteration}`, `Batch: ${batchLabel}`, taskIteration, batchPrompt, claudeResult, logger);

        // Commit all batch changes at once
        if (!overrides?.skipGit && succeededIds.length > 0) {
          const commitAction = succeededIds.length === batch.length
            ? `Complete batch: ${batchLabel}`
            : `Partial batch: ${succeededIds.join(', ')} succeeded`;
          const commitResult = await commitIteration(
            config.workspacePath, taskIteration,
            batchIds[0], commitAction, true, config.verbose
          );
          if (commitResult.hookFailure) {
            hookFailureDetected = true;
            console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
          }
        }

        if (failedIds.length > 0 && succeededIds.length === 0) {
          console.log(chalk.yellow('  All tasks in batch failed. Will retry on next cycle...'));
        }
      }

      // Clear crash marker and update session
      await setActiveTask(config.workspacePath, null);
      await updateSessionIteration(config.workspacePath, taskIteration);

    } else if (task) {
      // === SINGLE TASK EXECUTION PATH (existing behavior) ===
      const isRetry = task.status === 'in-progress';
      const taskIteration = iterationCounter;
      iterationCounter++;

      // Mark task as in-progress
      await updateTaskStatus(config.tasksPath, task.id, 'in-progress');

      logger.info(`Starting ${task.id} - ${task.title} (iteration ${taskIteration})`);
      console.log(chalk.cyan(`\n  Starting ${task.id}: ${task.title} (${doneTasks.length}/${totalTasks} done)`));
      console.log(chalk.gray(`    Description: ${task.description}`));
      console.log(chalk.gray(`    Verification: ${task.verification}`));
      if (rawModeActive) {
        console.log(chalk.yellow(`    Press Q to stop after this task completes.`));
      }

      // Set crash marker
      await setActiveTask(config.workspacePath, {
        taskId: task.id,
        taskTitle: task.title,
        iterationNumber: taskIteration,
        startedAt: new Date().toISOString()
      });

      // Build prompt and invoke Claude
      const taskStartTime = Date.now();
      const toolEvents: ToolEvent[] = [];

      const prompt = buildTaskPrompt(
        task, config.requirementsPath, config.tasksPath, config.progressPath,
        config.workspacePath, isRetry, config.verifyEachTask ?? false
      );

      // Show spinner with elapsed time
      const termTitle = `DevLoop: ${task.id} | ${doneTasks.length}/${totalTasks} done`;
      const spinnerState = startTimedSpinner(
        spinner,
        `  Working: ${task.id} (${doneTasks.length}/${totalTasks} done)`,
        taskStartTime,
        config.verbose,
        termTitle
      );
      activeSpinner = spinner;

      let claudeResult;
      try {
        claudeResult = await invoke(prompt, config.workspacePath, {
          verbose: config.verbose,
          onProgress: (activity) => { updateSpinnerActivity(spinnerState, activity); },
          onToolCall: (event) => { toolEvents.push(event); },
          taskTimeout: config.taskTimeout
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        claudeResult = {
          success: false,
          output: '',
          rawOutput: '',
          error: errorMessage,
          errorType: 'unknown' as ClaudeErrorType,
          duration: Date.now() - taskStartTime
        };
      }

      if (spinnerState.interval) clearInterval(spinnerState.interval);
      spinner.stop();
      activeSpinner = null;

      // Re-enable raw mode after child process
      if (!overrides?.skipStdin) ensureStdinListening();

      // Simulate graceful stop for testing
      if (overrides?.stopAfterIterations !== undefined) {
        const iterationsCompleted = iterationTimings.length + 1;
        if (iterationsCompleted >= overrides.stopAfterIterations) {
          stopRequested = true;
        }
      }

      const duration = formatDuration(Math.round(claudeResult.duration / 1000));

      logger.info(`${task.id} finished: success=${claudeResult.success}, duration=${claudeResult.duration}ms`);

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
        iteration: taskIteration,
        taskId: task.id,
        taskTitle: task.title,
        durationMs: claudeResult.duration,
        success: claudeResult.success,
        errorType: claudeResult.success ? undefined : claudeResult.errorType
      });

      // Record in progress.md
      const taskEndTime = taskStartTime + claudeResult.duration;
      const timingSplitForLog = (task.verification && config.verifyEachTask)
        ? estimateWorkVerificationSplit(toolEvents, task.verification, taskStartTime, taskEndTime)
        : null;

      const iterationLog: IterationLog = {
        iteration: taskIteration,
        timestamp: new Date().toISOString(),
        taskAttempted: task.id,
        taskCompleted: claudeResult.success ? task.id : null,
        summary: claudeResult.success
          ? `Completed ${task.title}`
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
        const currentTasks = await parseTasks(config.tasksPath);
        await appendIteration(config.progressPath, currentTasks.tasks.length, iterationLog);
      }

      // Write task log
      const logPrompt = buildTaskPrompt(
        { id: task.id, title: task.title, description: '', verification: '', status: 'in-progress', dependencies: [] },
        config.requirementsPath, config.tasksPath, config.progressPath,
        config.workspacePath, false
      );
      await writeTaskLog(config.workspacePath, task.id, task.title, taskIteration, logPrompt, claudeResult, logger);

      if (claudeResult.success) {
        const tokenInfo = claudeResult.tokenUsage
          ? ` [${claudeResult.tokenUsage.totalTokens.toLocaleString()} tokens]`
          : '';

        // Mark task done and commit
        await updateTaskStatus(config.tasksPath, task.id, 'done');
        const updated = await parseTasks(config.tasksPath);
        const doneCount = updated.tasks.filter(t => t.status === 'done').length;

        spinner.succeed(chalk.green(`  Completed ${task.id} (${duration})${tokenInfo} (${doneCount}/${totalTasks} done)`));

        // Show token info and task stats
        if (claudeResult.tokenUsage) {
          const t = claudeResult.tokenUsage;
          console.log(chalk.gray(`    ${t.totalTokens.toLocaleString()} tokens ($${t.costUsd.toFixed(4)}) | Session: $${sessionCost.toFixed(4)}`));
        }
        displayTaskStats(toolEvents, config.verifyEachTask ? task.verification : undefined, taskStartTime, taskEndTime);

        if (!overrides?.skipGit) {
          const commitResult = await commitIteration(
            config.workspacePath, taskIteration,
            task.id, task.title, true, config.verbose
          );
          if (commitResult.hookFailure) {
            hookFailureDetected = true;
            console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
          }
        }
      } else {
        // Task failed
        spinner.fail(chalk.red(`  Failed ${task.id} - ${claudeResult.error?.split('\n')[0] || 'Unknown error'}`));

        // Check for API error
        if (isApiError(claudeResult.errorType)) {
          logger.error(`API error detected: ${claudeResult.errorType}`);
          console.log(chalk.red.bold('\n⚠ API Error Detected - Stopping DevLoop'));
          console.log(chalk.red(`  Error Type: ${claudeResult.errorType}`));
          apiErrorDetected = true;
        } else {
          console.log(chalk.yellow('  Will retry on next cycle...'));
        }
      }

      // Clear crash marker
      await setActiveTask(config.workspacePath, null);

      // Update session
      await updateSessionIteration(config.workspacePath, taskIteration);
    }

    // Check graceful stop
    if (stopRequested) {
      console.log(chalk.yellow('\nStopping as requested.'));
      console.log(chalk.gray('Run "devloop continue" to resume.'));
      break;
    }

    // Check if loop will continue before sleeping
    if (apiErrorDetected || hookFailureDetected) break;

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

  // Clear crash marker
  await setActiveTask(config.workspacePath, null);

  // Run consolidated verification and final review when ALL tasks completed
  const allComplete = allTasksComplete || (finalProgress != null && finalProgress.completed === finalProgress.totalTasks);
  if (allComplete) {
    let verificationPassed = true;

    // Run consolidated verification unless per-task verification was used
    if (!config.verifyEachTask) {
      const completedTasks = finalTaskList?.filter(t => t.status === 'done' && t.verification) ?? [];
      if (completedTasks.length > 0) {
        verificationPassed = await runDeferredVerification(
          config, completedTasks, invoke, logger, overrides?.skipGit
        );
        if (!verificationPassed) {
          console.log(chalk.yellow('Skipping final review — verification did not pass.'));
          console.log(chalk.cyan('Run "devloop continue" to retry.'));
        }
      }
    }

    // Final review only if verification passed (or per-task verification was used)
    if (config.verifyEachTask || verificationPassed) {
      await runFinalReview(config, invoke, logger, overrides?.skipGit, overrides?.skipStdin);
    }
  }

  // Show next steps when all tasks are done
  if (allComplete) {
    console.log(chalk.green('All tasks complete!'));
    console.log(chalk.cyan('Run "devloop continue" to start the next iteration.'));
    console.log(chalk.gray('Or clean up: "devloop continue" → Remove all DevLoop files'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
