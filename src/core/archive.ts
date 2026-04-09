import * as fs from 'fs/promises';
import * as path from 'path';
import { getRequirementsPath, getTasksPath, getProgressPath } from './config.js';

/**
 * Archive the current iteration's requirements.md, tasks.md, and progress.md
 * into .devloop/archive/iteration-{N}/, then delete all four files
 * so the next iteration starts fresh.
 */
export async function archiveIteration(workspace: string, iterationNumber: number): Promise<void> {
  const archiveDir = path.join(workspace, '.devloop', 'archive', `iteration-${iterationNumber}`);
  await fs.mkdir(archiveDir, { recursive: true });

  const requirementsPath = getRequirementsPath(workspace);
  const tasksPath = getTasksPath(workspace);
  const progressPath = getProgressPath(workspace);

  // Copy requirements.md to archive
  try {
    const content = await fs.readFile(requirementsPath, 'utf-8');
    await fs.writeFile(path.join(archiveDir, 'requirements.md'), content, 'utf-8');
  } catch {
    // requirements.md may not exist
  }

  // Copy tasks.md to archive
  try {
    const content = await fs.readFile(tasksPath, 'utf-8');
    await fs.writeFile(path.join(archiveDir, 'tasks.md'), content, 'utf-8');
  } catch {
    // tasks.md may not exist
  }

  // Copy progress.md to archive
  try {
    const content = await fs.readFile(progressPath, 'utf-8');
    await fs.writeFile(path.join(archiveDir, 'progress.md'), content, 'utf-8');
  } catch {
    // progress.md may not exist
  }

  // Copy review.md to archive
  const reviewPath = path.join(workspace, '.devloop', 'review.md');
  try {
    const content = await fs.readFile(reviewPath, 'utf-8');
    await fs.writeFile(path.join(archiveDir, 'review.md'), content, 'utf-8');
  } catch {
    // review.md may not exist (e.g., run was stopped before completion)
  }

  // Delete requirements.md so the next iteration starts fresh
  try {
    await fs.unlink(requirementsPath);
  } catch {
    // Already gone
  }

  // Delete tasks.md so the next iteration starts fresh
  try {
    await fs.unlink(tasksPath);
  } catch {
    // Already gone
  }

  // Delete progress.md so the next iteration starts fresh
  try {
    await fs.unlink(progressPath);
  } catch {
    // Already gone
  }

  // Delete review.md so the next iteration starts fresh
  try {
    await fs.unlink(reviewPath);
  } catch {
    // Already gone
  }
}

/**
 * List all archived iteration numbers, sorted ascending.
 */
export async function getArchivedIterations(workspace: string): Promise<number[]> {
  const archiveBase = path.join(workspace, '.devloop', 'archive');
  try {
    const entries = await fs.readdir(archiveBase);
    return entries
      .filter(e => e.startsWith('iteration-'))
      .map(e => parseInt(e.replace('iteration-', ''), 10))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Load prior context from an archived iteration for use in CLAUDE.md generation.
 */
export async function loadPriorContext(workspace: string, iterationNumber: number): Promise<{
  requirements: string | null;
  tasks: string | null;
  progress: string | null;
  review: string | null;
}> {
  const archiveDir = path.join(workspace, '.devloop', 'archive', `iteration-${iterationNumber}`);

  let requirements: string | null = null;
  let tasks: string | null = null;
  let progress: string | null = null;
  let review: string | null = null;

  try {
    requirements = await fs.readFile(path.join(archiveDir, 'requirements.md'), 'utf-8');
  } catch {
    // Not found
  }

  try {
    tasks = await fs.readFile(path.join(archiveDir, 'tasks.md'), 'utf-8');
  } catch {
    // Not found
  }

  try {
    progress = await fs.readFile(path.join(archiveDir, 'progress.md'), 'utf-8');
  } catch {
    // Not found
  }

  try {
    review = await fs.readFile(path.join(archiveDir, 'review.md'), 'utf-8');
  } catch {
    // Not found
  }

  return { requirements, tasks, progress, review };
}
