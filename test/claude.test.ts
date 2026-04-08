import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt, buildBatchPrompt, parseBatchResults } from '../src/core/claude.js';
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

  it('consolidated mode (default) tells Claude to skip test suites', () => {
    const prompt = buildTaskPrompt(task, reqPath, tasksPath, progPath, wsPath, false, false);
    assert.ok(prompt.includes('Do NOT run test suites'));
    assert.ok(prompt.includes('skip test suites'));
    assert.ok(prompt.includes('VERIFICATION REQUIREMENT'));
    assert.ok(prompt.includes(task.verification));
  });

  it('per-task mode includes full verification and E2E guidance', () => {
    const prompt = buildTaskPrompt(task, reqPath, tasksPath, progPath, wsPath, false, true);
    assert.ok(prompt.includes('you MUST verify your work'));
    assert.ok(prompt.includes('E2E'));
    assert.ok(prompt.includes('Run the verification check before finishing'));
    assert.ok(!prompt.includes('Do NOT run test suites'));
  });
});

describe('buildBatchPrompt', () => {
  const tasks: Task[] = [
    { id: 'TASK-001', title: 'Add auth', status: 'pending', dependencies: [], description: 'Add auth middleware', verification: '`npm test -- --grep auth`' },
    { id: 'TASK-002', title: 'Add logging', status: 'pending', dependencies: [], description: 'Add structured logging', verification: '`npm test -- --grep logging`' },
    { id: 'TASK-003', title: 'Add config', status: 'pending', dependencies: [], description: 'Add config validator', verification: '`npm test -- --grep config`' },
  ];
  const reqPath = '/ws/.devloop/requirements.md';
  const tasksPath = '/ws/.devloop/tasks.md';
  const progPath = '/ws/.devloop/progress.md';
  const wsPath = '/ws';

  it('includes all task details', () => {
    const prompt = buildBatchPrompt(tasks, reqPath, tasksPath, progPath, wsPath);
    for (const t of tasks) {
      assert.ok(prompt.includes(t.id));
      assert.ok(prompt.includes(t.title));
      assert.ok(prompt.includes(t.description));
      assert.ok(prompt.includes(t.verification));
    }
  });

  it('includes Agent tool instructions', () => {
    const prompt = buildBatchPrompt(tasks, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes('Agent tool'));
    assert.ok(prompt.includes('parallel'));
  });

  it('includes TASK_RESULT format instructions', () => {
    const prompt = buildBatchPrompt(tasks, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes('TASK_RESULT'));
    assert.ok(prompt.includes('SUCCESS'));
    assert.ok(prompt.includes('FAILED'));
  });

  it('includes workspace restriction', () => {
    const prompt = buildBatchPrompt(tasks, reqPath, tasksPath, progPath, wsPath);
    assert.ok(prompt.includes('WORKSPACE RESTRICTION'));
    assert.ok(prompt.includes(wsPath));
  });
});

describe('parseBatchResults', () => {
  it('parses SUCCESS and FAILED results', () => {
    const output = `Some preamble text
TASK_RESULT: TASK-001: SUCCESS
TASK_RESULT: TASK-002: FAILED: Tests did not pass
TASK_RESULT: TASK-003: SUCCESS`;

    const results = parseBatchResults(output, ['TASK-001', 'TASK-002', 'TASK-003']);
    assert.equal(results.get('TASK-001')!.success, true);
    assert.equal(results.get('TASK-002')!.success, false);
    assert.equal(results.get('TASK-002')!.error, 'Tests did not pass');
    assert.equal(results.get('TASK-003')!.success, true);
  });

  it('treats missing tasks as failed', () => {
    const output = 'TASK_RESULT: TASK-001: SUCCESS';
    const results = parseBatchResults(output, ['TASK-001', 'TASK-002']);
    assert.equal(results.get('TASK-001')!.success, true);
    assert.equal(results.get('TASK-002')!.success, false);
    assert.ok(results.get('TASK-002')!.error?.includes('No result'));
  });

  it('handles empty output', () => {
    const results = parseBatchResults('', ['TASK-001', 'TASK-002']);
    assert.equal(results.get('TASK-001')!.success, false);
    assert.equal(results.get('TASK-002')!.success, false);
  });

  it('handles task IDs with letter suffixes', () => {
    const output = 'TASK_RESULT: TASK-001a: SUCCESS\nTASK_RESULT: TASK-001b: FAILED: compile error';
    const results = parseBatchResults(output, ['TASK-001a', 'TASK-001b']);
    assert.equal(results.get('TASK-001a')!.success, true);
    assert.equal(results.get('TASK-001b')!.success, false);
  });
});
