import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GlobalConfig } from '../types/index.js';

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
