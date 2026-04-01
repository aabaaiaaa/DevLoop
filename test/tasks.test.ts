import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseTasksContent,
  parseTasks,
  getNextTask,
  updateTaskStatus
} from '../src/parser/tasks.js';

// --- parseTasksContent ---

describe('parseTasksContent', () => {
  it('parses a single task with all fields', () => {
    const content = `# Task List

## Metadata
- **Project**: TestProject
- **Created**: 2025-01-01
- **Author**: Dev

## Tasks

### TASK-001: Fix the bug
- **Status**: pending
- **Dependencies**: none
- **Description**: Fix the login bug
- **Verification**: Run npm test
`;
    const result = parseTasksContent(content);
    assert.equal(result.projectName, 'TestProject');
    assert.equal(result.created, '2025-01-01');
    assert.equal(result.author, 'Dev');
    assert.equal(result.tasks.length, 1);

    const task = result.tasks[0];
    assert.equal(task.id, 'TASK-001');
    assert.equal(task.title, 'Fix the bug');
    assert.equal(task.status, 'pending');
    assert.deepEqual(task.dependencies, []);
    assert.equal(task.description, 'Fix the login bug');
    assert.equal(task.verification, 'Run npm test');
  });

  it('parses multiple tasks', () => {
    const content = `# Proj

### TASK-001: First
- **Status**: done
- **Dependencies**: none
- **Description**: First task
- **Verification**: Manual check

### TASK-002: Second
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Second task
- **Verification**: Run npm test

### TASK-003: Third
- **Status**: in-progress
- **Dependencies**: TASK-001, TASK-002
- **Description**: Third task
- **Verification**: Run integration tests
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks.length, 3);

    assert.equal(result.tasks[0].status, 'done');
    assert.equal(result.tasks[1].status, 'pending');
    assert.deepEqual(result.tasks[1].dependencies, ['TASK-001']);
    assert.equal(result.tasks[2].status, 'in-progress');
    assert.deepEqual(result.tasks[2].dependencies, ['TASK-001', 'TASK-002']);
  });

  it('defaults missing fields', () => {
    const content = `### TASK-001: Minimal task
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].status, 'pending');
    assert.deepEqual(result.tasks[0].dependencies, []);
    assert.equal(result.tasks[0].description, '');
    assert.equal(result.tasks[0].verification, '');
  });

  it('extracts project name from markdown title when no metadata', () => {
    const content = `# My Cool Project

### TASK-001: Do something
- **Status**: pending
- **Dependencies**: none
- **Description**: Do it
- **Verification**: Verify it works
`;
    const result = parseTasksContent(content);
    assert.equal(result.projectName, 'My Cool Project');
  });

  it('returns "Unknown Project" when no project info', () => {
    const content = `### TASK-001: A task
- **Status**: pending
`;
    const result = parseTasksContent(content);
    assert.equal(result.projectName, 'Unknown Project');
  });

  it('handles empty content with no tasks', () => {
    const result = parseTasksContent('');
    assert.equal(result.tasks.length, 0);
  });

  it('is case-insensitive for status values', () => {
    const content = `### TASK-001: Task
- **Status**: Done
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].status, 'done');
  });

  it('parses verification field correctly', () => {
    const content = `### TASK-001: Task with verification
- **Status**: pending
- **Dependencies**: none
- **Description**: A task
- **Verification**: Run "npm test" and all tests pass
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].verification, 'Run "npm test" and all tests pass');
  });

  it('defaults verification to empty string when missing', () => {
    const content = `### TASK-001: Task without verification
- **Status**: pending
- **Dependencies**: none
- **Description**: A task
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].verification, '');
  });
});

// --- getNextTask ---

describe('getNextTask', () => {
  it('returns first pending task by ID order', () => {
    const taskList = parseTasksContent(`
### TASK-003: Third
- **Status**: pending
- **Dependencies**: none
- **Description**: Third
- **Verification**: Check it

### TASK-001: First
- **Status**: pending
- **Dependencies**: none
- **Description**: First
- **Verification**: Check it
`);
    const next = getNextTask(taskList);
    assert.equal(next?.id, 'TASK-001');
  });

  it('skips done tasks', () => {
    const taskList = parseTasksContent(`
### TASK-001: Done task
- **Status**: done
- **Dependencies**: none
- **Description**: Done
- **Verification**: Check it

### TASK-002: Pending task
- **Status**: pending
- **Dependencies**: none
- **Description**: Pending
- **Verification**: Check it
`);
    const next = getNextTask(taskList);
    assert.equal(next?.id, 'TASK-002');
  });

  it('respects dependencies', () => {
    const taskList = parseTasksContent(`
### TASK-001: First
- **Status**: pending
- **Dependencies**: none
- **Description**: First
- **Verification**: Check it

### TASK-002: Second (blocked)
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Blocked by TASK-001
- **Verification**: Check it
`);
    const next = getNextTask(taskList);
    assert.equal(next?.id, 'TASK-001');
  });

  it('unblocks task when dependency is done', () => {
    const taskList = parseTasksContent(`
### TASK-001: First
- **Status**: done
- **Dependencies**: none
- **Description**: First
- **Verification**: Check it

### TASK-002: Second
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Depends on TASK-001
- **Verification**: Check it
`);
    const next = getNextTask(taskList);
    assert.equal(next?.id, 'TASK-002');
  });

  it('returns null when all tasks are done', () => {
    const taskList = parseTasksContent(`
### TASK-001: Only task
- **Status**: done
- **Dependencies**: none
- **Description**: Done
- **Verification**: Check it
`);
    assert.equal(getNextTask(taskList), null);
  });

  it('returns null when all pending tasks are blocked', () => {
    const taskList = parseTasksContent(`
### TASK-001: Blocked
- **Status**: pending
- **Dependencies**: TASK-002
- **Description**: Blocked
- **Verification**: Check it

### TASK-002: Also blocked
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Circular
- **Verification**: Check it
`);
    assert.equal(getNextTask(taskList), null);
  });

  it('prioritizes in-progress tasks over pending', () => {
    const taskList = parseTasksContent(`
### TASK-001: Pending task
- **Status**: pending
- **Dependencies**: none
- **Description**: A pending task
- **Verification**: Check it

### TASK-002: In progress task
- **Status**: in-progress
- **Dependencies**: none
- **Description**: An in-progress task
- **Verification**: Check it
`);
    const next = getNextTask(taskList);
    assert.equal(next?.id, 'TASK-002');
  });

  it('returns first in-progress task when multiple exist', () => {
    const taskList = parseTasksContent(`
### TASK-001: First in progress
- **Status**: in-progress
- **Dependencies**: none
- **Description**: First
- **Verification**: Check it

### TASK-002: Second in progress
- **Status**: in-progress
- **Dependencies**: none
- **Description**: Second
- **Verification**: Check it
`);
    const next = getNextTask(taskList);
    assert.equal(next?.id, 'TASK-001');
  });
});

// --- updateTaskStatus ---

describe('updateTaskStatus', () => {
  let tmpDir: string;
  let taskPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-test-'));
    taskPath = path.join(tmpDir, 'tasks.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('marks a pending task as done', async () => {
    await fs.writeFile(taskPath, `### TASK-001: My task
- **Status**: pending
- **Dependencies**: none
- **Description**: Do it
- **Verification**: Run npm test
`);
    const updated = await updateTaskStatus(taskPath, 'TASK-001', 'done');
    assert.equal(updated, true);
    const result = await parseTasks(taskPath);
    assert.equal(result.tasks[0].status, 'done');
  });

  it('marks a done task as pending', async () => {
    await fs.writeFile(taskPath, `### TASK-001: My task
- **Status**: done
- **Dependencies**: none
- **Description**: Do it
- **Verification**: Run npm test
`);
    await updateTaskStatus(taskPath, 'TASK-001', 'pending');
    const result = await parseTasks(taskPath);
    assert.equal(result.tasks[0].status, 'pending');
  });

  it('updates only the targeted task in a multi-task file', async () => {
    await fs.writeFile(taskPath, `### TASK-001: First
- **Status**: pending
- **Dependencies**: none
- **Description**: First
- **Verification**: Check first

### TASK-002: Second
- **Status**: pending
- **Dependencies**: none
- **Description**: Second
- **Verification**: Check second

### TASK-003: Third
- **Status**: pending
- **Dependencies**: none
- **Description**: Third
- **Verification**: Check third
`);
    await updateTaskStatus(taskPath, 'TASK-002', 'done');
    const result = await parseTasks(taskPath);
    assert.equal(result.tasks[0].status, 'pending');
    assert.equal(result.tasks[1].status, 'done');
    assert.equal(result.tasks[2].status, 'pending');
  });

  it('handles in-progress status', async () => {
    await fs.writeFile(taskPath, `### TASK-001: My task
- **Status**: pending
- **Dependencies**: none
- **Description**: Do it
- **Verification**: Run npm test
`);
    await updateTaskStatus(taskPath, 'TASK-001', 'in-progress');
    const result = await parseTasks(taskPath);
    assert.equal(result.tasks[0].status, 'in-progress');
  });

  it('returns false for a non-existent task ID', async () => {
    const content = `### TASK-001: My task
- **Status**: pending
- **Dependencies**: none
- **Description**: Do it
- **Verification**: Run npm test
`;
    await fs.writeFile(taskPath, content);
    const updated = await updateTaskStatus(taskPath, 'TASK-999', 'done');
    assert.equal(updated, false);
    const after = await fs.readFile(taskPath, 'utf-8');
    assert.equal(after, content);
  });

  it('preserves surrounding content', async () => {
    const content = `# Task List

## Metadata
- **Project**: TestProject
- **Created**: 2025-01-01
- **Author**: Dev

## Tasks

### TASK-001: Fix the bug
- **Status**: pending
- **Dependencies**: none
- **Description**: Fix the login bug
- **Verification**: Run npm test

### TASK-002: Add feature
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Add the feature
- **Verification**: Run integration tests
`;
    await fs.writeFile(taskPath, content);
    await updateTaskStatus(taskPath, 'TASK-001', 'done');

    const after = await fs.readFile(taskPath, 'utf-8');
    // Metadata should be intact
    assert.ok(after.includes('- **Project**: TestProject'));
    assert.ok(after.includes('- **Created**: 2025-01-01'));
    // TASK-001 should be done, TASK-002 still pending
    const result = await parseTasks(taskPath);
    assert.equal(result.tasks[0].status, 'done');
    assert.equal(result.tasks[1].status, 'pending');
  });
});

