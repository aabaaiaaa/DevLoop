import chalk from 'chalk';
import { resolveWorkspace, readWorkspaceConfig, writeWorkspaceConfig } from '../core/config.js';

interface ConfigOptions {
  workspace?: string;
}

const VALID_CONFIG_KEYS = ['commitMessageFormat', 'commitMessageFormatFailed'];

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

  if (Object.keys(config).length === 0) {
    console.log(chalk.gray('No configuration set (using defaults)'));
    console.log();
    return;
  }

  for (const key of VALID_CONFIG_KEYS) {
    const value = (config as any)[key];
    if (value !== undefined) {
      console.log(chalk.white(`${key}:`));
      console.log(chalk.gray(`  ${value}`));
    } else {
      console.log(chalk.gray(`${key}: (not set)`));
    }
  }

  console.log();
}
