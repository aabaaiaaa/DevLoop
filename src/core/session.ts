import * as fs from 'fs/promises';
import * as path from 'path';
import { Session, SessionPhase } from '../types/index.js';
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

