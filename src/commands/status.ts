import * as fs from 'fs/promises';
import chalk from 'chalk';
import { printBanner } from './shared.js';
import { resolveWorkspace, getRequirementsPath, getTasksPath, getProgressPath, readWorkspaceConfig } from '../core/config.js';
import { readSession } from '../core/session.js';
import { parseTasks, getNextTask, getAvailableTasks } from '../parser/tasks.js';
import { readProgress } from '../parser/progress.js';
import { getUncommittedChanges, getUncommittedDiff } from '../core/git.js';
import { getArchivedIterations } from '../core/archive.js';
import { getVersion } from '../core/version.js';

interface StatusOptions {
  workspace?: string;
  json?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const workspace = await resolveWorkspace(options.workspace);

  const requirementsPath = getRequirementsPath(workspace);
  const tasksPath = getTasksPath(workspace);
  const progressPath = getProgressPath(workspace);

  try {
    await fs.access(tasksPath);
  } catch {
    console.log(chalk.red('Error: .devloop/tasks.md not found.'));
    console.log(chalk.gray(`Expected at: ${tasksPath}`));
    console.log(chalk.gray('Run "devloop init" to create one.'));
    return;
  }

  try {
    const taskList = await parseTasks(tasksPath);
    const progress = await readProgress(progressPath);
    const session = await readSession(workspace);

    const pending = taskList.tasks.filter(t => t.status === 'pending');
    const inProgress = taskList.tasks.filter(t => t.status === 'in-progress');
    const done = taskList.tasks.filter(t => t.status === 'done');
    const nextTask = getNextTask(taskList);

    // Check for uncommitted changes (filter DevLoop's own files, same as run loop)
    const uncommitted = await getUncommittedChanges(workspace, ['.devloop/', '.claude/']);

    const iterationNum = session?.iteration || 1;
    const archived = await getArchivedIterations(workspace);

    if (options.json) {
      console.log(JSON.stringify({
        devloopVersion: getVersion(),
        workspace,
        project: taskList.projectName,
        iteration: iterationNum,
        archivedIterations: archived.length,
        total: taskList.tasks.length,
        pending: pending.length,
        inProgress: inProgress.length,
        done: done.length,
        nextTask: nextTask?.id || null,
        iterations: progress?.iterations.length || 0,
        phase: session?.phase || null,
        uncommittedChanges: uncommitted.hasChanges ? uncommitted.files : null
      }, null, 2));
      return;
    }

    const projectNameHasIteration = /iteration|phase/i.test(taskList.projectName);
    const iterationLabel = (iterationNum > 1 && !projectNameHasIteration) ? ` - Phase ${iterationNum}` : '';
    printBanner(`${taskList.projectName}${iterationLabel}`);
    console.log(chalk.gray(`Workspace: ${workspace}`));

    if (session) {
      console.log(chalk.gray(`Phase: ${session.phase}`));
      console.log(chalk.gray(`Session created with: ${session.devloopVersion ? `v${session.devloopVersion}` : 'unknown (pre-3.0)'}`));
    }
    if (archived.length > 0) {
      console.log(chalk.gray(`Phase: ${iterationNum} (${archived.length} previous phase(s) archived)`));
    }

    console.log();
    console.log(chalk.white('Progress:'));
    console.log(chalk.gray(`  Total tasks:    ${taskList.tasks.length}`));
    console.log(chalk.green(`  Completed:      ${done.length}`));
    console.log(chalk.yellow(`  In Progress:    ${inProgress.length}`));
    console.log(chalk.gray(`  Pending:        ${pending.length}`));

    if (progress) {
      console.log(chalk.gray(`  Task attempts:  ${progress.iterations.length}`));

      // Calculate cumulative token usage
      let totalTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
      let totalCost = 0;
      for (const iter of progress.iterations) {
        if (iter.tokenUsage) {
          totalTokens.input += iter.tokenUsage.inputTokens;
          totalTokens.output += iter.tokenUsage.outputTokens;
          totalTokens.cacheWrite += iter.tokenUsage.cacheCreationTokens;
          totalTokens.cacheRead += iter.tokenUsage.cacheReadTokens;
          totalTokens.total += iter.tokenUsage.totalTokens;
          totalCost += iter.tokenUsage.costUsd;
        }
      }
      if (totalTokens.total > 0) {
        const pricePerM = totalTokens.total > 0 ? ((totalCost / totalTokens.total) * 1_000_000).toFixed(2) : '0.00';
        console.log(chalk.gray(`  Total tokens:   ${totalTokens.total.toLocaleString()}`));
        console.log(chalk.gray(`    Input:        ${totalTokens.input.toLocaleString()}`));
        console.log(chalk.gray(`    Output:       ${totalTokens.output.toLocaleString()}`));
        console.log(chalk.gray(`    Cache write:  ${totalTokens.cacheWrite.toLocaleString()}`));
        console.log(chalk.gray(`    Cache read:   ${totalTokens.cacheRead.toLocaleString()}`));
        console.log(chalk.gray(`  Total cost:     $${totalCost.toFixed(4)} (~$${pricePerM}/M)`));
      }

      // Check if last iteration failed and show details
      const lastIteration = progress.iterations[progress.iterations.length - 1];
      if (lastIteration && lastIteration.exitStatus === 'error') {
        console.log(chalk.red.bold('\n⚠ Last Iteration Failed:'));
        console.log(chalk.red(`  Iteration: ${lastIteration.iteration}`));
        console.log(chalk.red(`  Time: ${lastIteration.timestamp}`));
        if (lastIteration.errorType) {
          console.log(chalk.red(`  Error Type: ${lastIteration.errorType}`));
        }
        console.log(chalk.red(`  Summary: ${lastIteration.summary}`));
        if (lastIteration.errorDetail) {
          console.log(chalk.red('  Error Detail:'));
          // Show first few lines of error detail, indented
          const detailLines = lastIteration.errorDetail.split('\n').slice(0, 10);
          for (const line of detailLines) {
            console.log(chalk.gray(`    ${line}`));
          }
          if (lastIteration.errorDetail.split('\n').length > 10) {
            console.log(chalk.gray(`    ... (see ${progressPath} for full details)`));
          }
        }
      }
    }

    // Show uncommitted changes warning
    if (uncommitted.hasChanges) {
      console.log(chalk.yellow.bold('\n⚠ Uncommitted Changes Detected:'));
      console.log(chalk.gray('  These will be committed before the next run starts.'));
      for (const file of uncommitted.files.slice(0, 15)) {
        console.log(chalk.yellow(`    - ${file}`));
      }
      if (uncommitted.files.length > 15) {
        console.log(chalk.gray(`    ... and ${uncommitted.files.length - 15} more files`));
      }
      // Show diff summary
      const diffSummary = await getUncommittedDiff(workspace);
      if (diffSummary) {
        console.log(chalk.gray('\n  Diff summary:'));
        const diffLines = diffSummary.split('\n').slice(0, 10);
        for (const line of diffLines) {
          console.log(chalk.gray(`    ${line}`));
        }
        if (diffSummary.split('\n').length > 10) {
          console.log(chalk.gray('    ...'));
        }
      }
    }

    // Show task list
    console.log(chalk.white('\nTasks:'));
    for (const task of taskList.tasks) {
      const statusIcon = task.status === 'done' ? chalk.green('✓') :
        task.status === 'in-progress' ? chalk.yellow('●') :
          chalk.gray('○');
      const statusColor = task.status === 'done' ? chalk.green :
        task.status === 'in-progress' ? chalk.yellow :
          chalk.gray;
      console.log(`  ${statusIcon} ${statusColor(task.id)}: ${task.title}`);
    }

    if (pending.length === 0 && inProgress.length === 0) {
      console.log(chalk.green('\nAll tasks complete!'));
    } else {
      // Build execution plan showing dependency levels
      const wsConfig = await readWorkspaceConfig(workspace);
      const maxParallel = wsConfig.maxParallelTasks ? parseInt(String(wsConfig.maxParallelTasks), 10) || 5 : 5;
      const remaining = taskList.tasks.filter(t => t.status !== 'done');

      if (remaining.length > 0) {
        console.log(chalk.white('\nExecution plan:'));

        // Simulate execution levels by walking the dependency graph
        const simDone = new Set(done.map(t => t.id));
        const simRemaining = [...remaining];
        let level = 1;

        while (simRemaining.length > 0) {
          // Find tasks whose dependencies are all in simDone
          const eligible = simRemaining.filter(t =>
            t.dependencies.every(dep => dep === 'none' || simDone.has(dep))
          );

          if (eligible.length === 0) {
            // Remaining tasks have unmet dependencies that can't be resolved
            for (const t of simRemaining) {
              const unmet = t.dependencies.filter(dep => dep !== 'none' && !simDone.has(dep));
              console.log(chalk.red(`  ✗ ${t.id}: ${t.title}  (blocked: ${unmet.join(', ')})`));
            }
            break;
          }

          const batch = eligible.slice(0, maxParallel);
          const isBatch = batch.length >= 2;
          const isNext = level === 1;
          const levelLabel = isNext ? 'next' : 'then';
          const labelColor = isNext ? chalk.cyan.bold : chalk.gray;
          const taskColor = isNext ? chalk.white : chalk.gray;
          const iconStr = isNext ? chalk.cyan.bold('→') : chalk.gray('→');

          if (isBatch) {
            console.log(labelColor(`  ${levelLabel}: batch (${batch.length} tasks in parallel)`));
            for (const t of batch) {
              const icon = t.status === 'in-progress' ? chalk.yellow('●') : iconStr;
              console.log(taskColor(`    ${icon} ${t.id}: ${t.title}`));
            }
          } else {
            const t = batch[0];
            const icon = t.status === 'in-progress' ? chalk.yellow('●') : iconStr;
            console.log(`  ${labelColor(levelLabel + ':')} ${icon} ${taskColor(`${t.id}: ${t.title}`)}`);
          }

          // Mark this level's tasks as "done" for the next level
          for (const t of batch) {
            simDone.add(t.id);
            const idx = simRemaining.findIndex(r => r.id === t.id);
            if (idx >= 0) simRemaining.splice(idx, 1);
          }

          // If there are more eligible tasks beyond maxParallel, they form the next level
          const overflow = eligible.slice(maxParallel);
          if (overflow.length > 0) {
            // Don't remove overflow from simRemaining — they'll be picked up next iteration
          }

          level++;
        }
      }
    }

    console.log();
  } catch (error) {
    console.log(chalk.red(`Error parsing requirements: ${error}`));
  }
}
