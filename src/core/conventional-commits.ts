import type { ConventionalType, Task } from '../types/index.js';

const VALID_TYPES: ReadonlyArray<ConventionalType> = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf',
  'test', 'build', 'ci', 'chore', 'revert'
];

const TYPE_PRIORITY: Record<ConventionalType, number> = {
  feat: 10,
  fix: 9,
  perf: 8,
  refactor: 7,
  revert: 6,
  build: 5,
  ci: 4,
  test: 3,
  docs: 2,
  style: 1,
  chore: 0,
};

const TASK_ID_REGEX = /^TASK-(\d+)([a-z]*)$/i;

/** Convert "TASK-001" → "T1", preserves letter suffix. Returns input unchanged if non-matching. */
export function formatTaskIdShort(taskId: string): string {
  const match = taskId.match(TASK_ID_REGEX);
  if (!match) return taskId;
  return `T${parseInt(match[1], 10)}${match[2].toLowerCase()}`;
}

/** Validate a type string against the whitelist. Unknown or missing → 'chore'. */
export function normalizeType(type: string | undefined | null): ConventionalType {
  if (!type) return 'chore';
  const lower = type.toLowerCase();
  if ((VALID_TYPES as ReadonlyArray<string>).includes(lower)) {
    return lower as ConventionalType;
  }
  // Spec: unknown values warn and fall back to chore so semver tooling doesn't bump.
  console.warn(`DevLoop: unknown task type "${type}" — falling back to "chore"`);
  return 'chore';
}

/** Resolve a list of types to the highest-priority one. Empty list → 'chore'. */
export function priorityType(types: ReadonlyArray<ConventionalType>): ConventionalType {
  if (types.length === 0) return 'chore';
  return types.reduce<ConventionalType>(
    (best, t) => (TYPE_PRIORITY[t] > TYPE_PRIORITY[best] ? t : best),
    'chore'
  );
}

export interface ConventionalMessage {
  subject: string;
  body?: string;
}

export function buildPlainMessage(action: string, type?: ConventionalType): ConventionalMessage {
  const t = normalizeType(type);
  return { subject: `${t}: ${action}` };
}

export type SingleTaskOutcome = 'completed' | 'attempted' | 'interrupted';

export interface SingleTaskOptions {
  outcome: SingleTaskOutcome;
}

export function buildSingleTaskMessage(task: Task, opts: SingleTaskOptions): ConventionalMessage {
  const shortId = formatTaskIdShort(task.id);
  const isCompleted = opts.outcome === 'completed';
  const subjectType: ConventionalType = isCompleted ? normalizeType(task.type) : 'chore';
  const marker = opts.outcome === 'attempted' ? ' (attempted)'
    : opts.outcome === 'interrupted' ? ' (interrupted)'
    : '';
  const subject = `${subjectType}: ${shortId}${marker} - ${task.title}`;

  let body: string | undefined;
  if (isCompleted && task.breakingChange) {
    body = `BREAKING CHANGE: ${task.breakingChange}`;
  }
  return { subject, body };
}

export function buildBatchMessage(tasks: ReadonlyArray<Task>, succeededIds: ReadonlyArray<string>): ConventionalMessage {
  const succeededSet = new Set(succeededIds);
  const succeededTasks = tasks.filter(t => succeededSet.has(t.id));
  const failedTasks = tasks.filter(t => !succeededSet.has(t.id));

  // Subject IDs: succeeded only. If none succeeded, fall back to all IDs.
  const subjectTaskIds = succeededTasks.length > 0 ? succeededTasks : Array.from(tasks);
  const idList = subjectTaskIds.map(t => formatTaskIdShort(t.id)).join(', ');

  const subjectType = succeededTasks.length > 0
    ? priorityType(succeededTasks.map(t => normalizeType(t.type)))
    : 'chore';

  const subject = `${subjectType}: ${idList}`;

  // Body: each succeeded task with its true type; each failed task as chore (failed).
  const bodyLines: string[] = [];
  for (const t of succeededTasks) {
    bodyLines.push(`- ${normalizeType(t.type)}: ${formatTaskIdShort(t.id)} - ${t.title}`);
  }
  for (const t of failedTasks) {
    bodyLines.push(`- chore: ${formatTaskIdShort(t.id)} (failed) - ${t.title}`);
  }

  // Breaking footers: only succeeded tasks with breakingChange contribute.
  const breakingFooters = succeededTasks
    .filter(t => t.breakingChange)
    .map(t => `BREAKING CHANGE: ${t.breakingChange}`);
  if (breakingFooters.length > 0) {
    bodyLines.push('', ...breakingFooters);
  }

  const body = bodyLines.length > 0 ? bodyLines.join('\n') : undefined;
  return { subject, body };
}
