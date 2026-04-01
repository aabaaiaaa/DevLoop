import * as fs from 'fs/promises';
import * as path from 'path';

export interface CommitFormatDetection {
  detected: boolean;
  source?: string;
}

/**
 * Detects whether commit message hooks/config exist in the workspace.
 * When detected, the caller should prompt the user for a custom commit format.
 */
export async function detectCommitFormat(workspace: string): Promise<CommitFormatDetection> {
  if (await checkCommitlint(workspace)) {
    return { detected: true, source: 'commitlint' };
  }

  if (await checkGitHooks(workspace)) {
    return { detected: true, source: 'git hook' };
  }

  if (await checkHusky(workspace)) {
    return { detected: true, source: 'husky' };
  }

  return { detected: false };
}

/**
 * Check commitlint configuration files
 */
async function checkCommitlint(workspace: string): Promise<boolean> {
  const configFiles = [
    '.commitlintrc',
    '.commitlintrc.json',
    '.commitlintrc.js',
    '.commitlintrc.yaml',
    '.commitlintrc.yml',
    'commitlint.config.js',
    'commitlint.config.cjs',
    'commitlint.config.mjs',
    'commitlint.config.ts'
  ];

  for (const configFile of configFiles) {
    try {
      await fs.access(path.join(workspace, configFile));
      return true;
    } catch {
      // File doesn't exist, try next
    }
  }

  return false;
}

/**
 * Check git hooks for commit message patterns
 */
async function checkGitHooks(workspace: string): Promise<boolean> {
  const hookPaths = [
    path.join(workspace, '.git', 'hooks', 'commit-msg'),
    path.join(workspace, '.git', 'hooks', 'pre-commit')
  ];

  for (const hookPath of hookPaths) {
    try {
      await fs.access(hookPath);
      return true;
    } catch {
      // File doesn't exist, try next
    }
  }

  return false;
}

/**
 * Check husky configuration
 */
async function checkHusky(workspace: string): Promise<boolean> {
  // Check .husky/commit-msg
  try {
    await fs.access(path.join(workspace, '.husky', 'commit-msg'));
    return true;
  } catch {
    // File doesn't exist
  }

  // Check package.json for husky config
  try {
    const packageJsonPath = path.join(workspace, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    if (packageJson.husky?.hooks?.['commit-msg']) {
      return true;
    }
  } catch {
    // File doesn't exist or invalid JSON
  }

  return false;
}
