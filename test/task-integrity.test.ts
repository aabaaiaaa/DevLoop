import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../src/core/claude.js';

describe('buildTaskPrompt', () => {
  it('includes verification requirement in prompt', () => {
    const task = {
      id: 'TASK-001', title: 'Test task', status: 'pending' as const,
      dependencies: [], description: 'Do something',
      verification: 'Run npm test and all tests pass'
    };
    const prompt = buildTaskPrompt(task, '/req.md', '/tasks.md', '/progress.md', '/workspace', false);
    assert.ok(prompt.includes('Run npm test and all tests pass'));
    assert.ok(prompt.includes('VERIFICATION REQUIREMENT'));
  });

  it('includes retry context when task is in-progress', () => {
    const task = {
      id: 'TASK-001', title: 'Test task', status: 'in-progress' as const,
      dependencies: [], description: 'Do something',
      verification: 'Check it works'
    };
    const prompt = buildTaskPrompt(task, '/req.md', '/tasks.md', '/progress.md', '/workspace', true);
    assert.ok(prompt.includes('RETRY CONTEXT'));
    assert.ok(prompt.includes('previously attempted'));
  });

  it('does not include retry context for fresh tasks', () => {
    const task = {
      id: 'TASK-001', title: 'Test task', status: 'pending' as const,
      dependencies: [], description: 'Do something',
      verification: 'Check it works'
    };
    const prompt = buildTaskPrompt(task, '/req.md', '/tasks.md', '/progress.md', '/workspace', false);
    assert.ok(!prompt.includes('RETRY CONTEXT'));
  });

  it('references both requirements.md and tasks.md', () => {
    const task = {
      id: 'TASK-001', title: 'Test task', status: 'pending' as const,
      dependencies: [], description: 'Do something',
      verification: 'Check it works'
    };
    const prompt = buildTaskPrompt(task, '/path/requirements.md', '/path/tasks.md', '/progress.md', '/workspace', false);
    assert.ok(prompt.includes('/path/requirements.md'));
    assert.ok(prompt.includes('/path/tasks.md'));
  });

  it('includes .devloop and .claude directory restriction', () => {
    const task = {
      id: 'TASK-001', title: 'Test task', status: 'pending' as const,
      dependencies: [], description: 'Do something',
      verification: 'Check it works'
    };
    const prompt = buildTaskPrompt(task, '/req.md', '/tasks.md', '/progress.md', '/workspace', false);
    assert.ok(prompt.includes('.devloop'));
    assert.ok(prompt.includes('.claude'));
  });
});
