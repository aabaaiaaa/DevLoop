import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCommitMessage, CommitVariables } from '../src/core/commit-format.js';

describe('formatCommitMessage', () => {
  const baseVars: CommitVariables = {
    feature: 'auth',
    iteration: 3,
    status: 'Complete',
    taskId: 'TASK-001',
    title: 'Fix login bug'
  };

  it('replaces all placeholders', () => {
    const template = '{feature} iter {iteration}: {status} {taskId} - {title}';
    const result = formatCommitMessage(template, baseVars);
    assert.equal(result, 'auth iter 3: Complete TASK-001 - Fix login bug');
  });

  it('replaces multiple occurrences of the same placeholder', () => {
    const template = '{taskId} - {taskId}';
    const result = formatCommitMessage(template, baseVars);
    assert.equal(result, 'TASK-001 - TASK-001');
  });

  it('handles conventional commit format', () => {
    const template = 'feat({feature}): {title}';
    const result = formatCommitMessage(template, baseVars);
    assert.equal(result, 'feat(auth): Fix login bug');
  });

  it('handles missing feature (undefined)', () => {
    const vars: CommitVariables = { ...baseVars, feature: undefined };
    const template = 'feat({feature}): {title}';
    const result = formatCommitMessage(template, vars);
    assert.equal(result, 'feat(): Fix login bug');
  });

  it('trims whitespace from result', () => {
    const template = '  {taskId} - {title}  ';
    const result = formatCommitMessage(template, baseVars);
    assert.equal(result, 'TASK-001 - Fix login bug');
  });

  it('handles template with no placeholders', () => {
    const result = formatCommitMessage('static message', baseVars);
    assert.equal(result, 'static message');
  });

  it('handles Attempted status', () => {
    const vars: CommitVariables = { ...baseVars, status: 'Attempted' };
    const template = '{status} {taskId}';
    const result = formatCommitMessage(template, vars);
    assert.equal(result, 'Attempted TASK-001');
  });

  it('converts iteration number to string', () => {
    const template = 'Iteration {iteration}';
    const result = formatCommitMessage(template, baseVars);
    assert.equal(result, 'Iteration 3');
  });
});
