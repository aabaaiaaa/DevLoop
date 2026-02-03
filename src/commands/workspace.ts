import chalk from 'chalk';
import { getDefaultWorkspace, setDefaultWorkspace } from '../core/config.js';

export async function workspaceCommand(path?: string): Promise<void> {
  if (path) {
    await setDefaultWorkspace(path);
    console.log(chalk.green(`Default workspace set to: ${path}`));
  } else {
    const workspace = await getDefaultWorkspace();
    if (workspace) {
      console.log(chalk.blue('Default workspace:'), workspace);
    } else {
      console.log(chalk.yellow('No default workspace set.'));
      console.log(chalk.gray('Use "devloop workspace set <path>" to set one.'));
    }
  }
}
