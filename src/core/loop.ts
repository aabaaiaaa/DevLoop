import ora, { Ora } from 'ora';
import chalk from 'chalk';
import { DevLoopConfig, IterationLog } from '../types/index.js';
import { parseRequirements, getNextTask } from '../parser/requirements.js';
import { readProgress, appendIteration, generateProgressContent } from '../parser/progress.js';
import { invokeClaudeAutomated, buildTaskPrompt, isApiError } from './claude.js';
import { createSession, updateSessionPhase, updateSessionIteration } from './session.js';
import { createFeatureSession, updateFeatureSessionIteration } from './feature-session.js';
import { commitIteration, commitInterruptedWork, ensureGitRepo, getUncommittedChanges } from './git.js';
import * as fs from 'fs/promises';

// Graceful shutdown state
let stopRequested = false;
let forceStopRequested = false;

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

// Elapsed time tracker for spinner
function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

// Spinner state for activity updates
interface SpinnerState {
  baseText: string;
  currentActivity: string | null;
  startTime: number;
  interval: NodeJS.Timeout | null;
}

// Start a spinner with elapsed time updates
function startTimedSpinner(spinner: Ora, baseText: string, startTime: number, verbose: boolean, terminalTitle?: string): SpinnerState {
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

function setupGracefulShutdown(): () => void {
  const handler = () => {
    if (forceStopRequested) {
      // Third Ctrl+C - force exit
      console.log(chalk.red('\n\nForce stopping...'));
      process.exit(1);
    } else if (stopRequested) {
      // Second Ctrl+C - warn about force stop
      forceStopRequested = true;
      console.log(chalk.yellow('\nPress Ctrl+C again to force stop immediately.'));
    } else {
      // First Ctrl+C - request graceful stop
      stopRequested = true;
      console.log(chalk.yellow('\n\nGraceful stop requested - will stop after current task completes.'));
      console.log(chalk.gray('Press Ctrl+C again to force stop (may leave work incomplete).'));
    }
  };

  process.on('SIGINT', handler);

  // Return cleanup function
  return () => {
    process.removeListener('SIGINT', handler);
    stopRequested = false;
    forceStopRequested = false;
  };
}

export async function runLoop(config: DevLoopConfig): Promise<void> {
  const spinner = ora();
  const cleanupShutdownHandler = setupGracefulShutdown();

  // Set initial terminal title
  const featurePrefix = config.featureName ? `[${config.featureName}] ` : '';
  setTerminalTitle(`DevLoop: ${featurePrefix}Starting...`);

  console.log(chalk.blue.bold(`\n=== DevLoop Starting ${config.featureName ? `(Feature: ${config.featureName})` : ''} ===\n`));
  console.log(chalk.gray('Tip: Press Ctrl+C to stop after the current task completes.'));
  console.log(chalk.gray(`Workspace: ${config.workspacePath}`));
  if (config.featureName) {
    console.log(chalk.gray(`Feature: ${config.featureName}`));
  }
  console.log(chalk.gray(`Requirements: ${config.requirementsPath}`));
  console.log(chalk.gray(`Progress: ${config.progressPath}`));
  console.log(chalk.gray(`Max iterations: ${config.maxIterations}`));
  if (config.tokenLimit) {
    console.log(chalk.gray(`Token limit: ${config.tokenLimit.toLocaleString()} (per session)`));
  }
  console.log(chalk.green(`Workspace restriction: ENABLED (--add-dir)`));

  if (config.dryRun) {
    console.log(chalk.yellow('DRY RUN MODE - No changes will be made'));
  }

  console.log();

  // Ensure git repo is set up for version control
  const gitSetup = await ensureGitRepo(config.workspacePath, config.verbose);
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
  let hasInterruptedWork = false;
  let interruptedDuringTask = false;  // Track if we interrupted mid-task (for end-of-loop messaging)
  if (gitSetup.gitAvailable) {
    const uncommitted = await getUncommittedChanges(config.workspacePath, ['.devloop/']);
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

  console.log();

  // Create/update session AFTER uncommitted changes check to avoid false positives
  if (config.sessionAction === 'create') {
    await createSession(config.workspacePath, 'run');
    await updateSessionPhase(config.workspacePath, 'run');
  } else if (config.sessionAction === 'update') {
    await updateSessionPhase(config.workspacePath, 'run');
  } else if (config.sessionAction === 'create-feature' && config.featureName) {
    await createFeatureSession(config.workspacePath, config.featureName, 'run');
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

    const iterationStart = new Date();

    // Parse requirements fresh each iteration
    spinner.start(chalk.cyan(`Iteration ${i}: Reading requirements...`));

    let requirements;
    try {
      requirements = await parseRequirements(config.requirementsPath);
    } catch (error) {
      spinner.fail(chalk.red(`Failed to parse requirements: ${error}`));
      break;
    }

    spinner.stop();

    // Check if all tasks are done
    const pendingTasks = requirements.tasks.filter(t => t.status === 'pending');
    const doneTasks = requirements.tasks.filter(t => t.status === 'done');

    if (pendingTasks.length === 0) {
      setTerminalTitle(`DevLoop: ${featurePrefix}All ${doneTasks.length} tasks complete!`);
      console.log(chalk.green.bold('\n✓ All tasks completed!'));
      console.log(chalk.gray(`Completed ${doneTasks.length} tasks in ${i - 1} iterations.`));
      break;
    }

    // Get next task based on dependencies and priority
    const nextTask = getNextTask(requirements);

    if (!nextTask) {
      console.log(chalk.yellow('\nNo available tasks (all remaining tasks have unmet dependencies)'));
      console.log(chalk.gray('Blocked tasks:'));
      for (const task of pendingTasks) {
        console.log(chalk.gray(`  - ${task.id}: depends on ${task.dependencies.join(', ')}`));
      }
      break;
    }

    // Commit interrupted work before starting fresh (only on first iteration)
    if (hasInterruptedWork) {
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
    const totalTasks = requirements.tasks.length;
    const completedTasks = doneTasks.length;
    setTerminalTitle(`DevLoop: ${featurePrefix}${i}/${config.maxIterations} - ${nextTask.id} (${completedTasks}/${totalTasks} done)`);

    console.log(chalk.cyan(`\nIteration ${i}: ${nextTask.id} - ${nextTask.title}`));
    console.log(chalk.gray(`  Priority: ${nextTask.priority}`));
    console.log(chalk.gray(`  Description: ${nextTask.description}`));
    console.log(chalk.gray(`  Press Ctrl+C to stop after this task completes`));

    if (config.dryRun) {
      console.log(chalk.yellow(`  [DRY RUN] Would execute this task`));

      // Record dry run iteration
      const iterationLog: IterationLog = {
        iteration: i,
        timestamp: iterationStart.toISOString(),
        taskCompleted: null,
        summary: `[DRY RUN] Would have executed: ${nextTask.title}`,
        duration: '0s',
        exitStatus: 'partial'
      };

      // Don't actually append to progress in dry run
      continue;
    }

    // Build prompt and invoke Claude with timed spinner
    const taskStartTime = Date.now();
    const currentTitle = `DevLoop: ${i}/${config.maxIterations} - ${nextTask.id} (${completedTasks}/${totalTasks} done)`;
    const spinnerState = startTimedSpinner(
      spinner,
      `  Claude working on ${nextTask.id}`,
      taskStartTime,
      config.verbose,
      currentTitle
    );

    const prompt = buildTaskPrompt(nextTask, config.requirementsPath, config.progressPath, config.workspacePath);
    const result = await invokeClaudeAutomated(prompt, config.workspacePath, {
      verbose: config.verbose,
      onProgress: (activity) => {
        updateSpinnerActivity(spinnerState, activity);
      }
    });

    // Stop the spinner interval
    if (spinnerState.interval) {
      clearInterval(spinnerState.interval);
    }

    // Check if stop was requested during task execution
    // If so, treat as interrupted - do NOT mark as complete even if Claude exited cleanly
    if (stopRequested) {
      if (config.verbose) {
        console.log(chalk.yellow(`  ⚠ Task interrupted by user request`));
      } else {
        spinner.warn(chalk.yellow(`  Task ${nextTask.id} interrupted by user request`));
      }

      const duration = `${Math.round(result.duration / 1000)}s`;

      // Record as interrupted - task was NOT completed
      const iterationLog: IterationLog = {
        iteration: i,
        timestamp: iterationStart.toISOString(),
        taskCompleted: null,  // NOT completed
        summary: `Interrupted: ${nextTask.title} (user requested stop)`,
        duration,
        exitStatus: 'interrupted',
        tokenUsage: result.tokenUsage
      };

      await appendIteration(config.progressPath, requirements.tasks.length, iterationLog);

      // Update session iteration count
      if (config.featureName) {
        await updateFeatureSessionIteration(config.workspacePath, config.featureName, i);
      } else {
        await updateSessionIteration(config.workspacePath, i);
      }

      // Commit the interrupted state (if any changes were made)
      await commitIteration(
        config.workspacePath,
        i,
        null,  // No task completed
        null,
        false, // Not successful
        config.verbose,
        config.featureName
      );

      console.log(chalk.yellow('\nStopping as requested. Task was NOT marked as complete.'));
      console.log(chalk.gray('Run "devloop continue" to resume and retry this task.'));
      interruptedDuringTask = true;
      break;
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

    const duration = `${Math.round(result.duration / 1000)}s`;

    // Record iteration with error details and token usage
    const iterationLog: IterationLog = {
      iteration: i,
      timestamp: iterationStart.toISOString(),
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
    await appendIteration(config.progressPath, requirements.tasks.length, iterationLog);

    // Update session (feature or legacy)
    if (config.featureName) {
      await updateFeatureSessionIteration(config.workspacePath, config.featureName, i);
    } else {
      await updateSessionIteration(config.workspacePath, i);
    }

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
        console.log(chalk.red.bold('\n⚠ API Error Detected - Stopping DevLoop\n'));
        console.log(chalk.red(`  Error Type: ${result.errorType}`));
        console.log(chalk.red(`  Details: ${result.error}`));
        console.log(chalk.yellow('\n  This is an API-level error, not a task failure.'));
        console.log(chalk.yellow('  Please resolve the issue before continuing.\n'));
        break;
      }

      // Task failure - continue to next iteration (future attempt may succeed)
      console.log(chalk.yellow('  Continuing to next task...'));
    }

    // Commit iteration changes to git (if available)
    const commitResult = await commitIteration(
      config.workspacePath,
      i,
      result.success ? nextTask.id : null,
      result.success ? nextTask.title : null,
      result.success,
      config.verbose,
      config.featureName
    );

    // Stop loop if commit failed due to a hook
    if (commitResult.hookFailure) {
      console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
      console.log(chalk.gray('Fix the commit message format and run "devloop run" again.'));
      break;
    }

    // Small delay between iterations to avoid rate limiting
    await sleep(1000);
  }

  // Clean up signal handler
  cleanupShutdownHandler();

  // Final summary
  console.log(chalk.blue.bold('\n=== DevLoop Complete ===\n'));

  const finalProgress = await readProgress(config.progressPath);
  if (finalProgress) {
    const successCount = finalProgress.iterations.filter(i => i.exitStatus === 'success').length;
    console.log(chalk.gray(`Total iterations: ${finalProgress.iterations.length}`));
    console.log(chalk.green(`Successful: ${successCount}`));
    console.log(chalk.red(`Failed: ${finalProgress.iterations.length - successCount}`));
    console.log(chalk.gray(`Tasks completed: ${finalProgress.completed}/${finalProgress.totalTasks}`));

    // Set final terminal title
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

  if (stopRequested && !interruptedDuringTask) {
    // Only show generic message if we stopped between tasks, not mid-task
    // (mid-task interruption already printed detailed messaging)
    console.log(chalk.yellow('\nRun was stopped by user. Use "devloop continue" to resume.'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
