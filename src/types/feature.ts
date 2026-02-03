import { SessionPhase } from './index.js';

export interface FeatureSession {
  feature: string;
  phase: SessionPhase;
  sessionId: string | null;
  lastIteration: number;
  startedAt: string;
  requirementsPath: string;
  progressPath: string;
}

export interface WorkspaceConfig {
  commitMessageFormat?: string;
  commitMessageFormatFailed?: string;
}
