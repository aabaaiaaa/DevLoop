# Conventional Commits and Planning Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Conventional Commits the default commit format for DevLoop's auto-generated commits, add `Type` and `Breaking` fields to tasks, encourage finer-grained task decomposition during init/amend, and add a self-review loop on generated requirements/tasks docs.

**Architecture:** A new pure-logic module `src/core/conventional-commits.ts` builds Conventional Commits messages from task metadata. `src/core/git.ts` routes between this builder (default) and the existing `devloopCommitFormat` template (override). The `commitIteration` / `commitInterruptedWork` functions take richer task metadata so the builder can produce per-task subjects, batch bodies, and `BREAKING CHANGE:` footers. Init and amend prompts gain a Phase 4 self-review section and reframed granularity guidance.

**Tech Stack:** TypeScript, Node test runner (`node --test`), tsx, c8 for coverage. Existing patterns: `src/core/git.ts` exports pure helpers tested in `test/git.test.ts`; parsing helpers tested in `test/tasks-parser.test.ts` (or a new file if needed).

---

## File Structure

**New files:**
- `src/core/conventional-commits.ts` — pure module: type whitelist, ID shortener, type priority, message builders. No I/O.
- `test/conventional-commits.test.ts` — unit tests for the builder module.

**Modified files:**
- `src/types/index.ts` — add `ConventionalType` union; extend `Task` with optional `type` and `breakingChange` fields.
- `src/parser/tasks.ts` — extract `Type` and `Breaking` fields.
- `test/tasks-parser.test.ts` — new test cases for the new fields. (Create if it doesn't exist; otherwise add to an existing parser test file.)
- `src/core/git.ts` — new `buildDevloopCommitMessage()` entry point that routes between conventional builder and `devloopCommitFormat`. Update `commitIteration` and `commitInterruptedWork` signatures to accept Task metadata. Update internal callers (`ensureGitRepo`, `.gitignore` auto-commit) to pass plain `chore` context.
- `test/git.test.ts` — extend tests for the new routing and signatures.
- `src/core/loop.ts` — pass Task / Task[] metadata into commit calls. Rebuild batch commit body in conventional format.
- `src/commands/init.ts` — task format docs include `Type` and `Breaking`; granularity guidance reframed; checklist gains self-review item; new Phase 4 self-review section.
- `src/commands/continue.ts` — same prompt updates in `generateAmendClaudeMd` and `generateContinueClaudeMd`. Update amend commit call to plain chore context.
- `src/commands/config.ts` — update help text for `devloopCommitFormat`.
- `CLAUDE.md` (project root) — update Init Behavior, Document Formats, Commit Message Format, Iterative Requirements, Interactive Session Progress sections.
- `README.md` — short note on the new default and task fields.
- `package.json` — bump version to `4.2.0`.

---

## Stage 1: Type system and parsing

### Task 1: Extend Task type with optional Type and Breaking fields

**Files:**
- Modify: `src/types/index.ts:1-12`

- [ ] **Step 1: Add the `ConventionalType` union**

In `src/types/index.ts`, after the existing top-level type aliases (around line 4), add:

```ts
export type ConventionalType =
  | 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'perf'
  | 'test' | 'build' | 'ci' | 'chore' | 'revert';
```

- [ ] **Step 2: Extend the `Task` interface**

Replace the `Task` interface (currently lines 5–12) with:

```ts
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  dependencies: string[];
  description: string;
  verification: string;
  /** Conventional Commits type for this task. Optional — missing defaults to 'chore' at use sites. */
  type?: ConventionalType;
  /** If set, presence triggers a BREAKING CHANGE: footer in the commit. Free-text description. */
  breakingChange?: string;
}
```

- [ ] **Step 3: Run typecheck to confirm no regressions**

Run: `npm run typecheck`
Expected: No errors. (Existing call sites construct `Task` without these fields, which is fine since they're optional.)

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add ConventionalType union and Type/Breaking fields on Task"
```

---

### Task 2: Parse `Type` field from tasks.md

**Files:**
- Test: `test/tasks-parser.test.ts` (create if missing)
- Modify: `src/parser/tasks.ts:1-8` (add regex), `src/parser/tasks.ts:30-75` (parse loop)

- [ ] **Step 1: Check whether `test/tasks-parser.test.ts` exists**

Run: `ls test/tasks-parser.test.ts 2>/dev/null || echo "missing"`

If "missing": create the file with this scaffold:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasksContent } from '../src/parser/tasks.js';
```

- [ ] **Step 2: Write the failing tests for Type parsing**

Append to `test/tasks-parser.test.ts`:

```ts
describe('parseTasksContent — Type field', () => {
  it('parses a valid Type field', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: Build login form.
- **Verification**: npm test -- --grep login
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].type, 'feat');
  });

  it('leaves type undefined when Type field is absent', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Dependencies**: none
- **Description**: Build login form.
- **Verification**: npm test
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].type, undefined);
  });

  it('lowercases the Type value', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Type**: FEAT
- **Dependencies**: none
- **Description**: x
- **Verification**: x
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].type, 'feat');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="Type field"`
Expected: All three tests fail (the parser doesn't extract Type yet).

- [ ] **Step 4: Add the regex**

In `src/parser/tasks.ts`, after line 8 (the existing regex constants), add:

```ts
const TYPE_REGEX = /^\s*-\s*\*\*Type\*\*:\s*(.+)/i;
```

- [ ] **Step 5: Add the parse branch**

In `src/parser/tasks.ts`, inside the `if (currentTask)` block (around line 47, after the `verifyMatch` branch around line 69-73), add:

```ts
const typeMatch = line.match(TYPE_REGEX);
if (typeMatch) {
  currentTask.type = typeMatch[1].trim().toLowerCase() as Task['type'];
  continue;
}
```

(The `as Task['type']` cast is fine — value validation happens in `normalizeType()` at use time, not at parse time, so unknown strings flow through. We do not warn here; the warning lives in `normalizeType()`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="Type field"`
Expected: All three tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/parser/tasks.ts test/tasks-parser.test.ts
git commit -m "feat: parse Type field from tasks.md"
```

---

### Task 3: Parse `Breaking` field from tasks.md

**Files:**
- Test: `test/tasks-parser.test.ts`
- Modify: `src/parser/tasks.ts`

- [ ] **Step 1: Write failing tests for Breaking parsing**

Append to `test/tasks-parser.test.ts`:

```ts
describe('parseTasksContent — Breaking field', () => {
  it('parses a Breaking field as the breakingChange string', () => {
    const content = `### TASK-001: Rewrite API
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: x
- **Verification**: x
- **Breaking**: New /v2 endpoints require auth header.
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].breakingChange, 'New /v2 endpoints require auth header.');
  });

  it('leaves breakingChange undefined when Breaking field is absent', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: x
- **Verification**: x
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].breakingChange, undefined);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="Breaking field"`
Expected: Both tests fail.

- [ ] **Step 3: Add the regex**

In `src/parser/tasks.ts`, after the `TYPE_REGEX` line you added in Task 2:

```ts
const BREAKING_REGEX = /^\s*-\s*\*\*Breaking\*\*:\s*(.+)/i;
```

- [ ] **Step 4: Add the parse branch**

In `src/parser/tasks.ts`, after the `typeMatch` branch you added in Task 2:

```ts
const breakingMatch = line.match(BREAKING_REGEX);
if (breakingMatch) {
  currentTask.breakingChange = breakingMatch[1].trim();
  continue;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="Breaking field"`
Expected: Both tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/parser/tasks.ts test/tasks-parser.test.ts
git commit -m "feat: parse Breaking field from tasks.md"
```

---

## Stage 2: Conventional Commits builder module

### Task 4: Create module with `formatTaskIdShort`, `normalizeType`, `priorityType`

**Files:**
- Create: `src/core/conventional-commits.ts`
- Create: `test/conventional-commits.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/conventional-commits.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTaskIdShort,
  normalizeType,
  priorityType
} from '../src/core/conventional-commits.js';

describe('formatTaskIdShort', () => {
  it('strips leading zeros', () => {
    assert.equal(formatTaskIdShort('TASK-001'), 'T1');
    assert.equal(formatTaskIdShort('TASK-014'), 'T14');
    assert.equal(formatTaskIdShort('TASK-100'), 'T100');
  });

  it('preserves letter suffix', () => {
    assert.equal(formatTaskIdShort('TASK-001a'), 'T1a');
    assert.equal(formatTaskIdShort('TASK-014b'), 'T14b');
  });

  it('returns the input unchanged for non-matching ids', () => {
    assert.equal(formatTaskIdShort('REVIEW'), 'REVIEW');
    assert.equal(formatTaskIdShort('VERIFICATION'), 'VERIFICATION');
  });
});

describe('normalizeType', () => {
  it('returns the type when it is in the whitelist', () => {
    assert.equal(normalizeType('feat'), 'feat');
    assert.equal(normalizeType('fix'), 'fix');
    assert.equal(normalizeType('chore'), 'chore');
  });

  it('returns chore for undefined', () => {
    assert.equal(normalizeType(undefined), 'chore');
  });

  it('returns chore for unknown values', () => {
    assert.equal(normalizeType('wip'), 'chore');
    assert.equal(normalizeType(''), 'chore');
  });

  it('is case-insensitive', () => {
    assert.equal(normalizeType('FEAT'), 'feat');
    assert.equal(normalizeType('Fix'), 'fix');
  });
});

describe('priorityType', () => {
  it('returns chore for an empty input', () => {
    assert.equal(priorityType([]), 'chore');
  });

  it('promotes feat above all other types', () => {
    assert.equal(priorityType(['feat', 'chore']), 'feat');
    assert.equal(priorityType(['chore', 'feat']), 'feat');
    assert.equal(priorityType(['fix', 'feat', 'docs']), 'feat');
  });

  it('promotes fix when no feat is present', () => {
    assert.equal(priorityType(['fix', 'chore']), 'fix');
    assert.equal(priorityType(['docs', 'fix', 'test']), 'fix');
  });

  it('uses the full priority order: perf > refactor > revert > build > ci > test > docs > style > chore', () => {
    assert.equal(priorityType(['perf', 'refactor']), 'perf');
    assert.equal(priorityType(['refactor', 'revert']), 'refactor');
    assert.equal(priorityType(['revert', 'build']), 'revert');
    assert.equal(priorityType(['build', 'ci']), 'build');
    assert.equal(priorityType(['ci', 'test']), 'ci');
    assert.equal(priorityType(['test', 'docs']), 'test');
    assert.equal(priorityType(['docs', 'style']), 'docs');
    assert.equal(priorityType(['style', 'chore']), 'style');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="formatTaskIdShort|normalizeType|priorityType"`
Expected: Module not found error or test failures.

- [ ] **Step 3: Create the module**

Create `src/core/conventional-commits.ts`:

```ts
import { ConventionalType } from '../types/index.js';

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="formatTaskIdShort|normalizeType|priorityType"`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/conventional-commits.ts test/conventional-commits.test.ts
git commit -m "feat: add conventional-commits module with id shortener and type helpers"
```

---

### Task 5: Add `buildPlainMessage` (for init / amend / review / verification / .gitignore commits)

**Files:**
- Modify: `src/core/conventional-commits.ts`, `test/conventional-commits.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/conventional-commits.test.ts`:

```ts
import { buildPlainMessage } from '../src/core/conventional-commits.js';

describe('buildPlainMessage', () => {
  it('builds a chore subject by default', () => {
    const result = buildPlainMessage('Initialize workspace');
    assert.equal(result.subject, 'chore: Initialize workspace');
    assert.equal(result.body, undefined);
  });

  it('uses the provided type', () => {
    const result = buildPlainMessage('Update changelog', 'docs');
    assert.equal(result.subject, 'docs: Update changelog');
  });

  it('rejects an unknown type and falls back to chore', () => {
    const result = buildPlainMessage('do something', 'wip' as any);
    assert.equal(result.subject, 'chore: do something');
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test -- --test-name-pattern="buildPlainMessage"`
Expected: Module export not found.

- [ ] **Step 3: Add the function**

Append to `src/core/conventional-commits.ts`:

```ts
export interface ConventionalMessage {
  subject: string;
  body?: string;
}

export function buildPlainMessage(action: string, type?: ConventionalType): ConventionalMessage {
  const t = normalizeType(type);
  return { subject: `${t}: ${action}` };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- --test-name-pattern="buildPlainMessage"`
Expected: All three pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/conventional-commits.ts test/conventional-commits.test.ts
git commit -m "feat: add buildPlainMessage for non-task commits"
```

---

### Task 6: Add `buildSingleTaskMessage` (with BREAKING CHANGE footer)

**Files:**
- Modify: `src/core/conventional-commits.ts`, `test/conventional-commits.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/conventional-commits.test.ts`:

```ts
import { buildSingleTaskMessage } from '../src/core/conventional-commits.js';
import type { Task } from '../src/types/index.js';

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'TASK-014',
    title: 'Add token tracking',
    status: 'pending',
    dependencies: [],
    description: '',
    verification: '',
    type: 'feat',
    ...overrides,
  };
}

describe('buildSingleTaskMessage', () => {
  it('builds a completed-task subject using the task type', () => {
    const t = makeTask({});
    const result = buildSingleTaskMessage(t, { outcome: 'completed' });
    assert.equal(result.subject, 'feat: T14 - Add token tracking');
    assert.equal(result.body, undefined);
  });

  it('uses chore for an attempted/failed task regardless of task type', () => {
    const t = makeTask({ type: 'feat' });
    const result = buildSingleTaskMessage(t, { outcome: 'attempted' });
    assert.equal(result.subject, 'chore: T14 (attempted) - Add token tracking');
  });

  it('uses chore with (interrupted) marker', () => {
    const t = makeTask({ type: 'fix' });
    const result = buildSingleTaskMessage(t, { outcome: 'interrupted' });
    assert.equal(result.subject, 'chore: T14 (interrupted) - Add token tracking');
  });

  it('falls back to chore when task type is missing', () => {
    const t = makeTask({ type: undefined });
    const result = buildSingleTaskMessage(t, { outcome: 'completed' });
    assert.equal(result.subject, 'chore: T14 - Add token tracking');
  });

  it('includes a BREAKING CHANGE footer when breakingChange is set on a completed task', () => {
    const t = makeTask({ breakingChange: 'New /v2 endpoints require auth header.' });
    const result = buildSingleTaskMessage(t, { outcome: 'completed' });
    assert.equal(result.subject, 'feat: T14 - Add token tracking');
    assert.equal(result.body, 'BREAKING CHANGE: New /v2 endpoints require auth header.');
  });

  it('does not include a BREAKING CHANGE footer for attempted tasks', () => {
    const t = makeTask({ breakingChange: 'something breaks' });
    const result = buildSingleTaskMessage(t, { outcome: 'attempted' });
    assert.equal(result.body, undefined);
  });

  it('preserves letter suffixes in subject', () => {
    const t = makeTask({ id: 'TASK-001a' });
    const result = buildSingleTaskMessage(t, { outcome: 'completed' });
    assert.equal(result.subject, 'feat: T1a - Add token tracking');
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test -- --test-name-pattern="buildSingleTaskMessage"`
Expected: Module export not found.

- [ ] **Step 3: Add the function**

Append to `src/core/conventional-commits.ts`:

```ts
import type { Task } from '../types/index.js';

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
```

(Replace the existing `import { ConventionalType } from ...` line at the top with `import type { ConventionalType, Task } from '../types/index.js';` to merge the imports.)

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- --test-name-pattern="buildSingleTaskMessage"`
Expected: All seven pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/conventional-commits.ts test/conventional-commits.test.ts
git commit -m "feat: add buildSingleTaskMessage with breaking-change footer"
```

---

### Task 7: Add `buildBatchMessage` (with priority resolution, body, and breaking footers)

**Files:**
- Modify: `src/core/conventional-commits.ts`, `test/conventional-commits.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/conventional-commits.test.ts`:

```ts
import { buildBatchMessage } from '../src/core/conventional-commits.js';

describe('buildBatchMessage', () => {
  it('builds subject from succeeded task IDs and promotes the highest-priority type', () => {
    const tasks: Task[] = [
      makeTask({ id: 'TASK-001', title: 'Add token tracking', type: 'feat' }),
      makeTask({ id: 'TASK-002', title: 'Handle CRLF', type: 'fix' }),
      makeTask({ id: 'TASK-003', title: 'Update docs', type: 'docs' }),
    ];
    const result = buildBatchMessage(tasks, ['TASK-001', 'TASK-002', 'TASK-003']);
    assert.equal(result.subject, 'feat: T1, T2, T3');
    assert.equal(
      result.body,
      [
        '- feat: T1 - Add token tracking',
        '- fix: T2 - Handle CRLF',
        '- docs: T3 - Update docs',
      ].join('\n')
    );
  });

  it('demotes failed tasks to chore in body and excludes them from subject IDs', () => {
    const tasks: Task[] = [
      makeTask({ id: 'TASK-001', title: 'Add login', type: 'feat' }),
      makeTask({ id: 'TASK-002', title: 'Failed task', type: 'feat' }),
    ];
    const result = buildBatchMessage(tasks, ['TASK-001']);
    assert.equal(result.subject, 'feat: T1');
    assert.equal(
      result.body,
      [
        '- feat: T1 - Add login',
        '- chore: T2 (failed) - Failed task',
      ].join('\n')
    );
  });

  it('falls back to chore in subject when no tasks succeeded', () => {
    const tasks: Task[] = [
      makeTask({ id: 'TASK-001', title: 'A', type: 'feat' }),
      makeTask({ id: 'TASK-002', title: 'B', type: 'fix' }),
    ];
    const result = buildBatchMessage(tasks, []);
    assert.equal(result.subject, 'chore: T1, T2');
  });

  it('includes BREAKING CHANGE footers only for succeeded tasks with breakingChange', () => {
    const tasks: Task[] = [
      makeTask({ id: 'TASK-001', title: 'A', type: 'feat', breakingChange: 'first break' }),
      makeTask({ id: 'TASK-002', title: 'B', type: 'feat', breakingChange: 'second break' }),
      makeTask({ id: 'TASK-003', title: 'C', type: 'feat', breakingChange: 'failed break' }),
    ];
    const result = buildBatchMessage(tasks, ['TASK-001', 'TASK-002']);
    const lines = result.body!.split('\n');
    assert.deepEqual(lines.slice(-2), [
      'BREAKING CHANGE: first break',
      'BREAKING CHANGE: second break',
    ]);
    // The failed task's breakingChange must NOT appear:
    assert.equal(lines.some(l => l.includes('failed break')), false);
  });

  it('treats missing task type as chore', () => {
    const tasks: Task[] = [
      makeTask({ id: 'TASK-001', title: 'A', type: undefined }),
    ];
    const result = buildBatchMessage(tasks, ['TASK-001']);
    assert.equal(result.subject, 'chore: T1');
    assert.equal(result.body, '- chore: T1 - A');
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test -- --test-name-pattern="buildBatchMessage"`
Expected: Module export not found.

- [ ] **Step 3: Add the function**

Append to `src/core/conventional-commits.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- --test-name-pattern="buildBatchMessage"`
Expected: All five pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/conventional-commits.ts test/conventional-commits.test.ts
git commit -m "feat: add buildBatchMessage with priority resolution and breaking footers"
```

---

## Stage 3: Git integration

### Task 8: Add `buildDevloopCommitMessage` routing entry point in git.ts

**Files:**
- Modify: `src/core/git.ts:1-52`, `test/git.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/git.test.ts`:

```ts
import { buildDevloopCommitMessageFromContext } from '../src/core/git.js';
import type { Task } from '../src/types/index.js';

function task(o: Partial<Task>): Task {
  return {
    id: 'TASK-001', title: 'X', status: 'pending', dependencies: [],
    description: '', verification: '', type: 'feat', ...o,
  };
}

describe('buildDevloopCommitMessageFromContext', () => {
  it('uses conventional builder when format is undefined (plain action)', () => {
    const msg = buildDevloopCommitMessageFromContext(undefined, {
      kind: 'plain', action: 'Initialize workspace', type: 'chore',
    });
    assert.equal(msg.subject, 'chore: Initialize workspace');
    assert.equal(msg.body, undefined);
  });

  it('uses conventional builder when format is undefined (single task completed)', () => {
    const t = task({ id: 'TASK-014', title: 'Add tracking', type: 'feat' });
    const msg = buildDevloopCommitMessageFromContext(undefined, {
      kind: 'single-task', task: t, outcome: 'completed',
    });
    assert.equal(msg.subject, 'feat: T14 - Add tracking');
  });

  it('uses conventional builder for batch context', () => {
    const tasks = [
      task({ id: 'TASK-001', title: 'A', type: 'feat' }),
      task({ id: 'TASK-002', title: 'B', type: 'fix' }),
    ];
    const msg = buildDevloopCommitMessageFromContext(undefined, {
      kind: 'batch', tasks, succeededIds: ['TASK-001', 'TASK-002'],
    });
    assert.equal(msg.subject, 'feat: T1, T2');
  });

  it('uses template substitution when format is set (plain action)', () => {
    const msg = buildDevloopCommitMessageFromContext('chore(devloop): {action}', {
      kind: 'plain', action: 'Initialize workspace',
    });
    assert.equal(msg.subject, 'chore(devloop): Initialize workspace');
    assert.equal(msg.body, undefined);
  });

  it('uses template substitution when format is set (single task) — preserves legacy action text', () => {
    const t = task({ id: 'TASK-014', title: 'Add tracking', type: 'feat' });
    const msg = buildDevloopCommitMessageFromContext('chore(devloop): {action}', {
      kind: 'single-task', task: t, outcome: 'completed',
    });
    assert.equal(msg.subject, 'chore(devloop): Complete TASK-014 - Add tracking');
  });

  it('template path with attempted task uses "Attempted" verb', () => {
    const t = task({ id: 'TASK-014', title: 'Add tracking', type: 'feat' });
    const msg = buildDevloopCommitMessageFromContext('chore(devloop): {action}', {
      kind: 'single-task', task: t, outcome: 'attempted',
    });
    assert.equal(msg.subject, 'chore(devloop): Attempted TASK-014 - Add tracking');
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test -- --test-name-pattern="buildDevloopCommitMessageFromContext"`
Expected: Export not found.

- [ ] **Step 3: Add the routing function in git.ts**

In `src/core/git.ts`, replace the import block at lines 1–5 with:

```ts
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import chalk from 'chalk';
import type { Task, ConventionalType } from '../types/index.js';
import { readWorkspaceConfig, writeWorkspaceConfig } from './config.js';
import {
  buildPlainMessage,
  buildSingleTaskMessage,
  buildBatchMessage,
  type ConventionalMessage,
  type SingleTaskOutcome,
} from './conventional-commits.js';
```

`ConventionalType` is defined in `types/index.ts` (Task 1), not in `conventional-commits.ts`. `ConventionalMessage` and `SingleTaskOutcome` are defined in `conventional-commits.ts` (Tasks 5, 6).

After `formatDevloopCommit` (around line 16), add:

```ts
/**
 * Context for building a DevLoop commit message.
 * 'plain' is for non-task commits (init, amend, review, verification, .gitignore).
 * 'single-task' is for single-task iteration commits and interrupted-work commits.
 * 'batch' is for batch iteration commits.
 */
export type DevloopCommitContext =
  | { kind: 'plain'; action: string; type?: ConventionalType }
  | { kind: 'single-task'; task: Task; outcome: SingleTaskOutcome }
  | { kind: 'batch'; tasks: ReadonlyArray<Task>; succeededIds: ReadonlyArray<string> };

/** Build the action string used by the legacy template path. */
function legacyAction(ctx: DevloopCommitContext): string {
  if (ctx.kind === 'plain') return ctx.action;
  if (ctx.kind === 'single-task') {
    const verb =
      ctx.outcome === 'completed' ? 'Complete'
      : ctx.outcome === 'attempted' ? 'Attempted'
      : 'Interrupted work on';
    if (ctx.outcome === 'interrupted') {
      return `Interrupted work on ${ctx.task.id} - ${ctx.task.title}`;
    }
    return `${verb} ${ctx.task.id} - ${ctx.task.title}`;
  }
  // batch
  const succeededTasks = ctx.tasks.filter(t => ctx.succeededIds.includes(t.id));
  const ids = ctx.tasks.map(t => t.id).join(', ');
  if (succeededTasks.length === ctx.tasks.length) return `Complete batch: ${ids}`;
  if (succeededTasks.length === 0) return `Attempted batch: ${ids}`;
  return `Partial batch: ${succeededTasks.map(t => t.id).join(', ')} succeeded`;
}

/**
 * Build the commit message from a context. If `format` is set, use template substitution
 * (legacy path). If unset, build a Conventional Commits message from the context.
 */
export function buildDevloopCommitMessageFromContext(
  format: string | undefined,
  ctx: DevloopCommitContext
): ConventionalMessage {
  if (format) {
    const action = legacyAction(ctx);
    return { subject: format.replace(/\{action\}/g, action).trim() };
  }
  if (ctx.kind === 'plain') {
    return buildPlainMessage(ctx.action, ctx.type);
  }
  if (ctx.kind === 'single-task') {
    return buildSingleTaskMessage(ctx.task, { outcome: ctx.outcome });
  }
  return buildBatchMessage(ctx.tasks, ctx.succeededIds);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- --test-name-pattern="buildDevloopCommitMessageFromContext"`
Expected: All six pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/git.ts test/git.test.ts
git commit -m "feat: add buildDevloopCommitMessageFromContext routing helper"
```

---

### Task 9: Update `commitIteration` to accept context, route via the new helper

**Files:**
- Modify: `src/core/git.ts:539-583`

- [ ] **Step 1: Replace the `commitIteration` function**

In `src/core/git.ts`, replace the existing `commitIteration` function (lines 539–583) with:

```ts
/**
 * Commit changes after an iteration. Single-task and batch variants share this entry point;
 * the caller passes a context that describes which kind of commit it is.
 */
export async function commitIteration(
  workspace: string,
  iteration: number,
  ctx: DevloopCommitContext,
  verbose: boolean = false
): Promise<{ committed: boolean; hookFailure?: boolean }> {
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) return { committed: false };

  const isRepo = await isGitRepo(workspace);
  if (!isRepo) return { committed: false };

  const workspaceConfig = await readWorkspaceConfig(workspace);
  const message = buildDevloopCommitMessageFromContext(workspaceConfig.devloopCommitFormat, ctx);

  const result = await gitCommit(workspace, message.subject, verbose, message.body);

  if (verbose && result.committed) {
    console.log(chalk.gray(`  Git: Committed iteration ${iteration}`));
  } else if (result.isHookFailure) {
    return { committed: false, hookFailure: true };
  } else if (result.error) {
    console.log(chalk.yellow(`  Git: Commit failed - ${result.error}`));
  }

  return { committed: result.committed };
}
```

- [ ] **Step 2: Run typecheck — expect breakages at call sites**

Run: `npm run typecheck`
Expected: Errors at every existing `commitIteration(...)` call site (loop.ts and git.ts internal). Those will be fixed in subsequent tasks.

- [ ] **Step 3: Note the call sites that need fixing**

Files where the build breaks (we'll fix them in tasks 11, 12, 13, 17):
- `src/core/loop.ts:338` (review commit)
- `src/core/loop.ts:530` (verification fixes commit)
- `src/core/loop.ts:1392-1395` (batch commit)
- `src/core/loop.ts:1578-1581` (single-task commit)

Do **not** commit yet — the build is broken.

---

### Task 10: Update `commitInterruptedWork` to accept context

**Files:**
- Modify: `src/core/git.ts:494-536`

- [ ] **Step 1: Replace the `commitInterruptedWork` function**

In `src/core/git.ts`, replace `commitInterruptedWork` (lines 494–536) with:

```ts
/**
 * Commit uncommitted changes from a previous interrupted session.
 * `task` is optional — pass it when we know which task was active.
 */
export async function commitInterruptedWork(
  workspace: string,
  task?: Task,
  verbose: boolean = false
): Promise<boolean> {
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) return false;

  const isRepo = await isGitRepo(workspace);
  if (!isRepo) return false;

  const workspaceConfig = await readWorkspaceConfig(workspace);

  const ctx: DevloopCommitContext = task
    ? { kind: 'single-task', task, outcome: 'interrupted' }
    : { kind: 'plain', action: 'Interrupted work from previous session' };

  const message = buildDevloopCommitMessageFromContext(workspaceConfig.devloopCommitFormat, ctx);
  const result = await gitCommit(workspace, message.subject, verbose, message.body);

  if (verbose && result.committed) {
    console.log(chalk.gray(`  Git: Committed interrupted work`));
  } else if (result.error) {
    console.log(chalk.yellow(`  Git: Failed to commit interrupted work - ${result.error}`));
  }

  return result.committed;
}
```

- [ ] **Step 2: Find loop.ts call site for `commitInterruptedWork`**

Run: `grep -n "commitInterruptedWork" src/core/loop.ts`

Note the line number(s); these need updating to pass a Task object (or undefined). This is fixed in Task 11.

- [ ] **Step 3: Update internal git.ts callers (initial commit, .gitignore commit)**

In `src/core/git.ts`, find `getDevloopCommitMessage(workspace, 'Update .gitignore')` (around line 357) and `getDevloopCommitMessage(workspace, 'Initial commit')` (around line 384). Replace each with:

For the .gitignore commit:
```ts
const config = await readWorkspaceConfig(workspace);
const msg = buildDevloopCommitMessageFromContext(config.devloopCommitFormat, {
  kind: 'plain', action: 'Update .gitignore', type: 'chore',
});
const result = await execGit(['commit', '-m', msg.subject], gitRoot);
```

For the initial commit:
```ts
const config = await readWorkspaceConfig(workspace);
const msg = buildDevloopCommitMessageFromContext(config.devloopCommitFormat, {
  kind: 'plain', action: 'Initial commit', type: 'chore',
});
const commitResult = await gitCommit(workspace, msg.subject, verbose);
```

(Both replace the prior `const commitMsg = await getDevloopCommitMessage(...)` lines and the line that uses `commitMsg`.)

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Still failing at loop.ts call sites (those are fixed in next tasks). git.ts internals should now compile.

Do **not** commit yet — the build is broken until Task 13.

---

## Stage 4: Loop integration

### Task 11: Update single-task `commitIteration` call in loop.ts

**Files:**
- Modify: `src/core/loop.ts` around line 1577–1586

- [ ] **Step 1: Replace the call**

Find the block (around lines 1577–1586):
```ts
if (!overrides?.skipGit) {
  const commitResult = await commitIteration(
    config.workspacePath, taskIteration,
    task.id, task.title, true, config.verbose
  );
  if (commitResult.hookFailure) {
    hookFailureDetected = true;
    console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
  }
}
```

Replace with:
```ts
if (!overrides?.skipGit) {
  const commitResult = await commitIteration(
    config.workspacePath,
    taskIteration,
    { kind: 'single-task', task, outcome: 'completed' },
    config.verbose
  );
  if (commitResult.hookFailure) {
    hookFailureDetected = true;
    console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
  }
}
```

- [ ] **Step 2: Update the `commitInterruptedWork` call site**

Find the call to `commitInterruptedWork` in loop.ts (use `grep -n "commitInterruptedWork" src/core/loop.ts`). Update its signature to pass a `Task` object instead of `taskId, taskTitle`. The active task object can be reconstructed from `getActiveTask` data — find where `taskId` and `taskTitle` are read for that call and pass them through into a `Task`-shaped object via `taskList.tasks.find(t => t.id === activeTask.taskId)` (preferred — this gets the real task with its `type` field). If not findable, pass `undefined`.

Concrete change pattern:
```ts
// Before
await commitInterruptedWork(config.workspacePath, activeTask.taskId, activeTask.taskTitle, config.verbose);

// After
const interruptedTask = taskList.tasks.find(t => t.id === activeTask.taskId);
await commitInterruptedWork(config.workspacePath, interruptedTask, config.verbose);
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Single-task path compiles. Batch path still broken.

---

### Task 12: Update batch `commitIteration` call and rebuild batch body in conventional format

**Files:**
- Modify: `src/core/loop.ts` around line 1380–1400

- [ ] **Step 1: Replace the batch commit block**

Find the block (around lines 1380–1395):

```ts
// Commit all batch changes at once
if (!overrides?.skipGit && succeededIds.length > 0) {
  const commitAction = succeededIds.length === batch.length
    ? `Complete batch: ${batchLabel}`
    : `Partial batch: ${succeededIds.join(', ')} succeeded`;
  // Build detailed commit body with each task's title
  const commitBodyLines: string[] = [];
  for (const t of batch) {
    const succeeded = succeededIds.includes(t.id);
    commitBodyLines.push(`${succeeded ? '✓' : '✗'} ${t.id}: ${t.title}`);
  }
  const commitBody = commitBodyLines.join('\n');
  const commitResult = await commitIteration(
    config.workspacePath, taskIteration,
    batchIds[0], commitAction, true, config.verbose, commitBody
  );
  ...
}
```

Replace with:
```ts
// Commit all batch changes at once
if (!overrides?.skipGit && succeededIds.length > 0) {
  const commitResult = await commitIteration(
    config.workspacePath,
    taskIteration,
    { kind: 'batch', tasks: batch, succeededIds },
    config.verbose
  );
  if (commitResult.hookFailure) {
    hookFailureDetected = true;
    console.log(chalk.yellow('\nStopping DevLoop due to commit hook failure.'));
  }
}
```

(The batch-body construction is now inside `buildBatchMessage()`.)

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Batch path compiles. Review and verification commit calls (lines 338 and 530) still broken.

---

### Task 13: Update REVIEW and VERIFICATION commit calls in loop.ts

**Files:**
- Modify: `src/core/loop.ts:338`, `src/core/loop.ts:530`

- [ ] **Step 1: Update the review commit (line 338)**

Replace:
```ts
await commitIteration(config.workspacePath, 0, 'REVIEW', 'Final code review', true, config.verbose);
```

With:
```ts
await commitIteration(
  config.workspacePath,
  0,
  { kind: 'plain', action: 'Final code review', type: 'chore' },
  config.verbose
);
```

- [ ] **Step 2: Update the verification commit (line 530)**

Replace:
```ts
await commitIteration(config.workspacePath, 0, 'VERIFICATION', 'Verification fixes', true, config.verbose);
```

With:
```ts
await commitIteration(
  config.workspacePath,
  0,
  { kind: 'plain', action: 'Verification fixes', type: 'chore' },
  config.verbose
);
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: All loop.ts call sites compile. There may still be issues in `src/commands/continue.ts` (amend commit) — handled in next task.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: All tests pass (parser, git, conventional-commits, integration). Existing integration tests continue to work because they use mock invokers and don't depend on commit message format.

- [ ] **Step 5: Commit**

```bash
git add src/core/git.ts src/core/loop.ts
git commit -m "feat: route DevLoop commits through conventional-commits builder"
```

---

### Task 14: Update amend commit call in continue.ts

**Files:**
- Modify: `src/commands/continue.ts:280-283`

- [ ] **Step 1: Find the existing block**

The current code (around lines 280–283):
```ts
await ensureGitRepo(workspace);
const action = `Amend requirements (Phase ${currentIteration})`;
const commitMessage = await getDevloopCommitMessage(workspace, action);
await commitWithRetry(workspace, commitMessage, action);
```

- [ ] **Step 2: Replace with the new context-aware path**

```ts
await ensureGitRepo(workspace);
const action = `Amend requirements (Phase ${currentIteration})`;
const config = await readWorkspaceConfig(workspace);
const message = buildDevloopCommitMessageFromContext(config.devloopCommitFormat, {
  kind: 'plain', action, type: 'chore',
});
await commitWithRetry(workspace, message.subject, action);
```

- [ ] **Step 3: Update imports at the top of continue.ts**

Replace the import line:
```ts
import { ensureGitRepo, getDevloopCommitMessage } from '../core/git.js';
```

With:
```ts
import { ensureGitRepo, buildDevloopCommitMessageFromContext } from '../core/git.js';
```

(The `readWorkspaceConfig` import is already present via line 5.)

- [ ] **Step 4: Remove the now-unused `getDevloopCommitMessage` function from `src/core/git.ts`**

After Tasks 10 and 14 (this task), `getDevloopCommitMessage` has no remaining callers. Delete its declaration (the block at git.ts:18–24):

```ts
/**
 * Get the DevLoop commit message for an action, using workspace config if available
 */
export async function getDevloopCommitMessage(workspace: string, action: string): Promise<string> {
  const config = await readWorkspaceConfig(workspace);
  return formatDevloopCommit(config.devloopCommitFormat, action);
}
```

`formatDevloopCommit` itself stays — it's still used internally by `buildDevloopCommitMessageFromContext` for the legacy template path.

- [ ] **Step 5: Remove the stale import from `src/commands/init.ts`**

`getDevloopCommitMessage` is imported but unused in init.ts:11. With the symbol gone, TypeScript will fail at this import. Remove `getDevloopCommitMessage` from the destructured imports.

Find: `import { ensureGitRepo, gitCommit, saveDevloopCommitFormat, getDevloopCommitMessage } from '../core/git.js';`

Replace with: `import { ensureGitRepo, gitCommit, saveDevloopCommitFormat } from '../core/git.js';`

(Task 17 will re-add `buildDevloopCommitMessageFromContext` to this import — for now just delete the dead symbol.)

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: Pass. If any other test or call site still references `getDevloopCommitMessage`, it will fail loudly here — investigate and remove it.

- [ ] **Step 7: Commit**

```bash
git add src/commands/continue.ts src/commands/init.ts src/core/git.ts
git commit -m "feat: route amend commits through conventional-commits builder"
```

---

## Stage 5: Prompt updates

### Task 15: Update init.ts task format docs with `Type` and `Breaking` fields

**Files:**
- Modify: `src/commands/init.ts:106-145`

- [ ] **Step 1: Locate the existing task-format block**

Find the markdown task example in `init.ts` around lines 113–124. It currently shows:
```markdown
### TASK-001: Task title here
- **Status**: pending
- **Dependencies**: none
- **Description**: Clear description of what needs to be done. Reference the requirements doc for detail.
- **Verification**: A specific, testable check to confirm the task is complete.
```

- [ ] **Step 2: Replace with the extended format**

Replace the example block (and the second TASK-002 example just below it) with:

```markdown
### TASK-001: Task title here
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: Clear description of what needs to be done. Reference the requirements doc for detail.
- **Verification**: A specific, testable check to confirm the task is complete.

### TASK-002: Another task
- **Status**: pending
- **Type**: fix
- **Dependencies**: TASK-001
- **Description**: This task depends on TASK-001 completing first.
- **Verification**: Run "npm test" and all tests pass.
- **Breaking**: Existing API consumers must add the X-Auth-Version header.
```

- [ ] **Step 3: Add Type/Breaking field documentation**

In the "Task Rules" list (around lines 128–142), add these bullets after the existing Dependencies bullet:

```
- **Type**: one of \`feat\`, \`fix\`, \`docs\`, \`style\`, \`refactor\`, \`perf\`, \`test\`, \`build\`, \`ci\`, \`chore\`, \`revert\`. Pick the type that best describes what the task does. This drives the Conventional Commits prefix on the auto-generated git commit, which in turn drives semver tooling (\`feat\` → minor, \`fix\` → patch, others → no bump). If unsure, use \`chore\`.
- **Breaking** (optional): include this field only when the task introduces a backwards-incompatible change. The text is used verbatim as the body of a \`BREAKING CHANGE:\` footer in the commit. Example: \`- **Breaking**: New /v2 endpoints require an auth header.\`
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts
git commit -m "feat: document Type and Breaking task fields in init prompt"
```

---

### Task 16: Reframe task granularity guidance in init.ts

**Files:**
- Modify: `src/commands/init.ts:128-129`

- [ ] **Step 1: Replace the granularity bullet**

Find this line (currently around line 129):
```
- **Tasks must be small and focused** — each should be completable by an automated AI agent in approximately 10-20 minutes. If a task would take longer, break it into smaller subtasks using letter suffixes. Large tasks will time out and fail.
```

Replace with:
```
- **Tasks must be small and focused.** Each should be completable by an automated AI agent in approximately 10–20 minutes (avoid timeouts). If a task would take longer, break it into smaller subtasks using letter suffixes.
- **Prefer logical decomposition over bundling.** Long-running DevLoop sessions are normal and expected — task count is not a thing to minimize. If a task touches multiple distinct concerns (schema + parser + tests + docs), split it into separate tasks tied by dependencies rather than packing them together. Many fine-grained tasks produce a cleaner per-task commit type.
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/init.ts
git commit -m "docs: reframe task granularity guidance in init prompt"
```

---

### Task 17: Add Phase 4 self-review section and update checklist in init.ts

**Files:**
- Modify: `src/commands/init.ts:41-53` (checklist), `src/commands/init.ts:142-145` (after Phase 3, before exit instruction)

- [ ] **Step 1: Update the checklist (lines 45–51)**

Replace:
```
1. Explore project scope and requirements with user
2. Review for gaps and inconsistencies
3. Write requirements.md
4. Generate tasks.md
5. Tell user to exit session
```

With:
```
1. Explore project scope and requirements with user
2. Review for gaps and inconsistencies
3. Write requirements.md
4. Generate tasks.md
5. Self-review the documents and resolve any major issues
6. Tell user to exit session
```

- [ ] **Step 2: Add the Phase 4 section**

In the template literal, after the line that says "**Do NOT create any files other than requirements.md and tasks.md**" (around line 142), insert a new section *before* the "After writing both documents, tell the user..." line:

```markdown

---

### Phase 4 — Self-review (after both documents are written)

Before telling the user to exit, review what you just wrote. Run up to 3 review passes.

In each pass, look for:

**Major issues** — things that would break execution or contradict the plan. Fix them by editing the documents, then re-run the review:
- Inconsistencies between requirements.md and tasks.md (e.g., requirements mention something that no task covers, or a task references concepts not in requirements)
- Internal contradictions (one section says "use Postgres", another says "use SQLite")
- Missing or broken dependencies (a task depends on an ID that doesn't exist)
- Circular dependencies in the task graph
- Non-sequential or duplicate task IDs
- Tasks missing required fields (\`Type\`, \`Description\`, \`Verification\`)
- Scope drift (tasks doing things requirements don't describe, or vice versa)

**Minor issues** — things where multiple reasonable answers exist. Do NOT auto-fix; collect them for the user:
- Ambiguous or under-specified wording where multiple interpretations are reasonable
- Tasks that could be decomposed further (granularity opinion)
- Ordering choices that could go either way
- Optional features that may be over-scoped

If after pass 3 there are still major issues you cannot resolve, demote them to a "couldn't auto-resolve" list shown alongside minor issues — do not loop further.

When the loop ends, print the minor issues for the user in this format:

\`\`\`
Self-review complete after N pass(es).

Minor issues for your review:
1. ...
2. ...

You can ask me to address any of these, or exit (Ctrl+C) to accept as-is.
\`\`\`

Then wait for the user's decision. If they ask for changes, address them. If they exit, DevLoop commits.
```

- [ ] **Step 3: Verify the file still parses as a valid TS template literal**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 4: Update `detectAndConfigureCommitFormat` (around lines 438–461)**

This function returns the message used for the very first commit (init's initial commit and continue's iteration-start commit). Today it hardcodes `DevLoop: ${action}` as the default. With the new behavior, the default should be the conventional builder's output.

Replace the function body. The current body:
```ts
export async function detectAndConfigureCommitFormat(workspace: string, action: string): Promise<{ message: string; action: string }> {
  const detection = await detectCommitFormat(workspace);
  const defaultMessage = `DevLoop: ${action}`;

  if (detection.detected) {
    // Ask user for initial commit message since hooks are present
    console.log(chalk.yellow(`\nDetected commit message hooks (${detection.source}).`));
    console.log(chalk.cyan('The default message may not pass validation.'));
    console.log(chalk.gray(`  Default: "${defaultMessage}"`));
    console.log(chalk.gray(`  Tip: Use {action} placeholder for reusable format, e.g., "chore(devloop): {action}"`));
    const customMessage = await promptForInput(chalk.cyan('Commit message (press Enter for default): '));

    if (customMessage) {
      // Expand {action} placeholder
      const expanded = customMessage.replace(/\{action\}/g, action);
      // Save the format for future DevLoop commits
      await saveDevloopCommitFormat(workspace, customMessage, action);
      console.log(chalk.gray('Saved commit format for future DevLoop commits.'));
      return { message: expanded, action };
    }
  }

  return { message: defaultMessage, action };
}
```

Should become:
```ts
export async function detectAndConfigureCommitFormat(workspace: string, action: string): Promise<{ message: string; action: string }> {
  const detection = await detectCommitFormat(workspace);
  const config = await readWorkspaceConfig(workspace);
  const defaultMessage = buildDevloopCommitMessageFromContext(config.devloopCommitFormat, {
    kind: 'plain', action, type: 'chore',
  }).subject;

  if (detection.detected) {
    console.log(chalk.yellow(`\nDetected commit message hooks (${detection.source}).`));
    if (detection.source === 'commitlint' && !config.devloopCommitFormat) {
      console.log(chalk.cyan('DevLoop now uses Conventional Commits by default — this should pass commitlint.'));
    } else {
      console.log(chalk.cyan('The default message may not pass validation.'));
    }
    console.log(chalk.gray(`  Default: "${defaultMessage}"`));
    console.log(chalk.gray(`  Tip: Use {action} placeholder for reusable format, e.g., "chore(devloop): {action}"`));
    const customMessage = await promptForInput(chalk.cyan('Commit message (press Enter for default): '));

    if (customMessage) {
      const expanded = customMessage.replace(/\{action\}/g, action);
      await saveDevloopCommitFormat(workspace, customMessage, action);
      console.log(chalk.gray('Saved commit format for future DevLoop commits.'));
      return { message: expanded, action };
    }
  }

  return { message: defaultMessage, action };
}
```

- [ ] **Step 5: Add the imports needed for the new function body**

At the top of `src/commands/init.ts`, `readWorkspaceConfig` is already imported from `'../core/config.js'` (line 6). After Task 14 step 5, the git import line should currently read:

`import { ensureGitRepo, gitCommit, saveDevloopCommitFormat } from '../core/git.js';`

Replace it with:

`import { ensureGitRepo, gitCommit, saveDevloopCommitFormat, buildDevloopCommitMessageFromContext } from '../core/git.js';`

If grep shows `getDevloopCommitMessage` is still in this import, Task 14 step 5 was missed — go back and remove it before continuing.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/init.ts
git commit -m "feat: add Phase 4 self-review and route initial commit through conventional builder"
```

---

### Task 18: Apply the same updates to `generateAmendClaudeMd`

**Files:**
- Modify: `src/commands/init.ts` (the `generateAmendClaudeMd` function — currently around lines 187–288)

- [ ] **Step 1: Update the amend checklist (around lines 227–233)**

Replace:
```
1. Read requirements.md and tasks.md to review current state
2. Discuss amendments with user
3. Update requirements.md
4. Update pending tasks in tasks.md
5. Tell user to exit session
```

With:
```
1. Read requirements.md and tasks.md to review current state
2. Discuss amendments with user
3. Update requirements.md
4. Update pending tasks in tasks.md
5. Self-review the changes and resolve any major issues
6. Tell user to exit session
```

- [ ] **Step 2: Update the amend Task Format example (around lines 270–280)**

Replace:
```markdown
\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.
- **Verification**: A specific, testable check to confirm the task is complete.
\`\`\`

Task IDs support letter suffixes for subtasks (e.g., TASK-001a, TASK-001b).
```

With:
```markdown
\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.
- **Verification**: A specific, testable check to confirm the task is complete.
- **Breaking**: (optional) Description of any backwards-incompatible change introduced.
\`\`\`

Task IDs support letter suffixes for subtasks (e.g., TASK-001a, TASK-001b).

- **Type**: one of \`feat\`, \`fix\`, \`docs\`, \`style\`, \`refactor\`, \`perf\`, \`test\`, \`build\`, \`ci\`, \`chore\`, \`revert\`. Pick the type that best describes what the task does. Drives the Conventional Commits prefix on the auto-generated git commit. If unsure, use \`chore\`.
- **Breaking** (optional): include only when the task introduces a backwards-incompatible change. The text becomes the body of a \`BREAKING CHANGE:\` footer.
- **Prefer logical decomposition over bundling.** Long-running DevLoop sessions are normal and expected — task count is not a thing to minimize. When adding new tasks, split distinct concerns (schema + parser + tests + docs) into separate tasks tied by dependencies rather than packing them together.
```

- [ ] **Step 3: Add a self-review section before "When Done" (around line 282)**

Insert this new section between the existing `---` separator and the `## When Done` heading (i.e., after line 282 / before line 284):

```markdown
---

## Self-review

Before telling the user to exit, review your changes. Run up to 3 review passes over the requirements diff and **pending tasks only**. Locked (done / in-progress) tasks are out of scope — do not review them and do not flag issues that could only be resolved by changing them.

In each pass, look for:

**Major issues** — fix them by editing the documents, then re-run the review:
- Inconsistencies between requirements.md and tasks.md
- Internal contradictions
- Missing or broken dependencies (a task depends on an ID that doesn't exist)
- Circular dependencies in the task graph among pending tasks
- Non-sequential or duplicate task IDs
- New tasks missing required fields (\`Type\`, \`Description\`, \`Verification\`)
- Scope drift

**Minor issues** — collect them for the user, do NOT auto-fix:
- Ambiguous or under-specified wording
- Tasks that could be decomposed further
- Ordering choices that could go either way
- Optional features that may be over-scoped

If after pass 3 there are still major issues you cannot resolve, demote them to a "couldn't auto-resolve" list shown alongside minor issues — do not loop further.

When the loop ends, print the minor issues for the user in this format:

\`\`\`
Self-review complete after N pass(es).

Minor issues for your review:
1. ...
2. ...

You can ask me to address any of these, or exit (Ctrl+C) to accept as-is.
\`\`\`

Then wait for the user's decision. If they ask for changes, address them. If they exit, DevLoop commits.

---
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts
git commit -m "feat: apply Type/Breaking, granularity, and self-review to amend prompt"
```

---

### Task 19: Apply the same updates to `generateContinueClaudeMd`

**Files:**
- Modify: `src/commands/init.ts` (the `generateContinueClaudeMd` function — currently around lines 290–364)

- [ ] **Step 1: Update the continue-requirements checklist (around lines 329–335)**

Replace:
```
1. Read requirements.md and tasks.md to review current state
2. Discuss changes with user
3. Update requirements.md
4. Update tasks.md
5. Tell user to exit session
```

With:
```
1. Read requirements.md and tasks.md to review current state
2. Discuss changes with user
3. Update requirements.md
4. Update tasks.md
5. Self-review the changes and resolve any major issues
6. Tell user to exit session
```

- [ ] **Step 2: Update the Task Format example (around lines 346–356)**

Replace:
```markdown
\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.
- **Verification**: A specific, testable check to confirm the task is complete.
\`\`\`

Task IDs support letter suffixes for subtasks (e.g., TASK-001a, TASK-001b).
```

With:
```markdown
\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.
- **Verification**: A specific, testable check to confirm the task is complete.
- **Breaking**: (optional) Description of any backwards-incompatible change introduced.
\`\`\`

Task IDs support letter suffixes for subtasks (e.g., TASK-001a, TASK-001b).

- **Type**: one of \`feat\`, \`fix\`, \`docs\`, \`style\`, \`refactor\`, \`perf\`, \`test\`, \`build\`, \`ci\`, \`chore\`, \`revert\`. Pick the type that best describes what the task does. Drives the Conventional Commits prefix on the auto-generated git commit. If unsure, use \`chore\`.
- **Breaking** (optional): include only when the task introduces a backwards-incompatible change. The text becomes the body of a \`BREAKING CHANGE:\` footer.
- **Prefer logical decomposition over bundling.** Long-running DevLoop sessions are normal and expected — task count is not a thing to minimize. Split distinct concerns (schema + parser + tests + docs) into separate tasks tied by dependencies rather than packing them together.
```

- [ ] **Step 3: Add a self-review section before "When Done" (around line 358)**

Insert this new section between the existing `---` separator and the `## When Done` heading:

```markdown
---

## Self-review

Before telling the user to exit, review your changes. Run up to 3 review passes.

In each pass, look for:

**Major issues** — fix them by editing the documents, then re-run the review:
- Inconsistencies between requirements.md and tasks.md
- Internal contradictions
- Missing or broken dependencies
- Circular dependencies in the task graph
- Non-sequential or duplicate task IDs
- Tasks missing required fields (\`Type\`, \`Description\`, \`Verification\`)
- Scope drift

**Minor issues** — collect them for the user, do NOT auto-fix:
- Ambiguous or under-specified wording
- Tasks that could be decomposed further
- Ordering choices that could go either way
- Optional features that may be over-scoped

If after pass 3 there are still major issues you cannot resolve, demote them to a "couldn't auto-resolve" list shown alongside minor issues — do not loop further.

When the loop ends, print the minor issues for the user in this format:

\`\`\`
Self-review complete after N pass(es).

Minor issues for your review:
1. ...
2. ...

You can ask me to address any of these, or exit (Ctrl+C) to accept as-is.
\`\`\`

Then wait for the user's decision. If they ask for changes, address them. If they exit, DevLoop commits.

---
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts
git commit -m "feat: apply Type/Breaking, granularity, and self-review to continue-requirements prompt"
```

---

## Stage 6: Help text and docs

### Task 20: Update `devloop config` help text

**Files:**
- Modify: `src/commands/config.ts:89-101`

- [ ] **Step 1: Update the help text block**

Find the lines (around 89–101) that print:
```
Variables for devloopCommitFormat:
  {action} - What DevLoop is doing, e.g.:
             "Initialize workspace"
             "Complete TASK-001 - Fix the bug"
             "Attempted TASK-002 - Add feature"
...
  devloop config set devloopCommitFormat "chore(devloop): {action}"
```

Replace with text explaining the new behavior:

```
console.log(chalk.white('devloopCommitFormat:'));
console.log(chalk.gray('  Optional. If unset, DevLoop generates Conventional Commits messages'));
console.log(chalk.gray('  itself (feat:, fix:, chore:, etc.) using each task\\'s Type field.'));
console.log(chalk.gray('  Set this only when your repo\\'s commit hooks require a different format.'));
console.log(chalk.gray('  Use {action} as a placeholder for the action description.'));
console.log(chalk.gray(''));
console.log(chalk.gray('  {action} examples:'));
console.log(chalk.gray('    "Initialize workspace"'));
console.log(chalk.gray('    "Complete TASK-001 - Fix the bug"'));
console.log(chalk.gray('    "Attempted TASK-002 - Add feature"'));
console.log(chalk.gray(''));
console.log(chalk.gray('  Example: devloop config set devloopCommitFormat "chore(devloop): {action}"'));
```

(Match the exact existing call style — `console.log(chalk.white(...))` / `console.log(chalk.gray(...))` — adjust to whatever the surrounding code uses.)

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add src/commands/config.ts
git commit -m "docs: update devloopCommitFormat help text for new default"
```

---

### Task 21: Update CLAUDE.md (project root) sections

**Files:**
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Update "Document Formats" section**

Find the section that documents the task format (currently around the line containing "Tasks in `.devloop/tasks.md` follow this structure"). Update the example block to include `Type` and `Breaking`:

```markdown
\`\`\`markdown
### TASK-001: Title
- **Status**: pending|in-progress|done
- **Type**: feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
- **Dependencies**: none|TASK-XXX, TASK-YYY
- **Description**: What to do
- **Verification**: How to confirm it's done
- **Breaking**: (optional) Description of any backwards-incompatible change introduced
\`\`\`

The \`Type\` field drives the Conventional Commits prefix on the auto-generated git commit. Missing or unknown values default to \`chore\`. The \`Breaking\` field is optional; when present, its text becomes the body of a \`BREAKING CHANGE:\` footer in the commit, signalling a major version bump to semver tooling.
```

- [ ] **Step 2: Update "Commit Message Format" section**

Find the "### Commit Message Format" section. Replace the existing text with:

```markdown
### Commit Message Format

DevLoop's auto-generated commits use one of two formats:

**Default (no `devloopCommitFormat` set): Conventional Commits.**
DevLoop builds messages itself in the form `{type}: {description}`. The type comes from each task's `Type` field; non-task commits (init, amend, review, verification, .gitignore) use `chore`. Failed/attempted/interrupted task commits also use `chore` (failed work shouldn't bump the version). Batch commits promote the highest-priority type from the succeeded tasks (priority order: feat > fix > perf > refactor > revert > build > ci > test > docs > style > chore) and list each task's individual type in the body. Tasks with a `Breaking` field add a `BREAKING CHANGE:` footer.

Example single-task commit:
\`\`\`
feat: T14 - Add token tracking
\`\`\`

Example batch commit:
\`\`\`
feat: T1, T2, T3

- feat: T1 - Add token tracking
- fix: T2 - Handle CRLF in tasks.md
- chore: T3 - Update CLAUDE.md docs

BREAKING CHANGE: T1 changes the /v2 auth header
\`\`\`

**Override (`devloopCommitFormat` is set): template substitution.**
The configured template is used verbatim with `{action}` replaced by a legacy action string ("Complete TASK-001 - Title", "Initialize workspace", etc.). Use this when your repo's commit hooks require a non-Conventional format.

\`\`\`bash
devloop config set devloopCommitFormat "chore(devloop): {action}"
devloop config list  # Show current config
\`\`\`

**Auto-detection**: During `devloop init`, commit hooks are auto-detected from commitlint, git hooks, and husky. When commitlint is detected, the user is informed that the new Conventional Commits default works out of the box; the user can still supply a custom format if needed.

**Hook failure handling**: If a commit fails due to a hook, DevLoop:
1. Displays the hook error and attempted message
2. Prompts for a valid commit message (with `{action}` placeholder hint)
3. Retries until successful or user skips
4. Saves the format for future commits
```

- [ ] **Step 3: Update "Init Behavior" section**

Find the "### Init Behavior" section. Add a 4th phase to the workflow list:

```markdown
4. **Self-review**: Claude reviews `requirements.md` and `tasks.md` for inconsistencies, missing dependencies, broken/circular deps, missing required fields, and scope drift. Auto-fixes major issues and re-reviews up to 3 times. Surfaces minor issues (ambiguity, granularity opinions) for the user to decide on.
```

- [ ] **Step 4: Update "Iterative Requirements" section**

In the "### Iterative Requirements" section, add a sentence at the end of the amend description: "After amendments, the same Phase 4 self-review runs over the requirements diff and pending tasks; locked tasks are out of scope."

- [ ] **Step 5: Update "Interactive Session Progress" section**

Find the "### Interactive Session Progress" section. Update its description to mention the self-review item:

Replace the existing description with:
```markdown
All interactive Claude sessions (init, continue-requirements, amend-requirements) instruct Claude to use the `TodoWrite` tool at the start of the session to create a visible progress roadmap. Each session type has its own step list matching its workflow, including a self-review step before the final "exit session" item. Claude checks items off as it completes each phase, giving the user a clear sense of where the session is in the process.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for conventional commits and self-review"
```

---

### Task 22: Update README.md with brief note

**Files:**
- Modify: `README.md` (look for the section that mentions `devloopCommitFormat` — currently around line 91–104 based on earlier search results)

- [ ] **Step 1: Update the commit format mention**

Find the existing line that mentions commit format (around line 91 — search for `devloopCommitFormat` or "Git integration"). Add a sentence describing the new default. Example replacement for the relevant paragraph:

```markdown
**Git integration** — Every task completion is committed. Auto-generated commits use [Conventional Commits](https://www.conventionalcommits.org/) by default (e.g., `feat: T14 - Add token tracking`), driven by each task's `Type` field. Tasks with a `Breaking` field add a `BREAKING CHANGE:` footer. Set `devloopCommitFormat` to override with a custom template if your repo requires a different format. Batch commits include a body listing each task's status and title. Interrupted work is preserved.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: note conventional commits default in README"
```

---

## Stage 7: Final verification

### Task 23: Bump version and run full verification

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump version**

In `package.json`, change:
```json
"version": "4.1.0",
```
to:
```json
"version": "4.2.0",
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass — parser tests for Type/Breaking, conventional-commits unit tests, git.ts tests including the new routing helper, all existing integration tests.

- [ ] **Step 4: Run coverage check**

Run: `npm run test:coverage`
Expected: Coverage thresholds (75% lines, 75% functions, 70% branches) met. The new `conventional-commits.ts` module is heavily tested so this should improve coverage rather than threaten it.

- [ ] **Step 5: Run a build to confirm dist/ updates cleanly**

Run: `npm run build`
Expected: No errors; `dist/` is rebuilt.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 4.2.0"
```

---

## Self-Review Notes

Run the following manual sanity checks before declaring done:

1. **Spec coverage:**
   - Conventional Commits as default → Tasks 8, 9, 10, 11, 12, 13, 14
   - Task schema (Type, Breaking) → Tasks 1, 2, 3
   - Subject formatting (T1 ID, markers) → Tasks 4, 6
   - Per-action type rules → Tasks 6, 7, 8 (and call sites in Tasks 11–14)
   - Body and footer formatting → Tasks 6, 7
   - Batch commit handling → Tasks 4, 7, 12
   - Task decomposition guidance → Tasks 16, 18, 19
   - Self-review loop → Tasks 17, 18, 19
   - Backward compat → preserved by `devloopCommitFormat` override branch in Task 8 and the optional Type/Breaking fields in Task 1
   - Tests → Tasks 2, 3, 4, 5, 6, 7, 8
   - Docs → Tasks 21, 22; help text in Task 20
   - Version bump → Task 23

2. **Type consistency:** All builders return `ConventionalMessage` (`{ subject, body? }`). All call sites in Tasks 11–14 destructure subject/body and pass them to `gitCommit(workspace, subject, verbose, body)`.

3. **No placeholders:** Every step shows the actual code or markdown to paste. No "TBD" or "implement appropriate handling".

4. **DevloopCommitContext shape** is consistent everywhere it's used: `kind: 'plain' | 'single-task' | 'batch'` with the discriminated fields.

5. **The legacy template path** (when `devloopCommitFormat` is set) preserves the exact existing action strings ("Complete TASK-001 - …", "Attempted TASK-002 - …", "Interrupted work on TASK-XXX - …", "Initialize workspace", etc.) — verified by Task 8 step 1 tests.
