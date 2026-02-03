import * as fs from 'fs/promises';
import * as path from 'path';
import { FeatureSession } from '../types/feature.js';
import { SessionPhase } from '../types/index.js';
import { getFeatureRequirementsPath, getFeatureProgressPath } from './config.js';

function getFeatureSessionPath(workspace: string, feature: string): string {
  return path.join(workspace, '.devloop', 'features', `${feature}.json`);
}

export async function readFeatureSession(workspace: string, feature: string): Promise<FeatureSession | null> {
  try {
    const sessionPath = getFeatureSessionPath(workspace, feature);
    const content = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function writeFeatureSession(workspace: string, session: FeatureSession): Promise<void> {
  const sessionPath = getFeatureSessionPath(workspace, session.feature);
  const sessionDir = path.dirname(sessionPath);

  // Ensure .devloop/features directory exists
  await fs.mkdir(sessionDir, { recursive: true });

  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
}

export async function createFeatureSession(
  workspace: string,
  feature: string,
  phase: SessionPhase
): Promise<FeatureSession> {
  const session: FeatureSession = {
    feature,
    phase,
    sessionId: null,
    lastIteration: 0,
    startedAt: new Date().toISOString(),
    requirementsPath: getFeatureRequirementsPath(workspace, feature),
    progressPath: getFeatureProgressPath(workspace, feature)
  };

  await writeFeatureSession(workspace, session);
  return session;
}

export async function updateFeatureSessionIteration(
  workspace: string,
  feature: string,
  iteration: number
): Promise<void> {
  const session = await readFeatureSession(workspace, feature);
  if (!session) {
    throw new Error(`Feature session not found: ${feature}`);
  }

  session.lastIteration = iteration;
  await writeFeatureSession(workspace, session);
}

export async function listFeatures(workspace: string): Promise<string[]> {
  const requirementsDir = path.join(workspace, 'requirements');

  try {
    const files = await fs.readdir(requirementsDir);
    return files
      .filter(file => file.endsWith('.md'))
      .map(file => file.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}
