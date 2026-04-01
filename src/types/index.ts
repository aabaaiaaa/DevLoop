export type TaskStatus = 'pending' | 'in-progress' | 'done';
export type ExitStatus = 'success' | 'error';
export type SessionPhase = 'init' | 'run';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  dependencies: string[];
  description: string;
  verification: string;
}

export interface TaskList {
  projectName: string;
  created: string;
  author: string;
  tasks: Task[];
}

export interface IterationLog {
  iteration: number;
  timestamp: string;
  taskAttempted?: string;
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

export interface ActiveTask {
  taskId: string;
  taskTitle: string;
  iterationNumber: number;
  startedAt: string;
}

export interface Session {
  phase: SessionPhase;
  sessionId: string | null;
  lastIteration: number;
  startedAt: string;
  activeTask?: ActiveTask | null;
  iteration: number;  // 1-based requirements iteration count
  devloopVersion?: string;
}

export interface GlobalConfig {
  defaultWorkspace: string | null;
  maxIterations: number;
}

export interface DevLoopConfig {
  maxIterations: number;
  requirementsPath: string;
  tasksPath: string;
  progressPath: string;
  workspacePath: string;
  verbose: boolean;
  dryRun: boolean;
  tokenLimit?: number;  // Stop if session tokens exceed this limit
  costLimit?: number;   // Stop if session cost (USD) exceeds this limit
  sessionAction?: 'create' | 'update' | 'none';  // Session modification to perform after uncommitted check
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
  rawOutput: string;
  error?: string;
  errorType?: ClaudeErrorType;
  duration: number;
  sessionId?: string;
  tokenUsage?: TokenUsage;
  exitCode?: number | null;
  signal?: string | null;
}

export interface WorkspaceConfig {
  /** Format for all DevLoop commits. Use {action} placeholder. */
  devloopCommitFormat?: string;
}
