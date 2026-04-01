import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseProgressContent,
  generateProgressContent,
  getCompletedTaskIds,
  readProgress,
  writeProgress,
  appendIteration
} from '../src/parser/progress.js';
import { Progress, IterationLog } from '../src/types/index.js';

// --- parseProgressContent ---

describe('parseProgressContent', () => {
  it('parses summary section', () => {
    const content = `# DevLoop Progress Log

## Summary
- **Total Tasks**: 5
- **Completed**: 2
- **Remaining**: 3
- **Last Updated**: 2025-06-01T12:00:00.000Z

## Iteration Log
`;
    const result = parseProgressContent(content);
    assert.equal(result.totalTasks, 5);
    assert.equal(result.completed, 2);
    assert.equal(result.remaining, 3);
    assert.equal(result.lastUpdated, '2025-06-01T12:00:00.000Z');
    assert.equal(result.iterations.length, 0);
  });

  it('parses iteration logs', () => {
    const content = `# DevLoop Progress Log

## Summary
- **Total Tasks**: 3
- **Completed**: 1
- **Remaining**: 2
- **Last Updated**: 2025-06-01T12:00:00.000Z

## Iteration Log

### Iteration 1 - 2025-06-01T10:00:00.000Z
- **Task Completed**: TASK-001
- **Summary**: Completed Fix the bug
- **Duration**: 45s
- **Exit Status**: success

### Iteration 2 - 2025-06-01T11:00:00.000Z
- **Task Completed**: none
- **Summary**: Failed: Something went wrong
- **Duration**: 30s
- **Exit Status**: error
`;
    const result = parseProgressContent(content);
    assert.equal(result.iterations.length, 2);

    assert.equal(result.iterations[0].iteration, 1);
    assert.equal(result.iterations[0].taskCompleted, 'TASK-001');
    assert.equal(result.iterations[0].exitStatus, 'success');
    assert.equal(result.iterations[0].duration, '45s');

    assert.equal(result.iterations[1].iteration, 2);
    assert.equal(result.iterations[1].taskCompleted, null);
    assert.equal(result.iterations[1].exitStatus, 'error');
  });

  it('parses token usage and cost', () => {
    const content = `## Summary
- **Total Tasks**: 1
- **Completed**: 1
- **Remaining**: 0
- **Last Updated**: 2025-06-01

## Iteration Log

### Iteration 1 - 2025-06-01
- **Task Completed**: TASK-001
- **Summary**: Done
- **Duration**: 60s
- **Exit Status**: success
- **Tokens**: 10,000 total (5,000 in, 3,000 out, 1,500 cache-create, 500 cache-read)
- **Cost**: $0.0350
`;
    const result = parseProgressContent(content);
    assert.equal(result.iterations.length, 1);
    const tokens = result.iterations[0].tokenUsage!;
    assert.equal(tokens.totalTokens, 10000);
    assert.equal(tokens.inputTokens, 5000);
    assert.equal(tokens.outputTokens, 3000);
    assert.equal(tokens.cacheCreationTokens, 1500);
    assert.equal(tokens.cacheReadTokens, 500);
    assert.equal(tokens.costUsd, 0.035);
  });

  it('parses error details', () => {
    const content = `## Summary
- **Total Tasks**: 1
- **Completed**: 0
- **Remaining**: 1
- **Last Updated**: 2025-06-01

## Iteration Log

### Iteration 1 - 2025-06-01
- **Task Completed**: none
- **Summary**: Failed
- **Duration**: 10s
- **Exit Status**: error
- **Error Type**: rate_limit
- **Error Detail**:
\`\`\`
Rate limit exceeded
\`\`\`
`;
    const result = parseProgressContent(content);
    assert.equal(result.iterations[0].errorType, 'rate_limit');
    assert.equal(result.iterations[0].errorDetail, 'Rate limit exceeded');
  });

  it('handles empty content', () => {
    const result = parseProgressContent('');
    assert.equal(result.totalTasks, 0);
    assert.equal(result.completed, 0);
    assert.equal(result.iterations.length, 0);
  });
});

// --- generateProgressContent ---

