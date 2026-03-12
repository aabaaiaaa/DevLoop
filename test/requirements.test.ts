import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseRequirementsContent,
  parseRequirements,
  getNextTask,
  updateTaskStatus,
  generateRequirementsTemplate
} from '../src/parser/requirements.js';

// --- parseRequirementsContent ---

describe('parseRequirementsContent', () => {
  it('parses a single task with all fields', () => {
    const content = `# Project Requirements

## Metadata
- **Project**: TestProject
- **Created**: 2025-01-01
- **Author**: Dev

## Tasks

### TASK-001: Fix the bug
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Fix the login bug
`;
    const result = parseRequirementsContent(content);
    assert.equal(result.projectName, 'TestProject');
    assert.equal(result.created, '2025-01-01');
    assert.equal(result.author, 'Dev');
    assert.equal(result.tasks.length, 1);

    const task = result.tasks[0];
    assert.equal(task.id, 'TASK-001');
    assert.equal(task.title, 'Fix the bug');
    assert.equal(task.status, 'pending');
    assert.equal(task.priority, 'high');
    assert.deepEqual(task.dependencies, []);
    assert.equal(task.description, 'Fix the login bug');
  });

  it('parses multiple tasks', () => {
    const content = `# Proj

### TASK-001: First
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: First task

### TASK-002: Second
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-001
- **Description**: Second task

### TASK-003: Third
- **Status**: in-progress
- **Priority**: low
- **Dependencies**: TASK-001, TASK-002
- **Description**: Third task
`;
    const result = parseRequirementsContent(content);
    assert.equal(result.tasks.length, 3);

    assert.equal(result.tasks[0].status, 'done');
    assert.equal(result.tasks[1].status, 'pending');
    assert.equal(result.tasks[1].priority, 'medium');
    assert.deepEqual(result.tasks[1].dependencies, ['TASK-001']);
    assert.equal(result.tasks[2].status, 'in-progress');
    assert.deepEqual(result.tasks[2].dependencies, ['TASK-001', 'TASK-002']);
  });

  it('defaults missing fields', () => {
    const content = `### TASK-001: Minimal task
`;
    const result = parseRequirementsContent(content);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].status, 'pending');
    assert.equal(result.tasks[0].priority, 'medium');
    assert.deepEqual(result.tasks[0].dependencies, []);
    assert.equal(result.tasks[0].description, '');
  });

  it('extracts project name from markdown title when no metadata', () => {
    const content = `# My Cool Project

### TASK-001: Do something
- **Status**: pending
- **Priority**: low
- **Dependencies**: none
- **Description**: Do it
`;
    const result = parseRequirementsContent(content);
    assert.equal(result.projectName, 'My Cool Project');
  });

  it('returns "Unknown Project" when no project info', () => {
    const content = `### TASK-001: A task
- **Status**: pending
`;
    const result = parseRequirementsContent(content);
    assert.equal(result.projectName, 'Unknown Project');
  });

  it('handles empty content with no tasks', () => {
    const result = parseRequirementsContent('');
    assert.equal(result.tasks.length, 0);
  });

  it('is case-insensitive for status values', () => {
    const content = `### TASK-001: Task
- **Status**: Done
- **Priority**: High
`;
    const result = parseRequirementsContent(content);
    assert.equal(result.tasks[0].status, 'done');
    assert.equal(result.tasks[0].priority, 'high');
  });
});

// --- getNextTask ---

describe('getNextTask', () => {
  it('returns highest priority pending task', () => {
    const reqs = parseRequirementsContent(`
### TASK-001: Low pri
- **Status**: pending
- **Priority**: low
- **Dependencies**: none
- **Description**: Low

### TASK-002: High pri
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: High
`);
    const next = getNextTask(reqs);
    assert.equal(next?.id, 'TASK-002');
  });

  it('skips done tasks', () => {
    const reqs = parseRequirementsContent(`
### TASK-001: Done task
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Done

### TASK-002: Pending task
- **Status**: pending
- **Priority**: medium
- **Dependencies**: none
- **Description**: Pending
`);
    const next = getNextTask(reqs);
    assert.equal(next?.id, 'TASK-002');
  });

  it('respects dependencies', () => {
    const reqs = parseRequirementsContent(`
### TASK-001: First
- **Status**: pending
- **Priority**: low
- **Dependencies**: none
- **Description**: First

### TASK-002: Second (blocked)
- **Status**: pending
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Blocked by TASK-001
`);
    // TASK-002 is higher priority but blocked
    const next = getNextTask(reqs);
    assert.equal(next?.id, 'TASK-001');
  });

  it('unblocks task when dependency is done', () => {
    const reqs = parseRequirementsContent(`
### TASK-001: First
- **Status**: done
- **Priority**: low
- **Dependencies**: none
- **Description**: First

### TASK-002: Second
- **Status**: pending
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Depends on TASK-001
`);
    const next = getNextTask(reqs);
    assert.equal(next?.id, 'TASK-002');
  });

  it('returns null when all tasks are done', () => {
    const reqs = parseRequirementsContent(`
### TASK-001: Only task
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Done
`);
    assert.equal(getNextTask(reqs), null);
  });

  it('returns null when all pending tasks are blocked', () => {
    const reqs = parseRequirementsContent(`
### TASK-001: Blocked
- **Status**: pending
- **Priority**: high
- **Dependencies**: TASK-002
- **Description**: Blocked

### TASK-002: Also blocked
- **Status**: pending
- **Priority**: high
- **Dependencies**: TASK-001
- **Description**: Circular
`);
    assert.equal(getNextTask(reqs), null);
  });

  it('breaks priority ties by task ID', () => {
    const reqs = parseRequirementsContent(`
### TASK-003: Third
- **Status**: pending
- **Priority**: medium
- **Dependencies**: none
- **Description**: Third

### TASK-001: First
- **Status**: pending
- **Priority**: medium
- **Dependencies**: none
- **Description**: First
`);
    const next = getNextTask(reqs);
    assert.equal(next?.id, 'TASK-001');
  });
});

