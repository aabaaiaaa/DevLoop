export type TaskStatus = 'pending' | 'in-progress' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';
export type ExitStatus = 'success' | 'error' | 'partial';
export type SessionPhase = 'init' | 'run';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dependencies: string[];
  description: string;
}

export interface Requirements {
  projectName: string;
  created: string;
  author: string;
  tasks: Task[];
}

export interface IterationLog {
  iteration: number;
  timestamp: string;
  taskCompleted: string | null;
  summary: string;
  duration: string;
  exitStatus: ExitStatus;
  errorType?: ClaudeErrorType;
  errorDetail?: string;
  tokenUsage?: TokenUsage;
}

export interface Progress {
  totalTasks: number;
  completed: number;
  remaining: number;
  lastUpdated: string;
  iterations: IterationLog[];
}

export interface Session {
  phase: SessionPhase;
  sessionId: string | null;
  lastIteration: number;
  startedAt: string;
}

export interface GlobalConfig {
  defaultWorkspace: string | null;
  maxIterations: number;
}

export interface DevLoopConfig {
  maxIterations: number;
  requirementsPath: string;
  progressPath: string;
  workspacePath: string;
  verbose: boolean;
  dryRun: boolean;
  tokenLimit?: number;  // Stop if session tokens exceed this limit
  featureName?: string;  // Optional feature name for feature mode
}

export type ClaudeErrorType =
  | 'rate_limit'      // 400/429 rate limit errors
  | 'api_overload'    // 503 overloaded
  | 'auth_error'      // 401 unauthorized
  | 'network_error'   // Connection issues
  | 'task_failure'    // Actual task failed (not an API error)
  | 'unknown';        // Unclassified error

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
  errorType?: ClaudeErrorType;
  duration: number;
  sessionId?: string;
  tokenUsage?: TokenUsage;
}

// Re-export feature types
export * from './feature.js';
