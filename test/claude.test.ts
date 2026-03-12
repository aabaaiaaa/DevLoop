import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../src/core/claude.js';
import { Task } from '../src/types/index.js';

describe('buildTaskPrompt', () => {
  const task: Task = {
    id: 'TASK-001',
    title: 'Fix login bug',
    status: 'pending',
    priority: 'high',
    dependencies: [],
    description: 'Fix the login flow timeout issue'
  };

  const reqPath = '/workspace/requirements.md';
  const progPath = '/workspace/progress.md';
  const wsPath = '/workspace';

  it('includes task details in prompt', () => {
    const prompt = buildTaskPrompt(task, reqPath, progPath, wsPath);
    assert.ok(prompt.includes('TASK-001'));
    assert.ok(prompt.includes('Fix login bug'));
    assert.ok(prompt.includes('Fix the login flow timeout issue'));
    assert.ok(prompt.includes('high'));
  });

  it('includes workspace restriction', () => {
    const prompt = buildTaskPrompt(task, reqPath, progPath, wsPath);
    assert.ok(prompt.includes(wsPath));
    assert.ok(prompt.includes('WORKSPACE RESTRICTION'));
    assert.ok(prompt.includes('ONLY allowed to work within'));
  });

  it('includes file paths', () => {
    const prompt = buildTaskPrompt(task, reqPath, progPath, wsPath);
    assert.ok(prompt.includes(reqPath));
    assert.ok(prompt.includes(progPath));
  });

  it('does NOT tell Claude to mark tasks as done', () => {
    const prompt = buildTaskPrompt(task, reqPath, progPath, wsPath);
    // The old prompt had these phrases - ensure they're gone
    assert.ok(!prompt.includes('mark task'));
    assert.ok(!prompt.includes('Update the task status to "done"'));
    assert.ok(!prompt.includes('changing its Status line from'));
  });

  it('tells Claude NOT to modify task statuses', () => {
    const prompt = buildTaskPrompt(task, reqPath, progPath, wsPath);
    assert.ok(prompt.includes('Do NOT modify task statuses'));
    assert.ok(prompt.includes('Do NOT change any Status lines'));
  });
});
