import chalk from 'chalk';
import { resolveWorkspace } from '../core/config.js';
import { runLoop } from '../core/loop.js';
import { requireClaudeInstalled, buildRunConfig } from './shared.js';

interface RunOptions {
  workspace?: string;
  maxIterations?: string;
  tokenLimit?: string;
  costLimit?: string;
  taskTimeout?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

export async function runCommand(options: RunOptions): Promise<void> {
  await requireClaudeInstalled();

  const workspace = await resolveWorkspace(options.workspace);

  const config = buildRunConfig({
    workspace,
    maxIterations: options.maxIterations,
    tokenLimit: options.tokenLimit,
    costLimit: options.costLimit,
    taskTimeout: options.taskTimeout,
    verbose: options.verbose,
    dryRun: options.dryRun,
    sessionAction: 'create'
  });

  if (isNaN(config.maxIterations) || config.maxIterations < 1) {
    console.log(chalk.red('Error: max-iterations must be a positive number'));
    process.exit(1);
  }

  if (isNaN(config.costLimit!) || config.costLimit! < 0) {
    console.log(chalk.red('Error: cost-limit must be a non-negative number'));
    process.exit(1);
  }

  try {
    await runLoop(config);
  } catch (error) {
    const message = error instanceof Error
          ? `${error.message}\n${error.stack}`
          : String(error);
        console.log(chalk.red(`\nFatal error: ${message}`));
    process.exit(1);
  }
}
