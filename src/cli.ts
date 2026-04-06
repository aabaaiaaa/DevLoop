import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { continueCommand } from './commands/continue.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { workspaceCommand } from './commands/workspace.js';
import { configSetCommand, configGetCommand, configUnsetCommand, configListCommand } from './commands/config.js';
import { getVersion } from './core/version.js';

const version = getVersion();

const program = new Command();

program
  .name('devloop')
  .description('Automate iterative development with Claude Code')
  .version(version, '-v, --version');

program
  .command('init')
  .description('Create requirements with interactive Claude session')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-f, --force', 'Overwrite existing requirements')
  .action(initCommand);

program
  .command('continue')
  .description('Resume work on requirements or task execution')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-i, --max-iterations <number>', 'Maximum iterations for run (ceiling: 1000)', '100')
  .option('-t, --token-limit <number>', 'Stop when cumulative tokens exceed this limit')
  .option('-c, --cost-limit <number>', 'Stop when session cost (USD) exceeds this limit (default: $10, ceiling: $500)')
  .option('--verbose', 'Verbose output (show Claude raw output)')
  .action(continueCommand);

program
  .command('run')
  .description('Start the task execution loop')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-i, --max-iterations <number>', 'Maximum iterations (ceiling: 1000)', '100')
  .option('-t, --token-limit <number>', 'Stop when cumulative tokens exceed this limit')
  .option('-c, --cost-limit <number>', 'Stop when session cost (USD) exceeds this limit (default: $10, ceiling: $500)')
  .option('--verbose', 'Verbose output (show Claude raw output)')
  .option('--dry-run', 'Show what would be done without executing')
  .action(runCommand);

program
  .command('status')
  .description('Show current progress')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--json', 'Output as JSON')
  .action(statusCommand);

const configCommand = program
  .command('config')
  .description('Manage workspace configuration (commit message formats, etc.)');

configCommand
  .command('set <key> <value>')
  .description('Set a config value. Keys: devloopCommitFormat. Variable: {action}')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(configSetCommand);

configCommand
  .command('get <key>')
  .description('Get a configuration value')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(configGetCommand);

configCommand
  .command('unset <key>')
  .description('Unset a configuration value')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(configUnsetCommand);

configCommand
  .command('list')
  .description('List all configuration values and available keys')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(configListCommand);

program
  .command('workspace [path]')
  .description('View or set default workspace')
  .action(workspaceCommand);

export { program };
