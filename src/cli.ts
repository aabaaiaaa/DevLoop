import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { continueCommand } from './commands/continue.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { workspaceCommand } from './commands/workspace.js';
import { featureListCommand, featureStatusCommand } from './commands/feature.js';
import { configSetCommand, configGetCommand, configUnsetCommand, configListCommand } from './commands/config.js';

const program = new Command();

program
  .name('devloop')
  .description('Automate iterative development with Claude Code')
  .version('1.0.0');

program
  .command('init')
  .description('Create requirements.md with interactive Claude session')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--feature <name>', 'Feature mode: create requirements/<name>.md')
  .option('-f, --force', 'Overwrite existing requirements')
  .action(initCommand);

program
  .command('continue')
  .description('Resume work on requirements or task execution')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--feature <name>', 'Feature mode: work on specific feature')
  .option('-n, --max-iterations <number>', 'Maximum iterations for run', '10')
  .option('-t, --token-limit <number>', 'Stop when cumulative tokens exceed this limit')
  .option('-v, --verbose', 'Verbose output')
  .action(continueCommand);

program
  .command('run')
  .description('Start the task execution loop')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--feature <name>', 'Feature mode: run specific feature tasks')
  .option('-n, --max-iterations <number>', 'Maximum iterations', '10')
  .option('-t, --token-limit <number>', 'Stop when cumulative tokens exceed this limit')
  .option('-v, --verbose', 'Verbose output')
  .option('--dry-run', 'Show what would be done without executing')
  .action(runCommand);

program
  .command('status')
  .description('Show current progress')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--feature <name>', 'Feature mode: show feature status')
  .option('--json', 'Output as JSON')
  .action(statusCommand);

const featureCommand = program
  .command('feature')
  .description('Manage features');

featureCommand
  .command('list')
  .description('List all features')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(featureListCommand);

featureCommand
  .command('status')
  .description('Show summary of all features')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(featureStatusCommand);

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
