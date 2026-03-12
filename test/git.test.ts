import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDevloopCommit } from '../src/core/git.js';

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
