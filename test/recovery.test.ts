import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { parseRequirements, updateTaskStatus } from '../src/parser/requirements.js';
import { readProgress, writeProgress, getCompletedTaskIds } from '../src/parser/progress.js';
import { Progress } from '../src/types/index.js';

/**
 * Integration tests for the cross-reference recovery logic.
 * This simulates what loop.ts does: compare requirements.md tasks marked "done"
 * against progress.md completion logs, and revert any that lack a log entry.
 */

async function runRecovery(reqPath: string, progPath: string): Promise<string[]> {
  const progress = await readProgress(progPath);
  const completedIds = progress ? getCompletedTaskIds(progress) : new Set<string>();
  const reqs = await parseRequirements(reqPath);
  const reverted: string[] = [];

  for (const task of reqs.tasks) {
    if (task.status === 'done' && !completedIds.has(task.id)) {
      await updateTaskStatus(reqPath, task.id, 'pending');
      reverted.push(task.id);
    }
  }
  return reverted;
}

describe('cross-reference recovery', () => {
  let tmpDir: string;
  let reqPath: string;
  let progPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-recovery-'));
    reqPath = path.join(tmpDir, 'requirements.md');
    progPath = path.join(tmpDir, 'progress.md');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reverts a task marked done with no progress entry', async () => {
    await fs.writeFile(reqPath, `### TASK-001: Do something
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Task was falsely marked done
`);
    // No progress file at all

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, ['TASK-001']);

    const reqs = await parseRequirements(reqPath);
    assert.equal(reqs.tasks[0].status, 'pending');
  });

  it('does not revert a task that has a progress entry', async () => {
    await fs.writeFile(reqPath, `### TASK-001: Do something
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Legitimately completed
`);

    const progress: Progress = {
      totalTasks: 1,
      completed: 1,
      remaining: 0,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Done', duration: '10s', exitStatus: 'success' }
      ]
    };
    await writeProgress(progPath, progress);

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, []);

    const reqs = await parseRequirements(reqPath);
    assert.equal(reqs.tasks[0].status, 'done');
  });

  it('reverts only falsely-done tasks, keeps legitimately-done ones', async () => {
    await fs.writeFile(reqPath, `### TASK-001: Real done
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Completed for real

### TASK-002: Falsely done
- **Status**: done
- **Priority**: medium
- **Dependencies**: none
- **Description**: Claude marked this done prematurely

### TASK-003: Still pending
- **Status**: pending
- **Priority**: low
- **Dependencies**: none
- **Description**: Not started
`);

    const progress: Progress = {
      totalTasks: 3,
      completed: 1,
      remaining: 2,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Done', duration: '10s', exitStatus: 'success' }
      ]
    };
    await writeProgress(progPath, progress);

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, ['TASK-002']);

    const reqs = await parseRequirements(reqPath);
    assert.equal(reqs.tasks[0].status, 'done');
    assert.equal(reqs.tasks[1].status, 'pending');
    assert.equal(reqs.tasks[2].status, 'pending');
  });

  it('reverts multiple falsely-done tasks', async () => {
    await fs.writeFile(reqPath, `### TASK-001: False done 1
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: False

### TASK-002: False done 2
- **Status**: done
- **Priority**: medium
- **Dependencies**: none
- **Description**: Also false

### TASK-003: False done 3
- **Status**: done
- **Priority**: low
- **Dependencies**: none
- **Description**: Still false
`);
    // No progress file

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, ['TASK-001', 'TASK-002', 'TASK-003']);

    const reqs = await parseRequirements(reqPath);
    assert.ok(reqs.tasks.every(t => t.status === 'pending'));
  });

  it('handles empty progress file (no iterations)', async () => {
    await fs.writeFile(reqPath, `### TASK-001: False done
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: False
`);

    const progress: Progress = {
      totalTasks: 1,
      completed: 0,
      remaining: 1,
      lastUpdated: '2025-06-01',
      iterations: []
    };
    await writeProgress(progPath, progress);

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, ['TASK-001']);
  });

  it('does nothing when all tasks are pending', async () => {
    await fs.writeFile(reqPath, `### TASK-001: Pending
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: Not started

### TASK-002: Also pending
- **Status**: pending
- **Priority**: medium
- **Dependencies**: none
- **Description**: Not started either
`);

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, []);
  });

  it('does nothing when all done tasks have progress entries', async () => {
    await fs.writeFile(reqPath, `### TASK-001: Done
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Legit

### TASK-002: Also done
- **Status**: done
- **Priority**: medium
- **Dependencies**: none
- **Description**: Also legit
`);

    const progress: Progress = {
      totalTasks: 2,
      completed: 2,
      remaining: 0,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: 'TASK-001', summary: 'Done', duration: '10s', exitStatus: 'success' },
        { iteration: 2, timestamp: '2025-06-01', taskCompleted: 'TASK-002', summary: 'Done', duration: '10s', exitStatus: 'success' },
      ]
    };
    await writeProgress(progPath, progress);

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, []);
  });

  it('ignores failed iterations (taskCompleted is null) for cross-reference', async () => {
    await fs.writeFile(reqPath, `### TASK-001: Falsely done
- **Status**: done
- **Priority**: high
- **Dependencies**: none
- **Description**: Claude marked done but iteration failed
`);

    // Progress has an iteration for TASK-001 but it was a failure (taskCompleted: null)
    const progress: Progress = {
      totalTasks: 1,
      completed: 0,
      remaining: 1,
      lastUpdated: '2025-06-01',
      iterations: [
        { iteration: 1, timestamp: '2025-06-01', taskCompleted: null, summary: 'Attempted TASK-001 but failed', duration: '10s', exitStatus: 'error' }
      ]
    };
    await writeProgress(progPath, progress);

    const reverted = await runRecovery(reqPath, progPath);
    assert.deepEqual(reverted, ['TASK-001']);
  });
});
