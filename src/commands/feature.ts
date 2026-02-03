import * as fs from 'fs/promises';
import chalk from 'chalk';
import { resolveWorkspace, getFeatureRequirementsPath, getFeatureProgressPath } from '../core/config.js';
import { listFeatures, readFeatureSession } from '../core/feature-session.js';
import { parseRequirements } from '../parser/requirements.js';
import { readProgress } from '../parser/progress.js';

interface FeatureOptions {
  workspace?: string;
}

export async function featureListCommand(options: FeatureOptions): Promise<void> {
  const workspace = await resolveWorkspace(options.workspace);
  const features = await listFeatures(workspace);

  if (features.length === 0) {
    console.log(chalk.yellow('\nNo features found in requirements/ directory.'));
    console.log();
    console.log(chalk.gray('To get started:'));
    console.log(chalk.cyan('  1. Create a feature: devloop init --feature auth'));
    console.log(chalk.cyan('  2. Or use legacy mode: devloop init'));
    return;
  }

  console.log(chalk.blue.bold('\n=== Features ===\n'));
  console.log(chalk.gray(`Workspace: ${workspace}`));
  console.log();

  for (const featureName of features) {
    const requirementsPath = getFeatureRequirementsPath(workspace, featureName);
    const progressPath = getFeatureProgressPath(workspace, featureName);
    const session = await readFeatureSession(workspace, featureName);

    try {
      const requirements = await parseRequirements(requirementsPath);
      const progress = await readProgress(progressPath);

      const done = requirements.tasks.filter(t => t.status === 'done').length;
      const total = requirements.tasks.length;
      const percentage = total > 0 ? Math.round((done / total) * 100) : 0;

      const statusColor = percentage === 100 ? chalk.green : percentage > 0 ? chalk.yellow : chalk.gray;

      console.log(chalk.white(`${featureName}:`));
      console.log(chalk.gray(`  Tasks: ${done}/${total} (${statusColor(percentage + '%')})`));

      if (session) {
        console.log(chalk.gray(`  Phase: ${session.phase}`));
        if (session.lastIteration > 0) {
          console.log(chalk.gray(`  Last iteration: ${session.lastIteration}`));
        }
      }

      if (progress && progress.iterations.length > 0) {
        const lastIter = progress.iterations[progress.iterations.length - 1];
        console.log(chalk.gray(`  Last activity: ${new Date(lastIter.timestamp).toLocaleString()}`));
      }

      console.log();
    } catch (error) {
      console.log(chalk.white(`${featureName}:`));
      console.log(chalk.red(`  Error: ${error}`));
      console.log();
    }
  }
}

export async function featureStatusCommand(options: FeatureOptions): Promise<void> {
  const workspace = await resolveWorkspace(options.workspace);
  const features = await listFeatures(workspace);

  if (features.length === 0) {
    console.log(chalk.yellow('\nNo features found in requirements/ directory.'));
    console.log();
    console.log(chalk.gray('To get started:'));
    console.log(chalk.cyan('  1. Create a feature: devloop init --feature auth'));
    console.log(chalk.cyan('  2. Or use legacy mode: devloop init'));
    return;
  }

  console.log(chalk.blue.bold('\n=== Feature Status Summary ===\n'));
  console.log(chalk.gray(`Workspace: ${workspace}`));
  console.log();

  let totalTasks = 0;
  let totalDone = 0;
  const featureStatuses: Array<{
    name: string;
    done: number;
    total: number;
    percentage: number;
    active: boolean;
  }> = [];

  for (const featureName of features) {
    const requirementsPath = getFeatureRequirementsPath(workspace, featureName);
    const session = await readFeatureSession(workspace, featureName);

    try {
      const requirements = await parseRequirements(requirementsPath);
      const done = requirements.tasks.filter(t => t.status === 'done').length;
      const total = requirements.tasks.length;
      const percentage = total > 0 ? Math.round((done / total) * 100) : 0;

      totalTasks += total;
      totalDone += done;

      featureStatuses.push({
        name: featureName,
        done,
        total,
        percentage,
        active: session?.phase === 'run' || false
      });
    } catch {
      // Skip features with parsing errors
    }
  }

  // Sort by percentage (desc), then by name
  featureStatuses.sort((a, b) => {
    if (b.percentage !== a.percentage) {
      return b.percentage - a.percentage;
    }
    return a.name.localeCompare(b.name);
  });

  console.log(chalk.white('Features:'));
  for (const feature of featureStatuses) {
    const statusColor = feature.percentage === 100 ? chalk.green :
      feature.percentage > 0 ? chalk.yellow : chalk.gray;
    const activeIndicator = feature.active ? chalk.cyan('●') : ' ';
    const bar = generateProgressBar(feature.percentage, 20);

    console.log(`  ${activeIndicator} ${chalk.white(feature.name.padEnd(20))} ${bar} ${statusColor(feature.percentage + '%')} (${feature.done}/${feature.total})`);
  }

  console.log();
  console.log(chalk.white('Overall Progress:'));
  const overallPercentage = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;
  const overallBar = generateProgressBar(overallPercentage, 40);
  const overallColor = overallPercentage === 100 ? chalk.green :
    overallPercentage > 0 ? chalk.yellow : chalk.gray;

  console.log(`  ${overallBar} ${overallColor(overallPercentage + '%')}`);
  console.log(chalk.gray(`  Total: ${totalDone}/${totalTasks} tasks completed`));
  console.log();
}

function generateProgressBar(percentage: number, width: number): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;

  const filledColor = percentage === 100 ? chalk.green :
    percentage > 0 ? chalk.yellow : chalk.gray;

  return filledColor('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}
