import chalk from 'chalk';
import { checkClaudeInstalled } from '../core/claude.js';
import { getRequirementsPath, getProgressPath } from '../core/config.js';
import { DevLoopConfig } from '../types/index.js';

/**
 * Check if Claude CLI is installed, exit with error if not.
 */
export async function requireClaudeInstalled(): Promise<void> {
  const claudeInstalled = await checkClaudeInstalled();
  if (!claudeInstalled) {
    console.log(chalk.red('Error: Claude CLI is not installed or not in PATH.'));
    console.log(chalk.gray('Install it from: https://claude.ai/code'));
    process.exit(1);
  }
}

export interface RunConfigOptions {
  workspace: string;
  requirementsPath?: string;
  progressPath?: string;
  maxIterations?: string;
  tokenLimit?: string;
  verbose?: boolean;
  dryRun?: boolean;
  featureName?: string;
  sessionAction?: 'create' | 'update' | 'create-feature' | 'none';
}

/**
 * Build a DevLoopConfig from command options.
 */
export function buildRunConfig(options: RunConfigOptions): DevLoopConfig {
  return {
    maxIterations: parseInt(options.maxIterations || '10', 10),
    requirementsPath: options.requirementsPath || getRequirementsPath(options.workspace),
    progressPath: options.progressPath || getProgressPath(options.workspace),
    workspacePath: options.workspace,
    verbose: options.verbose || false,
    dryRun: options.dryRun || false,
    tokenLimit: options.tokenLimit ? parseInt(options.tokenLimit, 10) : undefined,
    featureName: options.featureName,
    sessionAction: options.sessionAction
  };
}
