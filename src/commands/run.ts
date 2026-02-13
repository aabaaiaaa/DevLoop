import chalk from 'chalk';
import * as fs from 'fs/promises';
import { resolveWorkspace, resolveFeaturePath } from '../core/config.js';
import { runLoop } from '../core/loop.js';
import { requireClaudeInstalled, buildRunConfig } from './shared.js';

interface RunOptions {
  workspace?: string;
  feature?: string;
  maxIterations?: string;
  tokenLimit?: string;
  costLimit?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

export async function runCommand(options: RunOptions): Promise<void> {
  await requireClaudeInstalled();

  const workspace = await resolveWorkspace(options.workspace);

  // Feature mode
  if (options.feature) {
    try {
      const { featureName, requirementsPath, progressPath } = resolveFeaturePath(workspace, options.feature);

      // Check if feature file exists
      try {
        await fs.access(requirementsPath);
      } catch {
        console.log(chalk.red(`Error: Feature file not found: ${requirementsPath}\n`));
        console.log('Did you mean to:');
        console.log(chalk.cyan(`  1. Create it: devloop init --feature ${featureName}`));
        console.log(chalk.cyan('  2. List features: devloop feature list'));
        console.log(chalk.cyan('  3. Run legacy mode: devloop run (without --feature)'));
        process.exit(1);
      }

      const config = buildRunConfig({
        workspace,
        requirementsPath,
        progressPath,
        maxIterations: options.maxIterations,
        tokenLimit: options.tokenLimit,
        costLimit: options.costLimit,
        verbose: options.verbose,
        dryRun: options.dryRun,
        featureName,
        sessionAction: 'create-feature'
      });

      if (isNaN(config.maxIterations) || config.maxIterations < 1) {
        console.log(chalk.red('Error: max-iterations must be a positive number'));
        process.exit(1);
      }

      try {
        await runLoop(config);
      } catch (error) {
        console.log(chalk.red(`\nFatal error: ${error}`));
        process.exit(1);
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
  const config = buildRunConfig({
    workspace,
    maxIterations: options.maxIterations,
    tokenLimit: options.tokenLimit,
    costLimit: options.costLimit,
    verbose: options.verbose,
    dryRun: options.dryRun,
    sessionAction: 'create'
  });

  if (isNaN(config.maxIterations) || config.maxIterations < 1) {
    console.log(chalk.red('Error: max-iterations must be a positive number'));
    process.exit(1);
  }

  try {
    await runLoop(config);
  } catch (error) {
    console.log(chalk.red(`\nFatal error: ${error}`));
    process.exit(1);
  }
}
