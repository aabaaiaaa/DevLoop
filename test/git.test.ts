import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDevloopCommit, isHookError, parseGitStatusOutput, buildDevloopCommitMessageFromContext } from '../src/core/git.js';
import type { Task } from '../src/types/index.js';

describe('formatDevloopCommit', () => {
  it('uses custom format with {action} placeholder', () => {
    const result = formatDevloopCommit('chore(devloop): {action}', 'Complete TASK-001');
    assert.equal(result, 'chore(devloop): Complete TASK-001');
  });

  it('replaces multiple {action} occurrences', () => {
    const result = formatDevloopCommit('{action} - {action}', 'Fix bug');
    assert.equal(result, 'Fix bug - Fix bug');
  });

  it('trims result', () => {
    const result = formatDevloopCommit('  {action}  ', 'Do thing');
    assert.equal(result, 'Do thing');
  });

  it('returns default format when format is undefined', () => {
    const result = formatDevloopCommit(undefined, 'Initialize workspace');
    assert.equal(result, 'DevLoop: Initialize workspace');
  });

  it('returns default format when format is empty string', () => {
    // Empty string is falsy, so falls through to default
    const result = formatDevloopCommit('', 'Initialize workspace');
    assert.equal(result, 'DevLoop: Initialize workspace');
  });

  it('handles format without {action} placeholder', () => {
    const result = formatDevloopCommit('static commit message', 'anything');
    assert.equal(result, 'static commit message');
  });

  it('handles complex conventional commit format', () => {
    const result = formatDevloopCommit('feat(devloop): {action} [skip ci]', 'Add new feature');
    assert.equal(result, 'feat(devloop): Add new feature [skip ci]');
  });
});

describe('isHookError', () => {
  it('detects pre-commit hook errors', () => {
    assert.equal(isHookError('pre-commit hook failed'), true);
  });

  it('detects commit-msg hook errors', () => {
    assert.equal(isHookError('commit-msg hook rejected'), true);
  });

  it('detects husky errors', () => {
    assert.equal(isHookError('husky - commit-msg script failed'), true);
  });

  it('detects commitlint errors', () => {
    assert.equal(isHookError('commitlint: subject may not be empty'), true);
  });

  it('detects conventional commit errors', () => {
    assert.equal(isHookError('conventional commit format required'), true);
  });

  it('detects "does not match" errors', () => {
    assert.equal(isHookError('commit message does not match pattern'), true);
  });

  it('is case insensitive', () => {
    assert.equal(isHookError('PRE-COMMIT HOOK FAILED'), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(isHookError('fatal: not a git repository'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isHookError(''), false);
  });
});

describe('parseGitStatusOutput', () => {
  it('parses basic porcelain output', () => {
    const output = ' M src/index.ts\n M src/app.ts\n';
    const files = parseGitStatusOutput(output);
    assert.deepEqual(files, ['src/index.ts', 'src/app.ts']);
  });

  it('handles new files', () => {
    const output = '?? newfile.ts\n';
    const files = parseGitStatusOutput(output);
    assert.deepEqual(files, ['newfile.ts']);
  });

  it('handles renamed files (uses new name)', () => {
    const output = 'R  old.ts -> new.ts\n';
    const files = parseGitStatusOutput(output);
    assert.deepEqual(files, ['new.ts']);
  });

  it('strips quotes from filenames', () => {
    const output = ' M "path with spaces/file.ts"\n';
    const files = parseGitStatusOutput(output);
    assert.deepEqual(files, ['path with spaces/file.ts']);
  });

  it('filters out ignored paths', () => {
    const output = ' M src/index.ts\n M .devloop/session.json\n M .claude/settings.json\n';
    const files = parseGitStatusOutput(output, ['.devloop/', '.claude/']);
    assert.deepEqual(files, ['src/index.ts']);
  });

  it('filters paths with or without leading dot', () => {
    const output = ' M devloop/tasks.md\n M src/app.ts\n';
    const files = parseGitStatusOutput(output, ['.devloop/']);
    assert.deepEqual(files, ['src/app.ts']);
  });

  it('handles empty output', () => {
    const files = parseGitStatusOutput('');
    assert.deepEqual(files, []);
  });

  it('handles backslash paths on Windows', () => {
    const output = ' M src\\core\\git.ts\n M .devloop\\session.json\n';
    const files = parseGitStatusOutput(output, ['.devloop/']);
    assert.deepEqual(files, ['src\\core\\git.ts']);
  });
});

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

  it('template path with interrupted task uses "Interrupted work on" prefix', () => {
    const t = task({ id: 'TASK-014', title: 'Add tracking', type: 'feat' });
    const msg = buildDevloopCommitMessageFromContext('chore(devloop): {action}', {
      kind: 'single-task', task: t, outcome: 'interrupted',
    });
    assert.equal(msg.subject, 'chore(devloop): Interrupted work on TASK-014 - Add tracking');
  });
});