describe('generateProgressContent', () => {
  it('generates parseable content', () => {
    const iterations: IterationLog[] = [
      {
        iteration: 1,
        timestamp: '2025-06-01T10:00:00.000Z',
        taskCompleted: 'TASK-001',
        summary: 'Completed task one',
        duration: '45s',
        exitStatus: 'success'
      },
      {
        iteration: 2,
        timestamp: '2025-06-01T11:00:00.000Z',
        taskCompleted: null,
        summary: 'Failed task two',
        duration: '30s',
        exitStatus: 'error'
      }
    ];

    const content = generateProgressContent(5, 1, iterations);
    const parsed = parseProgressContent(content);

    assert.equal(parsed.totalTasks, 5);
    assert.equal(parsed.completed, 1);
    assert.equal(parsed.remaining, 4);
    assert.equal(parsed.iterations.length, 2);
    assert.equal(parsed.iterations[0].taskCompleted, 'TASK-001');
    assert.equal(parsed.iterations[1].taskCompleted, null);
  });

  it('includes token usage when present', () => {
    const iterations: IterationLog[] = [
      {
        iteration: 1,
        timestamp: '2025-06-01',
        taskCompleted: 'TASK-001',
        summary: 'Done',
        duration: '60s',
        exitStatus: 'success',
        tokenUsage: {
          totalTokens: 10000,
          inputTokens: 5000,
          outputTokens: 3000,
          cacheCreationTokens: 1500,
          cacheReadTokens: 500,
          costUsd: 0.035
        }
      }
    ];

    const content = generateProgressContent(1, 1, iterations);
    const parsed = parseProgressContent(content);
    assert.ok(parsed.iterations[0].tokenUsage);
    assert.equal(parsed.iterations[0].tokenUsage!.totalTokens, 10000);
    assert.equal(parsed.iterations[0].tokenUsage!.costUsd, 0.035);
  });

  it('includes error details when present', () => {
    const iterations: IterationLog[] = [
      {
        iteration: 1,
        timestamp: '2025-06-01',
        taskCompleted: null,
        summary: 'Failed',
        duration: '10s',
        exitStatus: 'error',
        errorType: 'network_error',
        errorDetail: 'Connection refused'
      }
    ];

    const content = generateProgressContent(1, 0, iterations);
    const parsed = parseProgressContent(content);
    assert.equal(parsed.iterations[0].errorType, 'network_error');
    assert.equal(parsed.iterations[0].errorDetail, 'Connection refused');
  });

  it('round-trips taskAttempted field', () => {
    const iterations: IterationLog[] = [
      {
        iteration: 1,
        timestamp: '2025-06-01',
        taskAttempted: 'TASK-002',
        taskCompleted: null,
        summary: 'Failed',
        duration: '10s',
        exitStatus: 'error'
      },
      {
        iteration: 2,
        timestamp: '2025-06-01',
        taskAttempted: 'TASK-001',
        taskCompleted: 'TASK-001',
        summary: 'Completed task one',
        duration: '45s',
        exitStatus: 'success'
      }
    ];

    const content = generateProgressContent(2, 1, iterations);
    const parsed = parseProgressContent(content);
    assert.equal(parsed.iterations[0].taskAttempted, 'TASK-002');
    assert.equal(parsed.iterations[0].taskCompleted, null);
    assert.equal(parsed.iterations[1].taskAttempted, 'TASK-001');
    assert.equal(parsed.iterations[1].taskCompleted, 'TASK-001');
  });

  it('parses old progress files without taskAttempted as undefined', () => {
    const content = `## Summary
- **Total Tasks**: 1
- **Completed**: 1
- **Remaining**: 0
- **Last Updated**: 2025-06-01

## Iteration Log

### Iteration 1 - 2025-06-01
- **Task Completed**: TASK-001
- **Summary**: Done
- **Duration**: 60s
- **Exit Status**: success
`;
    const parsed = parseProgressContent(content);
    assert.equal(parsed.iterations[0].taskAttempted, undefined);
    assert.equal(parsed.iterations[0].taskCompleted, 'TASK-001');
  });
});

// --- getCompletedTaskIds ---

describe('getCompletedTaskIds', () => {
  it('returns set of completed task IDs', () => {
    const progress: Progress = {
      totalTasks: 3,
      completed: 2,
      remaining: 1,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Done', duration: '10s', exitStatus: 'success' },
        { iteration: 2, timestamp: '2025-06-01', taskCompleted: null, summary: 'Failed', duration: '10s', exitStatus: 'error' },
        { iteration: 3, timestamp: '2025-06-01', taskCompleted: 'TASK-003', summary: 'Done', duration: '10s', exitStatus: 'success' },
      ]
    };

    const ids = getCompletedTaskIds(progress);
    assert.equal(ids.size, 2);
    assert.ok(ids.has('TASK-001'));
    assert.ok(ids.has('TASK-003'));
    assert.ok(!ids.has('TASK-002'));
  });

  it('returns empty set when no tasks completed', () => {
    const progress: Progress = {
      totalTasks: 2,
      completed: 0,
      remaining: 2,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: null, summary: 'Failed', duration: '10s', exitStatus: 'error' },
      ]
    };

    const ids = getCompletedTaskIds(progress);
    assert.equal(ids.size, 0);
  });

  it('returns empty set for progress with no iterations', () => {
    const progress: Progress = {
      totalTasks: 2,
      completed: 0,
      remaining: 2,
      lastUpdated: '2025-06-01',
      iterations: []
    };

    const ids = getCompletedTaskIds(progress);
    assert.equal(ids.size, 0);
  });

  it('deduplicates task IDs completed in multiple iterations', () => {
    const progress: Progress = {
      totalTasks: 1,
      completed: 1,
      remaining: 0,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Done', duration: '10s', exitStatus: 'success' },
        { iteration: 2, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Redone', duration: '10s', exitStatus: 'success' },
      ]
    };

    const ids = getCompletedTaskIds(progress);
    assert.equal(ids.size, 1);
    assert.ok(ids.has('TASK-001'));
  });
});

