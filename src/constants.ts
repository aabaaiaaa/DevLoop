export const TASK_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in-progress',
  DONE: 'done'
} as const;

export const TASK_PRIORITY = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
} as const;

export const FILES = {
  REQUIREMENTS: 'requirements.md',
  PROGRESS: 'progress.md',
  SESSION: 'session.json'
} as const;

export const DIRS = {
  DEVLOOP: '.devloop',
  CLAUDE: '.claude'
} as const;

export const TASK_PREFIX = 'TASK-';
