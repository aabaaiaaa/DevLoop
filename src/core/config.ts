import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GlobalConfig, ProjectUsage } from '../types/index.js';

const CONFIG_DIR = path.join(os.homedir(), '.devloop');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: GlobalConfig = {
  defaultWorkspace: null,
  maxIterations: 100
};

export async function ensureConfigDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
  } catch {
    // Directory already exists
  }
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export async function getDefaultWorkspace(): Promise<string | null> {
  const config = await readGlobalConfig();
  return config.defaultWorkspace;
}

export async function setDefaultWorkspace(workspacePath: string): Promise<void> {
  const config = await readGlobalConfig();
  config.defaultWorkspace = path.resolve(workspacePath);
  await writeGlobalConfig(config);
}

export async function resolveWorkspace(cliWorkspace?: string): Promise<string> {
  // Priority: CLI flag > config default > current directory
  if (cliWorkspace) {
    return path.resolve(cliWorkspace);
  }

  const defaultWorkspace = await getDefaultWorkspace();
  if (defaultWorkspace) {
    return defaultWorkspace;
  }

  return process.cwd();
}

export function getRequirementsPath(workspace: string): string {
  return path.join(workspace, '.devloop', 'requirements.md');
}

export function getTasksPath(workspace: string): string {
  return path.join(workspace, '.devloop', 'tasks.md');
}

export function getProgressPath(workspace: string): string {
  return path.join(workspace, '.devloop', 'progress.md');
}

function getWorkspaceConfigPath(workspace: string): string {
  return path.join(workspace, '.devloop', 'config.json');
}

export async function readWorkspaceConfig(workspace: string): Promise<import('../types/index.js').WorkspaceConfig> {
  try {
    const configPath = getWorkspaceConfigPath(workspace);
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function writeWorkspaceConfig(workspace: string, config: import('../types/index.js').WorkspaceConfig): Promise<void> {
  const configPath = getWorkspaceConfigPath(workspace);
  const devloopDir = path.dirname(configPath);

  // Ensure .devloop directory exists
  await fs.mkdir(devloopDir, { recursive: true });

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// --- Project-lifetime usage tracking ---

const DEFAULT_USAGE: ProjectUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  totalIterations: 0,
  totalTasksCompleted: 0
};

function getUsagePath(workspace: string): string {
  return path.join(workspace, '.devloop', 'usage.json');
}

/**
 * Read cumulative project usage (persists across archives/iterations).
 */
export async function readProjectUsage(workspace: string): Promise<ProjectUsage> {
  try {
    const content = await fs.readFile(getUsagePath(workspace), 'utf-8');
    return { ...DEFAULT_USAGE, ...JSON.parse(content) };
  } catch {
    return { ...DEFAULT_USAGE };
  }
}

/**
 * Add token/cost usage from a completed session to the project totals.
 */
export async function addProjectUsage(
  workspace: string,
  sessionTokens: { input: number; output: number; cacheWrite: number; cacheRead: number; total: number },
  sessionCost: number,
  iterationsRun: number,
  tasksCompleted: number
): Promise<ProjectUsage> {
  const usage = await readProjectUsage(workspace);
  usage.inputTokens += sessionTokens.input;
  usage.outputTokens += sessionTokens.output;
  usage.cacheCreationTokens += sessionTokens.cacheWrite;
  usage.cacheReadTokens += sessionTokens.cacheRead;
  usage.totalTokens += sessionTokens.total;
  usage.costUsd += sessionCost;
  usage.totalIterations += iterationsRun;
  usage.totalTasksCompleted += tasksCompleted;

  const usagePath = getUsagePath(workspace);
  await fs.mkdir(path.dirname(usagePath), { recursive: true });
  await fs.writeFile(usagePath, JSON.stringify(usage, null, 2), 'utf-8');
  return usage;
}
