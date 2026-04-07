import * as readline from 'readline';
import chalk from 'chalk';
import { checkClaudeInstalled } from '../core/claude.js';
import { getRequirementsPath, getTasksPath, getProgressPath } from '../core/config.js';
import { getVersion } from '../core/version.js';
import { DevLoopConfig } from '../types/index.js';

/**
 * Prompt user with a yes/no question.
 * @param defaultYes - If true (default), empty input means "yes". If false, empty input means "no".
 */
export async function promptUser(question: string, defaultYes: boolean = true): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') {
        resolve(defaultYes);
      } else {
        resolve(trimmed === 'y' || trimmed === 'yes');
      }
    });
  });
}

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

const BANNER = `
 ██████╗ ███████╗██╗   ██╗██╗      ██████╗  ██████╗ ██████╗
 ██╔══██╗██╔════╝██║   ██║██║     ██╔═══██╗██╔═══██╗██╔══██╗
 ██║  ██║█████╗  ██║   ██║██║     ██║   ██║██║   ██║██████╔╝
 ██║  ██║██╔══╝  ╚██╗ ██╔╝██║     ██║   ██║██║   ██║██╔═══╝
 ██████╔╝███████╗ ╚████╔╝ ███████╗╚██████╔╝╚██████╔╝██║
 ╚═════╝ ╚══════╝  ╚═══╝  ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝`;

/**
 * Print the DevLoop ASCII banner with an optional subtitle.
 */
export function printBanner(subtitle?: string): void {
  console.log(chalk.blue.bold(BANNER));
  const version = `v${getVersion()}`;
  if (subtitle) {
    console.log(chalk.blue.bold(`  ${subtitle}`) + chalk.gray(` (${version})`));
  } else {
    console.log(chalk.gray(`  ${version}`));
  }
  console.log();
}

export interface RunConfigOptions {
  workspace: string;
  requirementsPath?: string;
  tasksPath?: string;
  progressPath?: string;
  maxIterations?: string;
  tokenLimit?: string;
  costLimit?: string;
  taskTimeout?: string;
  verbose?: boolean;
  dryRun?: boolean;
  sessionAction?: 'create' | 'update' | 'none';
}

/**
 * Build a DevLoopConfig from command options.
 */
const MAX_ITERATIONS_CEILING = 1000;
const MAX_COST_CEILING = 500;
const DEFAULT_COST_LIMIT = 10;
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_TASK_TIMEOUT_MINUTES = 150;

export function buildRunConfig(options: RunConfigOptions): DevLoopConfig {
  const maxIterations = Math.min(
    parseInt(options.maxIterations || String(DEFAULT_MAX_ITERATIONS), 10),
    MAX_ITERATIONS_CEILING
  );
  const costLimit = Math.min(
    options.costLimit ? parseFloat(options.costLimit) || DEFAULT_COST_LIMIT : DEFAULT_COST_LIMIT,
    MAX_COST_CEILING
  );

  return {
    maxIterations,
    requirementsPath: options.requirementsPath || getRequirementsPath(options.workspace),
    tasksPath: options.tasksPath || getTasksPath(options.workspace),
    progressPath: options.progressPath || getProgressPath(options.workspace),
    workspacePath: options.workspace,
    verbose: options.verbose || false,
    dryRun: options.dryRun || false,
    tokenLimit: options.tokenLimit ? parseInt(options.tokenLimit, 10) || undefined : undefined,
    costLimit,
    taskTimeout: options.taskTimeout
      ? (parseInt(options.taskTimeout, 10) || DEFAULT_TASK_TIMEOUT_MINUTES) * 60000
      : DEFAULT_TASK_TIMEOUT_MINUTES * 60000,
    sessionAction: options.sessionAction
  };
}