// --- readProgress / writeProgress / appendIteration (filesystem) ---

describe('readProgress', () => {
  let tmpDir: string;
  let progressPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-test-'));
    progressPath = path.join(tmpDir, 'progress.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent file', async () => {
    const result = await readProgress(progressPath);
    assert.equal(result, null);
  });

  it('reads and parses existing progress file', async () => {
    const content = generateProgressContent(3, 1, [
      { iteration: 1, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Done', duration: '10s', exitStatus: 'success' }
    ]);
    await fs.writeFile(progressPath, content, 'utf-8');

    const result = await readProgress(progressPath);
    assert.ok(result);
    assert.equal(result!.totalTasks, 3);
    assert.equal(result!.completed, 1);
    assert.equal(result!.iterations.length, 1);
  });
});

describe('writeProgress', () => {
  let tmpDir: string;
  let progressPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-test-'));
    progressPath = path.join(tmpDir, 'progress.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes progress to file', async () => {
    const progress: Progress = {
      totalTasks: 3,
      completed: 1,
      remaining: 2,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Done', duration: '10s', exitStatus: 'success' }
      ]
    };

    await writeProgress(progressPath, progress);
    const result = await readProgress(progressPath);
    assert.ok(result);
    assert.equal(result!.totalTasks, 3);
    assert.equal(result!.iterations.length, 1);
  });

  it('creates parent directories if needed', async () => {
    const nestedPath = path.join(tmpDir, 'sub', 'dir', 'progress.md');
    const progress: Progress = {
      totalTasks: 1,
      completed: 0,
      remaining: 1,
      lastUpdated: '2025-06-01',
      iterations: []
    };

    await writeProgress(nestedPath, progress);
    const result = await readProgress(nestedPath);
    assert.ok(result);
  });
});

describe('appendIteration', () => {
  let tmpDir: string;
  let progressPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-test-'));
    progressPath = path.join(tmpDir, 'progress.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates progress file if it does not exist', async () => {
    const iteration: IterationLog = {
      iteration: 1,
      timestamp: '2025-06-01',
      taskCompleted: 'TASK-001',
      summary: 'Done',
      duration: '10s',
      exitStatus: 'success'
    };

    await appendIteration(progressPath, 3, iteration);
    const result = await readProgress(progressPath);
    assert.ok(result);
    assert.equal(result!.totalTasks, 3);
    assert.equal(result!.completed, 1);
    assert.equal(result!.remaining, 2);
    assert.equal(result!.iterations.length, 1);
  });

  it('appends to existing progress', async () => {
    const iter1: IterationLog = {
      iteration: 1,
      timestamp: '2025-06-01',
      taskCompleted: 'TASK-001',
      summary: 'Done first',
      duration: '10s',
      exitStatus: 'success'
    };
    const iter2: IterationLog = {
      iteration: 2,
      timestamp: '2025-06-01',
      taskCompleted: 'TASK-002',
      summary: 'Done second',
      duration: '20s',
      exitStatus: 'success'
    };

    await appendIteration(progressPath, 3, iter1);
    await appendIteration(progressPath, 3, iter2);

    const result = await readProgress(progressPath);
    assert.ok(result);
    assert.equal(result!.iterations.length, 2);
    assert.equal(result!.completed, 2);
    assert.equal(result!.remaining, 1);
  });

  it('does not increment completed count on failure', async () => {
    const iteration: IterationLog = {
      iteration: 1,
      timestamp: '2025-06-01',
      taskCompleted: null,
      summary: 'Failed',
      duration: '10s',
      exitStatus: 'error'
    };

    await appendIteration(progressPath, 3, iteration);
    const result = await readProgress(progressPath);
    assert.ok(result);
    assert.equal(result!.completed, 0);
    assert.equal(result!.remaining, 3);
  });
});
