import chalk from 'chalk';
import { resolveWorkspace, readWorkspaceConfig, writeWorkspaceConfig } from '../core/config.js';

interface ConfigOptions {
  workspace?: string;
}

const VALID_CONFIG_KEYS = ['devloopCommitFormat', 'verifyEachTask', 'maxParallelTasks'];

export async function configSetCommand(key: string, value: string, options: ConfigOptions): Promise<void> {
  if (!VALID_CONFIG_KEYS.includes(key)) {
    console.log(chalk.red(`Error: Unknown config key: ${key}`));
    console.log(chalk.gray('Valid keys:'));
    for (const validKey of VALID_CONFIG_KEYS) {
      console.log(chalk.gray(`  - ${validKey}`));
    }
    process.exit(1);
  }

  const workspace = await resolveWorkspace(options.workspace);
  const config = await readWorkspaceConfig(workspace);

  (config as any)[key] = value;
  await writeWorkspaceConfig(workspace, config);

  console.log(chalk.green(`✓ Set ${key} = ${value}`));
}

export async function configGetCommand(key: string, options: ConfigOptions): Promise<void> {
  if (!VALID_CONFIG_KEYS.includes(key)) {
    console.log(chalk.red(`Error: Unknown config key: ${key}`));
    console.log(chalk.gray('Valid keys:'));
    for (const validKey of VALID_CONFIG_KEYS) {
      console.log(chalk.gray(`  - ${validKey}`));
    }
    process.exit(1);
  }

  const workspace = await resolveWorkspace(options.workspace);
  const config = await readWorkspaceConfig(workspace);

  const value = (config as any)[key];

  if (value !== undefined) {
    console.log(chalk.white(`${key}: ${value}`));
  } else {
    console.log(chalk.gray(`${key}: (not set)`));
  }
}

export async function configUnsetCommand(key: string, options: ConfigOptions): Promise<void> {
  if (!VALID_CONFIG_KEYS.includes(key)) {
    console.log(chalk.red(`Error: Unknown config key: ${key}`));
    console.log(chalk.gray('Valid keys:'));
    for (const validKey of VALID_CONFIG_KEYS) {
      console.log(chalk.gray(`  - ${validKey}`));
    }
    process.exit(1);
  }

  const workspace = await resolveWorkspace(options.workspace);
  const config = await readWorkspaceConfig(workspace);

  delete (config as any)[key];
  await writeWorkspaceConfig(workspace, config);

  console.log(chalk.green(`✓ Unset ${key}`));
}

export async function configListCommand(options: ConfigOptions): Promise<void> {
  const workspace = await resolveWorkspace(options.workspace);
  const config = await readWorkspaceConfig(workspace);

  console.log(chalk.blue.bold('\n=== Workspace Configuration ===\n'));
  console.log(chalk.gray(`Workspace: ${workspace}`));
  console.log();

  for (const key of VALID_CONFIG_KEYS) {
    const value = (config as any)[key];
    if (value !== undefined) {
      console.log(chalk.white(`${key}:`));
      console.log(chalk.cyan(`  ${value}`));
    } else {
      console.log(chalk.gray(`${key}: (not set)`));
    }
  }

  console.log();
  console.log(chalk.white('devloopCommitFormat:'));
  console.log(chalk.gray('  Optional. If unset, DevLoop generates Conventional Commits messages'));
  console.log(chalk.gray('  itself (feat:, fix:, chore:, etc.) using each task\'s Type field.'));
  console.log(chalk.gray('  Set this only when your repo\'s commit hooks require a different format.'));
  console.log(chalk.gray('  Use {action} as a placeholder for the action description.'));
  console.log(chalk.gray(''));
  console.log(chalk.gray('  {action} examples:'));
  console.log(chalk.gray('    "Initialize workspace"'));
  console.log(chalk.gray('    "Complete TASK-001 - Fix the bug"'));
  console.log(chalk.gray('    "Attempted TASK-002 - Add feature"'));
  console.log(chalk.gray(''));
  console.log(chalk.gray('  Example: devloop config set devloopCommitFormat "chore(devloop): {action}"'));
  console.log();
  console.log(chalk.white('verifyEachTask:'));
  console.log(chalk.gray('  Set to "true" to run verification per-task instead of consolidated at end.'));
  console.log(chalk.gray('  Default: not set (consolidated verification)'));
  console.log();
  console.log(chalk.white('Examples:'));
  console.log(chalk.gray('  devloop config set devloopCommitFormat "chore(devloop): {action}"'));
  console.log(chalk.gray('  devloop config set verifyEachTask true'));
  console.log();
}
