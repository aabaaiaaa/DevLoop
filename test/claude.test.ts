import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../src/core/claude.js';
import { Task } from '../src/types/index.js';

describe('buildTaskPrompt', () => {
  const task: Task = {
    id: 'TASK-001',
    title: 'Fix login bug',
    status: 'pending',
    dependencies: [],
    description: 'Fix the login flow timeout issue',
    verification: 'Run npm test and all auth tests pass'
  };

  const reqPath = '/workspace/.devloop/requirements.md';
  const tasksPath = '/workspace/.devloop/tasks.md';
  const progPath = '/workspace/.devloop/progress.md';
  const wsPath = '/workspace';

  it('includes task details in prompt', () => {
    const prompt = buildTaskPrompt(task, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes('TASK-001'));
    assert.ok(prompt.includes('Fix login bug'));
    assert.ok(prompt.includes('Fix the login flow timeout issue'));
  });

  it('includes workspace restriction', () => {
    const prompt = buildTaskPrompt(task, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes(wsPath));
    assert.ok(prompt.includes('WORKSPACE RESTRICTION'));
    assert.ok(prompt.includes('ONLY allowed to work within'));
  });

  it('includes file paths', () => {
    const prompt = buildTaskPrompt(task, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes(reqPath));
    assert.ok(prompt.includes(tasksPath));
    assert.ok(prompt.includes(progPath));
  });

  it('includes verification requirement', () => {
    const prompt = buildTaskPrompt(task, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes('Run npm test and all auth tests pass'));
    assert.ok(prompt.includes('VERIFICATION REQUIREMENT'));
  });

  it('tells Claude NOT to modify .devloop or .claude files', () => {
    const prompt = buildTaskPrompt(task, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes('.devloop'));
    assert.ok(prompt.includes('.claude'));
    assert.ok(prompt.includes('Do NOT modify any files in'));
  });
});
