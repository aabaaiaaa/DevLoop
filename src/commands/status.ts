import * as fs from 'fs/promises';
import chalk from 'chalk';
import { resolveWorkspace, getRequirementsPath, getProgressPath, resolveFeaturePath } from '../core/config.js';
import { readSession } from '../core/session.js';
import { readFeatureSession } from '../core/feature-session.js';
import { parseRequirements, getNextTask } from '../parser/requirements.js';
import { readProgress } from '../parser/progress.js';
import { getUncommittedChanges, getUncommittedDiff } from '../core/git.js';

interface StatusOptions {
  workspace?: string;
  feature?: string;
  json?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const workspace = await resolveWorkspace(options.workspace);

  // Feature mode
  if (options.feature) {
    try {
      const { featureName, requirementsPath, progressPath } = resolveFeaturePath(workspace, options.feature);

      try {
        await fs.access(requirementsPath);
      } catch {
        console.log(chalk.red(`Error: Feature file not found: ${requirementsPath}`));
        console.log(chalk.gray(`Run "devloop init --feature ${featureName}" to create it.`));
        return;
      }

      try {
        const requirements = await parseRequirements(requirementsPath);
        const progress = await readProgress(progressPath);
        const session = await readFeatureSession(workspace, featureName);

        const pending = requirements.tasks.filter(t => t.status === 'pending');
        const inProgress = requirements.tasks.filter(t => t.status === 'in-progress');
        const done = requirements.tasks.filter(t => t.status === 'done');
        const nextTask = getNextTask(requirements);

        const uncommitted = await getUncommittedChanges(workspace);

        if (options.json) {
          console.log(JSON.stringify({
            workspace,
            feature: featureName,
            project: requirements.projectName,
            total: requirements.tasks.length,
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

        console.log(chalk.blue.bold(`\n=== ${requirements.projectName} [${featureName}] ===\n`));
        console.log(chalk.gray(`Workspace: ${workspace}`));
        console.log(chalk.gray(`Feature: ${featureName}`));

        if (session) {
          console.log(chalk.gray(`Phase: ${session.phase}`));
        }

        console.log();
        console.log(chalk.white('Progress:'));
        console.log(chalk.gray(`  Total tasks:    ${requirements.tasks.length}`));
        console.log(chalk.green(`  Completed:      ${done.length}`));
        console.log(chalk.yellow(`  In Progress:    ${inProgress.length}`));
        console.log(chalk.gray(`  Pending:        ${pending.length}`));

        if (progress) {
          console.log(chalk.gray(`  Iterations run: ${progress.iterations.length}`));

          let totalTokens = 0;
          let totalCost = 0;
          for (const iter of progress.iterations) {
            if (iter.tokenUsage) {
              totalTokens += iter.tokenUsage.totalTokens;
              totalCost += iter.tokenUsage.costUsd;
            }
          }
          if (totalTokens > 0) {
            console.log(chalk.gray(`  Total tokens:   ${totalTokens.toLocaleString()}`));
            console.log(chalk.gray(`  Total cost:     $${totalCost.toFixed(4)}`));
          }

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

        if (uncommitted.hasChanges) {
          console.log(chalk.yellow.bold('\n⚠ Uncommitted Changes Detected:'));
          console.log(chalk.gray('  These will be committed before the next run starts.'));
          for (const file of uncommitted.files.slice(0, 15)) {
            console.log(chalk.yellow(`    - ${file}`));
          }
          if (uncommitted.files.length > 15) {
            console.log(chalk.gray(`    ... and ${uncommitted.files.length - 15} more files`));
          }
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

        console.log(chalk.white('\nTasks:'));
        for (const task of requirements.tasks) {
          const statusIcon = task.status === 'done' ? chalk.green('✓') :
            task.status === 'in-progress' ? chalk.yellow('●') :
              chalk.gray('○');
          const statusColor = task.status === 'done' ? chalk.green :
            task.status === 'in-progress' ? chalk.yellow :
              chalk.gray;
          console.log(`  ${statusIcon} ${statusColor(task.id)}: ${task.title}`);
        }

        if (nextTask) {
          console.log(chalk.cyan(`\nNext task: ${nextTask.id} - ${nextTask.title}`));
        } else if (pending.length > 0) {
          console.log(chalk.yellow('\nNo tasks available (all remaining tasks have unmet dependencies)'));
        } else {
          console.log(chalk.green('\nAll tasks complete!'));
        }

        console.log();
      } catch (error) {
        console.log(chalk.red(`Error parsing requirements: ${error}`));
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
  const requirementsPath = getRequirementsPath(workspace);
  const progressPath = getProgressPath(workspace);

  try {
    await fs.access(requirementsPath);
  } catch {
    console.log(chalk.red('Error: requirements.md not found.'));
    console.log(chalk.gray(`Expected at: ${requirementsPath}`));
    console.log(chalk.gray('Run "devloop init" to create one.'));
    return;
  }

  try {
    const requirements = await parseRequirements(requirementsPath);
    const progress = await readProgress(progressPath);
    const session = await readSession(workspace);

    const pending = requirements.tasks.filter(t => t.status === 'pending');
    const inProgress = requirements.tasks.filter(t => t.status === 'in-progress');
    const done = requirements.tasks.filter(t => t.status === 'done');
    const nextTask = getNextTask(requirements);

    // Check for uncommitted changes
    const uncommitted = await getUncommittedChanges(workspace);

    if (options.json) {
      console.log(JSON.stringify({
        workspace,
        project: requirements.projectName,
        total: requirements.tasks.length,
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

    console.log(chalk.blue.bold(`\n=== ${requirements.projectName} ===\n`));
    console.log(chalk.gray(`Workspace: ${workspace}`));

    if (session) {
      console.log(chalk.gray(`Phase: ${session.phase}`));
    }

    console.log();
    console.log(chalk.white('Progress:'));
    console.log(chalk.gray(`  Total tasks:    ${requirements.tasks.length}`));
    console.log(chalk.green(`  Completed:      ${done.length}`));
    console.log(chalk.yellow(`  In Progress:    ${inProgress.length}`));
    console.log(chalk.gray(`  Pending:        ${pending.length}`));

    if (progress) {
      console.log(chalk.gray(`  Iterations run: ${progress.iterations.length}`));

      // Calculate cumulative token usage
      let totalTokens = 0;
      let totalCost = 0;
      for (const iter of progress.iterations) {
        if (iter.tokenUsage) {
          totalTokens += iter.tokenUsage.totalTokens;
          totalCost += iter.tokenUsage.costUsd;
        }
      }
      if (totalTokens > 0) {
        console.log(chalk.gray(`  Total tokens:   ${totalTokens.toLocaleString()}`));
        console.log(chalk.gray(`  Total cost:     $${totalCost.toFixed(4)}`));
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
            console.log(chalk.gray('    ... (see progress.md for full details)'));
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
    for (const task of requirements.tasks) {
      const statusIcon = task.status === 'done' ? chalk.green('✓') :
        task.status === 'in-progress' ? chalk.yellow('●') :
          chalk.gray('○');
      const statusColor = task.status === 'done' ? chalk.green :
        task.status === 'in-progress' ? chalk.yellow :
          chalk.gray;
      console.log(`  ${statusIcon} ${statusColor(task.id)}: ${task.title}`);
    }

    if (nextTask) {
      console.log(chalk.cyan(`\nNext task: ${nextTask.id} - ${nextTask.title}`));
    } else if (pending.length > 0) {
      console.log(chalk.yellow('\nNo tasks available (all remaining tasks have unmet dependencies)'));
    } else {
      console.log(chalk.green('\nAll tasks complete!'));
    }

    console.log();
  } catch (error) {
    console.log(chalk.red(`Error parsing requirements: ${error}`));
  }
}
