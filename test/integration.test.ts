import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { runLoop, RunLoopOverrides } from '../src/core/loop.js';
import { buildRunConfig } from '../src/commands/shared.js';
import { readProgress } from '../src/parser/progress.js';
import { parseTasks, getNextTask } from '../src/parser/tasks.js';
import { readSession, createSession } from '../src/core/session.js';
import { archiveIteration, getArchivedIterations } from '../src/core/archive.js';
import {
  createCalculatorWorkspace,
  createPhase2Tasks,
  createMockInvoker,
  createFailThenSucceedMock
} from './fixtures/calculator.js';

const TEST_OVERRIDES: RunLoopOverrides = {
  skipStdin: true,
  skipGit: true,
};

describe('integration: calculator project lifecycle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-int-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Phase 1: Run add/subtract tasks ---

  describe('Phase 1: add/subtract tasks', () => {
    it('executes all tasks in dependency order', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Filter out the review and verification calls
      const taskCalls = calls.filter(c => c.taskId !== 'REVIEW' && c.taskId !== 'VERIFICATION');

      // All 4 tasks should have been attempted
      assert.equal(taskCalls.length, 4);

      // TASK-001 must be first (no deps)
      assert.equal(taskCalls[0].taskId, 'TASK-001');

      // TASK-002 and TASK-003 both depend on TASK-001, come next (order by ID)
      assert.equal(taskCalls[1].taskId, 'TASK-002');
      assert.equal(taskCalls[2].taskId, 'TASK-003');

      // TASK-004 depends on TASK-002 + TASK-003, must be last
      assert.equal(taskCalls[3].taskId, 'TASK-004');

      // All tasks should be marked done in tasks.md
      const taskList = await parseTasks(path.join(tmpDir, '.devloop', 'tasks.md'));
      for (const task of taskList.tasks) {
        assert.equal(task.status, 'done', `${task.id} should be done`);
      }

      // Progress should have 4 task iterations + 1 verification iteration
      const progress = await readProgress(path.join(tmpDir, '.devloop', 'progress.md'));
      assert.ok(progress);
      const taskIterations = progress!.iterations.filter(i => i.taskAttempted !== 'VERIFICATION');
      assert.equal(taskIterations.length, 4);
      assert.equal(progress!.completed, 4);
      for (const iter of taskIterations) {
        assert.equal(iter.exitStatus, 'success');
        assert.ok(iter.taskAttempted);
        assert.ok(iter.taskCompleted);
      }

      // Verification iteration should exist
      const verificationIter = progress!.iterations.find(i => i.taskAttempted === 'VERIFICATION');
      assert.ok(verificationIter);
      assert.equal(verificationIter!.exitStatus, 'success');

      // Session should be updated
      const session = await readSession(tmpDir);
      assert.ok(session);
      assert.equal(session!.lastIteration, 4);

      // Task logs should exist (4 tasks + VERIFICATION.log)
      const logsDir = path.join(tmpDir, '.devloop', 'logs');
      const logs = await fs.readdir(logsDir);
      assert.equal(logs.length, 5);
      assert.ok(logs.includes('TASK-001.log'));
      assert.ok(logs.includes('TASK-004.log'));
      assert.ok(logs.includes('VERIFICATION.log'));
    });

    it('respects task dependencies (only runs eligible tasks)', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '1',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Only TASK-001 should be attempted (the only task with no deps)
      assert.equal(calls.length, 1);
      assert.equal(calls[0].taskId, 'TASK-001');

      // TASK-001 done, rest still pending
      const taskList = await parseTasks(path.join(tmpDir, '.devloop', 'tasks.md'));
      assert.equal(taskList.tasks.find(t => t.id === 'TASK-001')!.status, 'done');
      assert.equal(taskList.tasks.find(t => t.id === 'TASK-002')!.status, 'pending');
    });

    it('retries failed tasks and eventually completes them', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createFailThenSucceedMock('TASK-002', 1);

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Filter out the review and verification calls
      const taskCalls = calls.filter(c => c.taskId !== 'REVIEW' && c.taskId !== 'VERIFICATION');

      // Should have 5 task calls: TASK-001, TASK-002 (fail), TASK-002 (succeed), TASK-003, TASK-004
      assert.equal(taskCalls.length, 5);
      assert.equal(taskCalls[0].taskId, 'TASK-001');
      assert.equal(taskCalls[1].taskId, 'TASK-002'); // first attempt - fails
      assert.equal(taskCalls[2].taskId, 'TASK-002'); // retry - succeeds
      assert.equal(taskCalls[3].taskId, 'TASK-003');
      assert.equal(taskCalls[4].taskId, 'TASK-004');

      // All tasks should be done
      const taskList = await parseTasks(path.join(tmpDir, '.devloop', 'tasks.md'));
      for (const task of taskList.tasks) {
        assert.equal(task.status, 'done', `${task.id} should be done`);
      }

      // Progress should show the failure, retry, and verification
      const progress = await readProgress(path.join(tmpDir, '.devloop', 'progress.md'));
      assert.ok(progress);
      const taskIters = progress!.iterations.filter(i => i.taskAttempted !== 'VERIFICATION');
      assert.equal(taskIters.length, 5);

      const failedIter = progress!.iterations.find(
        i => i.exitStatus === 'error' && i.taskAttempted === 'TASK-002'
      );
      assert.ok(failedIter, 'Should have a failed iteration for TASK-002');
      assert.equal(failedIter!.errorType, 'task_failure');

      const succeededIter = progress!.iterations.find(
        i => i.exitStatus === 'success' && i.taskCompleted === 'TASK-002'
      );
      assert.ok(succeededIter, 'Should have a successful iteration for TASK-002');
    });
  });

  // --- Phase 2: Archive and run multiply/divide ---

  describe('Phase 2: archive and multiply/divide', () => {
    it('archives iteration and runs new tasks', async () => {
      // Set up completed Phase 1 workspace
      await createCalculatorWorkspace(tmpDir);
      const { invoker: phase1Invoker } = createMockInvoker();

      const phase1Config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(phase1Config, { ...TEST_OVERRIDES, invoker: phase1Invoker });

      // Archive Phase 1 (simulating "devloop continue" option 3)
      await archiveIteration(tmpDir, 1);

      // Verify archive exists
      const archiveDir = path.join(tmpDir, '.devloop', 'archive', 'iteration-1');
      const archiveFiles = await fs.readdir(archiveDir);
      assert.ok(archiveFiles.includes('requirements.md'));
      assert.ok(archiveFiles.includes('tasks.md'));
      assert.ok(archiveFiles.includes('progress.md'));

      // Create Phase 2 tasks and new session
      await createPhase2Tasks(tmpDir);
      await createSession(tmpDir, 'run', 2);

      // Run Phase 2
      const { invoker: phase2Invoker, calls: phase2Calls } = createMockInvoker();

      const phase2Config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(phase2Config, { ...TEST_OVERRIDES, invoker: phase2Invoker });

      // Filter out the review and verification calls
      const taskCalls = phase2Calls.filter(c => c.taskId !== 'REVIEW' && c.taskId !== 'VERIFICATION');

      // All 3 Phase 2 tasks should have been executed
      assert.equal(taskCalls.length, 3);
      assert.equal(taskCalls[0].taskId, 'TASK-005');
      assert.equal(taskCalls[1].taskId, 'TASK-006');
      assert.equal(taskCalls[2].taskId, 'TASK-007');

      // All Phase 2 tasks done
      const taskList = await parseTasks(path.join(tmpDir, '.devloop', 'tasks.md'));
      for (const task of taskList.tasks) {
        assert.equal(task.status, 'done', `${task.id} should be done`);
      }

      // Session should reflect iteration 2
      const session = await readSession(tmpDir);
      assert.ok(session);
      assert.equal(session!.iteration, 2);
    });
  });

  // --- Limits ---

  describe('cost and iteration limits', () => {
    it('stops when cost limit is reached', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker({
        defaultResult: {
          tokenUsage: {
            inputTokens: 5000,
            outputTokens: 3000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 8000,
            costUsd: 4.00  // $4 per task
          }
        }
      });

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        costLimit: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // At $4/task with $10 limit: should run 2 tasks ($8), then stop before 3rd ($12 would exceed)
      // TASK-001 ($4) + TASK-002 ($8) then cost check triggers
      assert.ok(calls.length >= 2, `Should run at least 2 tasks but ran ${calls.length}`);
      assert.ok(calls.length <= 3, `Should stop at cost limit but ran ${calls.length}`);
    });

    it('stops when max iterations reached', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '2',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Should only run 2 iterations
      assert.equal(calls.length, 2);
    });
  });

  // --- Graceful shutdown ---

  describe('graceful shutdown', () => {
    it('stops after current task and shows stop message', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      // Capture console output
      const output: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        output.push(args.map(String).join(' '));
        originalLog(...args);
      };

      try {
        // Simulate Q press after 2 iterations
        await runLoop(config, { ...TEST_OVERRIDES, invoker, stopAfterIterations: 2 });
      } finally {
        console.log = originalLog;
      }

      // Should have run exactly 2 tasks then stopped
      assert.equal(calls.length, 2);
      assert.equal(calls[0].taskId, 'TASK-001');
      assert.equal(calls[1].taskId, 'TASK-002');

      // Should show stop acknowledgement message in output
      const stopMessage = output.find(line => line.includes('Stopping as requested') || line.includes('completed. Stopping'));
      assert.ok(stopMessage, `Expected stop message in output, got:\n${output.join('\n')}`);

      // Both completed tasks should be marked done (graceful stop preserves work)
      const taskList = await parseTasks(path.join(tmpDir, '.devloop', 'tasks.md'));
      assert.equal(taskList.tasks.find(t => t.id === 'TASK-001')!.status, 'done');
      assert.equal(taskList.tasks.find(t => t.id === 'TASK-002')!.status, 'done');

      // Remaining tasks still pending
      assert.equal(taskList.tasks.find(t => t.id === 'TASK-003')!.status, 'pending');
      assert.equal(taskList.tasks.find(t => t.id === 'TASK-004')!.status, 'pending');

      // Progress should have 2 successful iterations
      const progress = await readProgress(path.join(tmpDir, '.devloop', 'progress.md'));
      assert.ok(progress);
      assert.equal(progress!.iterations.length, 2);
      assert.equal(progress!.completed, 2);
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('stops loop on API error', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker({
        taskResults: {
          'TASK-002': {
            success: false,
            output: '',
            rawOutput: '',
            error: 'Rate limit exceeded',
            errorType: 'rate_limit',
            duration: 500,
            exitCode: 1,
            signal: null,
            tokenUsage: undefined
          }
        }
      });

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // TASK-001 succeeds, TASK-002 hits rate limit, loop stops
      assert.equal(calls.length, 2);
      assert.equal(calls[0].taskId, 'TASK-001');
      assert.equal(calls[1].taskId, 'TASK-002');

      // Progress should record the error
      const progress = await readProgress(path.join(tmpDir, '.devloop', 'progress.md'));
      assert.ok(progress);
      const errorIter = progress!.iterations.find(i => i.exitStatus === 'error');
      assert.ok(errorIter);
      assert.equal(errorIter!.errorType, 'rate_limit');

      // TASK-002 should remain in-progress
      const taskList = await parseTasks(path.join(tmpDir, '.devloop', 'tasks.md'));
      assert.equal(taskList.tasks.find(t => t.id === 'TASK-002')!.status, 'in-progress');
    });

    it('continues loop on task failure (non-API error)', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker({
        taskResults: {
          'TASK-002': {
            success: false,
            output: '',
            rawOutput: '',
            error: 'Tests failed',
            errorType: 'task_failure',
            duration: 1000,
            exitCode: 1,
            signal: null,
            tokenUsage: {
              inputTokens: 1000, outputTokens: 500,
              cacheCreationTokens: 0, cacheReadTokens: 0,
              totalTokens: 1500, costUsd: 0.01
            }
          }
        }
      });

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Loop should continue past task_failure
      // TASK-001 ok, TASK-002 fail, TASK-002 retry (still fails), ...
      // Eventually all iterations used or tasks blocked
      assert.ok(calls.length > 2, 'Loop should continue past task_failure');
    });
  });

  // --- Token tracking ---

  describe('token tracking', () => {
    it('records token usage per iteration in progress', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker } = createMockInvoker({
        defaultResult: {
          tokenUsage: {
            inputTokens: 2000,
            outputTokens: 800,
            cacheCreationTokens: 100,
            cacheReadTokens: 50,
            totalTokens: 2950,
            costUsd: 0.025
          }
        }
      });

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      const progress = await readProgress(path.join(tmpDir, '.devloop', 'progress.md'));
      assert.ok(progress);

      for (const iter of progress!.iterations) {
        assert.ok(iter.tokenUsage, `Iteration ${iter.iteration} should have token usage`);
        assert.equal(iter.tokenUsage!.totalTokens, 2950);
        assert.equal(iter.tokenUsage!.costUsd, 0.025);
      }
    });
  });

  // --- Status data ---

  describe('status', () => {
    it('reports correct status after a partial run', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '2',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Read the same data that statusCommand reads
      const tasksPath = path.join(tmpDir, '.devloop', 'tasks.md');
      const progressPath = path.join(tmpDir, '.devloop', 'progress.md');

      const taskList = await parseTasks(tasksPath);
      const progress = await readProgress(progressPath);
      const session = await readSession(tmpDir);
      const nextTask = getNextTask(taskList);

      const pending = taskList.tasks.filter(t => t.status === 'pending');
      const done = taskList.tasks.filter(t => t.status === 'done');

      // 2 iterations ran: TASK-001 and TASK-002 done
      assert.equal(done.length, 2);
      assert.equal(pending.length, 2);
      assert.ok(progress);
      assert.equal(progress!.iterations.length, 2);
      assert.equal(progress!.completed, 2);
      assert.equal(progress!.remaining, 2);

      // Next task should be TASK-003 (depends on TASK-001 which is done)
      assert.ok(nextTask);
      assert.equal(nextTask!.id, 'TASK-003');

      // Session should have version and phase
      assert.ok(session);
      assert.equal(session!.phase, 'run');
      assert.ok(session!.devloopVersion);

      // Token totals should be calculable from progress
      let totalTokens = 0;
      let totalCost = 0;
      for (const iter of progress!.iterations) {
        if (iter.tokenUsage) {
          totalTokens += iter.tokenUsage.totalTokens;
          totalCost += iter.tokenUsage.costUsd;
        }
      }
      assert.equal(totalTokens, 3000); // 1500 * 2 iterations
      assert.equal(totalCost, 0.02);   // 0.01 * 2 iterations
    });

    it('reports correct status after all tasks complete', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      const tasksPath = path.join(tmpDir, '.devloop', 'tasks.md');
      const taskList = await parseTasks(tasksPath);
      const nextTask = getNextTask(taskList);

      const done = taskList.tasks.filter(t => t.status === 'done');
      const pending = taskList.tasks.filter(t => t.status === 'pending');

      assert.equal(done.length, 4);
      assert.equal(pending.length, 0);
      assert.equal(nextTask, null); // No next task — all done
    });

    it('reports correct status after failed iteration', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker } = createMockInvoker({
        taskResults: {
          'TASK-002': {
            success: false,
            output: '',
            rawOutput: '',
            error: 'Rate limit exceeded',
            errorType: 'rate_limit',
            duration: 500,
            exitCode: 1,
            signal: null,
            tokenUsage: undefined
          }
        }
      });

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      const progressPath = path.join(tmpDir, '.devloop', 'progress.md');
      const progress = await readProgress(progressPath);
      assert.ok(progress);

      // Last iteration should be the failure
      const lastIter = progress!.iterations[progress!.iterations.length - 1];
      assert.equal(lastIter.exitStatus, 'error');
      assert.equal(lastIter.errorType, 'rate_limit');
      assert.ok(lastIter.taskAttempted);
    });

    it('reports correct status with archived iterations', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Archive and set up phase 2
      await archiveIteration(tmpDir, 1);
      await createPhase2Tasks(tmpDir);
      await createSession(tmpDir, 'run', 2);

      const session = await readSession(tmpDir);
      const archived = await getArchivedIterations(tmpDir);

      assert.equal(session!.iteration, 2);
      assert.equal(archived.length, 1);
      assert.ok(archived.includes(1));
    });
  });

  // --- Final code review ---

  describe('final code review', () => {
    it('creates review.md when all tasks complete', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker, calls } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Review file should exist
      const reviewPath = path.join(tmpDir, '.devloop', 'review.md');
      const reviewContent = await fs.readFile(reviewPath, 'utf-8');
      assert.ok(reviewContent.includes('Code Review'));

      // Mock should have been called with a review prompt
      const reviewCall = calls.find(c => c.taskId === 'REVIEW');
      assert.ok(reviewCall, 'Expected a review invocation');
      assert.ok(reviewCall!.prompt.includes('final code review'));
    });

    it('does not create review.md when stopped early', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '2',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Only 2 of 4 tasks ran — review should NOT exist
      const reviewPath = path.join(tmpDir, '.devloop', 'review.md');
      try {
        await fs.access(reviewPath);
        assert.fail('review.md should not exist when tasks are incomplete');
      } catch {
        // Expected — file does not exist
      }
    });

    it('archives review.md when starting next iteration', async () => {
      await createCalculatorWorkspace(tmpDir);
      const { invoker } = createMockInvoker();

      const config = buildRunConfig({
        workspace: tmpDir,
        maxIterations: '10',
        sessionAction: 'none',
      });

      await runLoop(config, { ...TEST_OVERRIDES, invoker });

      // Review should exist before archiving
      const reviewPath = path.join(tmpDir, '.devloop', 'review.md');
      await fs.access(reviewPath);

      // Archive iteration 1
      await archiveIteration(tmpDir, 1);

      // Review should be in archive
      const archivedReview = path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'review.md');
      const content = await fs.readFile(archivedReview, 'utf-8');
      assert.ok(content.includes('Code Review'));

      // Review should be deleted from workspace
      try {
        await fs.access(reviewPath);
        assert.fail('review.md should be deleted after archiving');
      } catch {
        // Expected — file was cleaned up
      }
    });
  });
});
