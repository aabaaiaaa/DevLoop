import * as path from 'path';
import * as fs from 'fs/promises';
import chalk from 'chalk';
import { WorktreeInfo, MergeResult } from '../types/index.js';
import {
  execGit,
  isGitAvailable,
  isGitRepo,
  getDevloopCommitMessage,
  runVerificationInDir
} from './git.js';
import { ensureWorkspaceSettings } from './claude.js';

const WORKTREE_DIR = '.worktrees';

/**
 * Convert TASK-001 to T001 for short worktree paths (avoids Windows 260-char limit)
 */
function shortTaskId(taskId: string): string {
  return taskId.replace('TASK-', 'T').replace('task-', 'T');
}

/**
 * Create a git worktree for a task, branching from current HEAD.
 */
export async function createWorktree(
  workspace: string,
  taskId: string
): Promise<WorktreeInfo> {
  const shortId = shortTaskId(taskId);
  const worktreePath = path.join(workspace, WORKTREE_DIR, shortId);
  const branchName = `devloop/${taskId}`;

  // Clean up any stale worktree/branch from a previous crash
  await execGit(['worktree', 'remove', '--force', worktreePath], workspace).catch(() => {});
  await execGit(['branch', '-D', branchName], workspace).catch(() => {});

  // Create the worktree with a new branch from HEAD
  const result = await execGit(
    ['worktree', 'add', '-b', branchName, worktreePath],
    workspace
  );

  if (!result.success) {
    throw new Error(`Failed to create worktree for ${taskId}: ${result.error}`);
  }

  return { worktreePath, branchName, taskId };
}

/**
 * Prepare a worktree for Claude execution.
 * - Generates .claude/settings.json with worktree-specific paths
 * - Runs npm ci if package.json exists and node_modules doesn't
 */
export async function prepareWorktree(
  worktree: WorktreeInfo,
  workspace: string
): Promise<void> {
  // Generate settings.json with worktree path (not main workspace path)
  await ensureWorkspaceSettings(worktree.worktreePath);

  // Check if node_modules needs to be set up
  const packageJsonPath = path.join(worktree.worktreePath, 'package.json');
  const nodeModulesPath = path.join(worktree.worktreePath, 'node_modules');

  try {
    await fs.access(packageJsonPath);
    // package.json exists, check if node_modules exists
    try {
      await fs.access(nodeModulesPath);
      // node_modules already exists (carried over from branch), skip
    } catch {
      // node_modules doesn't exist, run npm ci
      await runNpmInstall(worktree.worktreePath);
    }
  } catch {
    // No package.json, nothing to do
  }
}

/**
 * Run npm ci --prefer-offline in a directory
 */
async function runNpmInstall(directory: string): Promise<void> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const child = spawn('npm', ['ci', '--prefer-offline'], {
      cwd: directory,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve()); // best-effort
  });
}

/**
 * Merge a completed task's worktree branch back to the main branch.
 *
 * Steps:
 * 1. Merge --no-commit --no-ff (stage changes without committing)
 * 2. Restore .devloop/ and .claude/ from HEAD (DevLoop manages these)
 * 3. Optionally run post-merge verification
 * 4. Commit or abort on conflict
 */