// --- updateTaskStatus ---

describe('updateTaskStatus', () => {
  let tmpDir: string;
  let reqPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-test-'));
    reqPath = path.join(tmpDir, 'requirements.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('marks a pending task as done', async () => {
    await fs.writeFile(reqPath, `### TASK-001: My task
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Do it
`);
    await updateTaskStatus(reqPath, 'TASK-001', 'done');
    const result = await parseRequirements(reqPath);
    assert.equal(result.tasks[0].status, 'done');
  });

  it('marks a done task as pending', async () => {
    await fs.writeFile(reqPath, `### TASK-001: My task
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Do it
`);
    await updateTaskStatus(reqPath, 'TASK-001', 'pending');
    const result = await parseRequirements(reqPath);
    assert.equal(result.tasks[0].status, 'pending');
  });

  it('updates only the targeted task in a multi-task file', async () => {
    await fs.writeFile(reqPath, `### TASK-001: First
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: First

### TASK-002: Second
- **Status**: pending
- **Priority**: medium
- **Dependencies**: none
- **Description**: Second

### TASK-003: Third
- **Status**: pending
- **Priority**: low
- **Dependencies**: none
- **Description**: Third
`);
    await updateTaskStatus(reqPath, 'TASK-002', 'done');
    const result = await parseRequirements(reqPath);
    assert.equal(result.tasks[0].status, 'pending');
    assert.equal(result.tasks[1].status, 'done');
    assert.equal(result.tasks[2].status, 'pending');
  });

  it('handles in-progress status', async () => {
    await fs.writeFile(reqPath, `### TASK-001: My task
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Do it
`);
    await updateTaskStatus(reqPath, 'TASK-001', 'in-progress');
    const result = await parseRequirements(reqPath);
    assert.equal(result.tasks[0].status, 'in-progress');
  });

  it('does nothing for a non-existent task ID', async () => {
    const content = `### TASK-001: My task
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Do it
`;
    await fs.writeFile(reqPath, content);
    await updateTaskStatus(reqPath, 'TASK-999', 'done');
    const after = await fs.readFile(reqPath, 'utf-8');
    assert.equal(after, content);
  });

  it('preserves surrounding content', async () => {
    const content = `# Project Requirements

## Metadata
- **Project**: TestProject
- **Created**: 2025-01-01
- **Author**: Dev

## Tasks

### TASK-001: Fix the bug
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Fix the login bug

### TASK-002: Add feature
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-001
- **Description**: Add the feature
`;
    await fs.writeFile(reqPath, content);
    await updateTaskStatus(reqPath, 'TASK-001', 'done');

    const after = await fs.readFile(reqPath, 'utf-8');
    // Metadata should be intact
    assert.ok(after.includes('- **Project**: TestProject'));
    assert.ok(after.includes('- **Created**: 2025-01-01'));
    // TASK-001 should be done, TASK-002 still pending
    const result = await parseRequirements(reqPath);
    assert.equal(result.tasks[0].status, 'done');
    assert.equal(result.tasks[1].status, 'pending');
  });
});

// --- generateRequirementsTemplate ---

describe('generateRequirementsTemplate', () => {
  it('includes project name and example tasks', () => {
    const template = generateRequirementsTemplate('MyProject');
    assert.ok(template.includes('**Project**: MyProject'));
    assert.ok(template.includes('TASK-001'));
    assert.ok(template.includes('TASK-002'));
    assert.ok(template.includes('TASK-003'));
  });

  it('generates parseable content', () => {
    const template = generateRequirementsTemplate('Test');
    const result = parseRequirementsContent(template);
    assert.equal(result.tasks.length, 3);
    assert.equal(result.tasks[0].status, 'pending');
    assert.equal(result.tasks[1].dependencies.length, 1);
  });
});
