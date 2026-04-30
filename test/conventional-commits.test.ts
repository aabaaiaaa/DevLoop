import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTaskIdShort,
  normalizeType,
  priorityType,
  buildPlainMessage
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

  it('returns chore for undefined or null', () => {
    assert.equal(normalizeType(undefined), 'chore');
    assert.equal(normalizeType(null), 'chore');
  });

  it('returns chore for unknown values', () => {
    // 'wip' triggers a warning we expect; suppress for cleanliness.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(normalizeType('wip'), 'chore');
      assert.equal(normalizeType(''), 'chore');
    } finally {
      console.warn = originalWarn;
    }
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
