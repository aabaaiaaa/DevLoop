import { SessionPhase, ActiveTask } from './index.js';

export interface FeatureSession {
  feature: string;
  phase: SessionPhase;
  sessionId: string | null;
  lastIteration: number;
  startedAt: string;
  requirementsPath: string;
  progressPath: string;
  activeTask?: ActiveTask | null;
}

export interface WorkspaceConfig {
  /** Format for all DevLoop commits. Use {action} placeholder. */
  devloopCommitFormat?: string;
}