export async function mergeWorktree(
  workspace: string,
  worktree: WorktreeInfo,
  taskTitle: string,
  verification?: string,
  verbose: boolean = false
): Promise<MergeResult> {
  // Step 1: Attempt the merge (no-commit so we can adjust before committing)
  const mergeResult = await execGit(
    ['merge', '--no-commit', '--no-ff', worktree.branchName],
    workspace
  );

  if (!mergeResult.success) {
    // Merge conflict - abort and report
    await execGit(['merge', '--abort'], workspace);

    // Parse conflict files from the error
    const conflictFiles = parseConflictFiles(mergeResult.error || mergeResult.output);

    if (verbose) {
      console.log(chalk.yellow(`  Merge conflict for ${worktree.taskId}: ${conflictFiles.join(', ')}`));
    }

    return { success: false, conflictFiles };
  }

  // Step 2: Restore DevLoop-managed files from HEAD
  // These files should not be affected by task branches
  await execGit(['checkout', 'HEAD', '--', '.devloop/', '.claude/'], workspace).catch(() => {});
  // Reset any new files in .devloop/ or .claude/ that the branch might have
  await execGit(['reset', 'HEAD', '--', '.devloop/', '.claude/'], workspace).catch(() => {});
  await execGit(['checkout', '--', '.devloop/', '.claude/'], workspace).catch(() => {});

  // Step 3: Post-merge verification (catches semantic conflicts)
  if (verification) {
    const verifyResult = await runVerificationInDir(workspace, verification, verbose);
    if (!verifyResult.success) {
      // Verification failed - abort the merge
      await execGit(['merge', '--abort'], workspace).catch(() => {});
      // Also do a hard reset to clean up the partial merge state
      await execGit(['reset', '--hard', 'HEAD'], workspace);

      if (verbose) {
        console.log(chalk.yellow(`  Post-merge verification failed for ${worktree.taskId}`));
      }

      return { success: false, verificationFailed: true };
    }
  }

  // Step 4: Commit the merge
  const commitMsg = await getDevloopCommitMessage(
    workspace,
    `Complete ${worktree.taskId} - ${taskTitle}`
  );

  const commitResult = await execGit(['commit', '-m', commitMsg], workspace);
  if (!commitResult.success) {
    // Check if there's nothing to commit (task made no changes)
    const statusResult = await execGit(['status', '--porcelain'], workspace);
    if (!statusResult.output.trim()) {
      // No changes - that's OK, just means the task's branch had no diffs
      // Reset the merge state
      await execGit(['reset', '--hard', 'HEAD'], workspace);
      return { success: true };
    }

    // Real commit failure
    await execGit(['merge', '--abort'], workspace).catch(() => {});
    await execGit(['reset', '--hard', 'HEAD'], workspace);
    return { success: false };
  }

  return { success: true };
}

/**
 * Get the diff of changes made in a worktree branch (excluding .devloop/ and .claude/).
 * Used to provide context when re-queuing a task after merge conflict.
 */
export async function getWorktreeDiff(
  workspace: string,
  branchName: string
): Promise<string> {
  const result = await execGit(
    ['diff', `HEAD...${branchName}`, '--', '.', ':!.devloop', ':!.claude'],
    workspace
  );
  return result.success ? result.output : '';
}

/**
 * Clean up a worktree and its branch.
 */
export async function cleanupWorktree(
  worktree: WorktreeInfo,
  workspace: string
): Promise<void> {
  // Remove the worktree
  await execGit(['worktree', 'remove', '--force', worktree.worktreePath], workspace).catch(() => {});

  // Delete the branch
  await execGit(['branch', '-D', worktree.branchName], workspace).catch(() => {});
}

/**
 * Clean up any stale worktrees from crashed runs.
 * Should be called at the start of each run.
 */
export async function cleanupStaleWorktrees(workspace: string): Promise<number> {
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) return 0;

  const isRepo = await isGitRepo(workspace);
  if (!isRepo) return 0;

  // Prune stale worktree metadata
  await execGit(['worktree', 'prune'], workspace);

  // List and delete any devloop/* branches that don't have active worktrees
  const branchResult = await execGit(['branch', '--list', 'devloop/*'], workspace);
  if (!branchResult.success || !branchResult.output.trim()) return 0;

  const staleBranches = branchResult.output
    .split('\n')
    .map(b => b.trim().replace(/^\*\s*/, ''))
    .filter(b => b.startsWith('devloop/'));

  let cleaned = 0;
  for (const branch of staleBranches) {
    const deleteResult = await execGit(['branch', '-D', branch], workspace);
    if (deleteResult.success) cleaned++;
  }

  // Also try to remove the .worktrees directory if it's empty
  const worktreesDir = path.join(workspace, WORKTREE_DIR);
  try {
    const entries = await fs.readdir(worktreesDir);
    if (entries.length === 0) {
      await fs.rmdir(worktreesDir);
    }
  } catch {
    // Directory doesn't exist, that's fine
  }

  return cleaned;
}

/**
 * Parse conflict file paths from git merge error output
 */
function parseConflictFiles(output: string): string[] {
  const files: string[] = [];
  const lines = output.split('\n');
  for (const line of lines) {
    // "CONFLICT (content): Merge conflict in <file>"
    const match = line.match(/Merge conflict in (.+)/);
    if (match) {
      files.push(match[1].trim());
    }
    // "CONFLICT (modify/delete): <file> deleted in ..."
    const match2 = line.match(/^CONFLICT \([^)]+\): (.+?) /);
    if (match2 && !match) {
      files.push(match2[1].trim());
    }
  }
  return files;
}
