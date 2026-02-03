import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GlobalConfig } from '../types/index.js';

const CONFIG_DIR = path.join(os.homedir(), '.devloop');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: GlobalConfig = {
  defaultWorkspace: null,
  maxIterations: 10
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
  return path.join(workspace, 'requirements.md');
}

export function getProgressPath(workspace: string): string {
  return path.join(workspace, 'progress.md');
}

export function getSessionPath(workspace: string): string {
  return path.join(workspace, '.devloop', 'session.json');
}

/**
 * Validates a feature name to ensure it's a safe filename
 * @throws Error if feature name is invalid
 */
export function validateFeatureName(feature: string): void {
  // Must be alphanumeric with hyphens or underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error(
      `Invalid feature name: "${feature}"\n` +
      'Feature names must be alphanumeric with hyphens or underscores only.\n' +
      'Example: my-feature or my_feature'
    );
  }

  // Prevent path traversal
  if (feature.includes('..') || feature.includes('/') || feature.includes('\\')) {
    throw new Error(`Invalid feature name: "${feature}" (path traversal not allowed)`);
  }
}

/**
 * Resolves feature input to normalized paths
 * Handles both short form (auth) and explicit paths (requirements/auth.md)
 */
export function resolveFeaturePath(workspace: string, featureInput: string): {
  featureName: string;
  requirementsPath: string;
  progressPath: string;
} {
  let featureName: string;

  // Handle explicit path format (requirements/auth.md)
  if (featureInput.includes('/') || featureInput.includes('\\')) {
    const normalized = featureInput.replace(/\\/g, '/');
    const match = normalized.match(/^requirements\/([^/]+)\.md$/);

    if (!match) {
      throw new Error(
        `Invalid feature path: "${featureInput}"\n` +
        'Feature paths must be in format: requirements/<name>.md\n' +
        'Or use short form: <name>'
      );
    }

    featureName = match[1];
  } else {
    // Remove .md extension if provided
    featureName = featureInput.replace(/\.md$/, '');
  }

  validateFeatureName(featureName);

  return {
    featureName,
    requirementsPath: getFeatureRequirementsPath(workspace, featureName),
    progressPath: getFeatureProgressPath(workspace, featureName)
  };
}

export function getFeatureRequirementsPath(workspace: string, feature: string): string {
  return path.join(workspace, 'requirements', `${feature}.md`);
}

export function getFeatureProgressPath(workspace: string, feature: string): string {
  return path.join(workspace, 'progress', `${feature}.md`);
}

export function getWorkspaceConfigPath(workspace: string): string {
  return path.join(workspace, '.devloop', 'config.json');
}

export async function readWorkspaceConfig(workspace: string): Promise<import('../types/feature.js').WorkspaceConfig> {
  try {
    const configPath = getWorkspaceConfigPath(workspace);
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function writeWorkspaceConfig(workspace: string, config: import('../types/feature.js').WorkspaceConfig): Promise<void> {
  const configPath = getWorkspaceConfigPath(workspace);
  const devloopDir = path.dirname(configPath);

  // Ensure .devloop directory exists
  await fs.mkdir(devloopDir, { recursive: true });

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
