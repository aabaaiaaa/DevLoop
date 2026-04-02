import * as fs from 'fs/promises';
import * as path from 'path';
import { Session, SessionPhase, ActiveTask } from '../types/index.js';
import { getVersion } from './version.js';

async function ensureSessionDir(workspace: string): Promise<void> {
  const sessionDir = path.join(workspace, '.devloop');
  try {
    await fs.mkdir(sessionDir, { recursive: true });
  } catch {
    // Directory already exists
  }
}

export async function readSession(workspace: string): Promise<Session | null> {
  const sessionPath = path.join(workspace, '.devloop', 'session.json');
  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    const parsed = JSON.parse(content);
    // Backward compat: old sessions lack iteration field
    if (parsed.iteration === undefined) {
      parsed.iteration = 1;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSession(workspace: string, session: Session): Promise<void> {
  await ensureSessionDir(workspace);
  const sessionPath = path.join(workspace, '.devloop', 'session.json');
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
}

export async function createSession(workspace: string, phase: SessionPhase, iteration: number = 1): Promise<Session> {
  const session: Session = {
    phase,
    sessionId: null,
    lastIteration: 0,
    startedAt: new Date().toISOString(),
    iteration,
    devloopVersion: getVersion()
  };
  await writeSession(workspace, session);
  return session;
}

export async function updateSessionPhase(workspace: string, phase: SessionPhase): Promise<void> {
  const session = await readSession(workspace);
  if (session) {
    session.phase = phase;
    await writeSession(workspace, session);
  }
}

export async function updateSessionIteration(workspace: string, iteration: number): Promise<void> {
  const session = await readSession(workspace);
  if (session) {
    session.lastIteration = iteration;
    await writeSession(workspace, session);
  }
}

/**
 * Set the list of active tasks (parallel mode crash marker).
 * Replaces the old single activeTask field.
 */
export async function setActiveTasks(workspace: string, tasks: ActiveTask[]): Promise<void> {
  try {
    const session = await readSession(workspace);
    if (session) {
      session.activeTasks = tasks.length > 0 ? tasks : undefined;
      // Also set activeTask for backward compat (first task or null)
      session.activeTask = tasks.length > 0 ? tasks[0] : null;
      await writeSession(workspace, session);
    }
  } catch {
    // Best-effort — don't break the loop on write failure
  }
}

/**
 * Get the list of active tasks from the session (parallel mode).
 * Falls back to single activeTask for backward compat.
 */
export async function getActiveTasks(workspace: string): Promise<ActiveTask[]> {
  try {
    const session = await readSession(workspace);
    if (!session) return [];
    // Prefer activeTasks array, fall back to single activeTask
    if (session.activeTasks && session.activeTasks.length > 0) {
      return session.activeTasks;
    }
    if (session.activeTask) {
      return [session.activeTask];
    }
    return [];
  } catch {
    return [];
  }
}

