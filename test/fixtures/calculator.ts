import * as fs from 'fs/promises';
import * as path from 'path';
import { ClaudeResult, ClaudeErrorType, TokenUsage } from '../../src/types/index.js';
import { createSession } from '../../src/core/session.js';
import { InvokeClaudeOptions } from '../../src/core/claude.js';

// --- Workspace setup helpers ---

/** Create a calculator workspace with add/subtract tasks (Phase 1) */
export async function createCalculatorWorkspace(tmpDir: string): Promise<void> {
  const devloopDir = path.join(tmpDir, '.devloop');
  const claudeDir = path.join(tmpDir, '.claude');
  await fs.mkdir(devloopDir, { recursive: true });
  await fs.mkdir(claudeDir, { recursive: true });

  await fs.writeFile(path.join(devloopDir, 'requirements.md'), `# Calculator Project

## Overview
Build a simple calculator that supports addition and subtraction.

## Requirements
- Create a Calculator class with add() and subtract() methods
- Include unit tests for all operations
- Use TypeScript
`, 'utf-8');

  await fs.writeFile(path.join(devloopDir, 'tasks.md'), `# Calculator Tasks

### TASK-001: Project setup
- **Status**: pending
- **Dependencies**: none
- **Description**: Initialize the project with package.json and tsconfig.json
- **Verification**: Run \`npm install\` successfully

### TASK-002: Implement add function
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Create Calculator class with an add(a, b) method that returns the sum
- **Verification**: Unit test for add() passes

### TASK-003: Implement subtract function
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Add subtract(a, b) method to Calculator class
- **Verification**: Unit test for subtract() passes

### TASK-004: Integration tests
- **Status**: pending
- **Dependencies**: TASK-002, TASK-003
- **Description**: Write integration tests covering add and subtract together
- **Verification**: All tests pass with \`npm test\`
`, 'utf-8');

  await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { allow: [], deny: [] }
  }, null, 2), 'utf-8');

  await createSession(tmpDir, 'run');
}

/** Write Phase 2 tasks (multiply/divide) after archiving Phase 1 */
export async function createPhase2Tasks(tmpDir: string): Promise<void> {
  const devloopDir = path.join(tmpDir, '.devloop');

  await fs.writeFile(path.join(devloopDir, 'requirements.md'), `# Calculator Project - Phase 2

## Overview
Extend the calculator with multiplication and division support.

## Requirements
- Add multiply() and divide() methods to Calculator
- Handle division by zero
- Include unit tests for new operations
`, 'utf-8');

  await fs.writeFile(path.join(devloopDir, 'tasks.md'), `# Calculator Tasks - Phase 2

### TASK-005: Implement multiply function
- **Status**: pending
- **Dependencies**: none
- **Description**: Add multiply(a, b) method to Calculator class
- **Verification**: Unit test for multiply() passes

### TASK-006: Implement divide function
- **Status**: pending
- **Dependencies**: none
- **Description**: Add divide(a, b) method with division-by-zero handling
- **Verification**: Unit test for divide() passes including edge cases

### TASK-007: Phase 2 integration tests
- **Status**: pending
- **Dependencies**: TASK-005, TASK-006
- **Description**: Write integration tests for multiply and divide
- **Verification**: All tests pass with \`npm test\`
`, 'utf-8');
}

/** Write Phase 3 tasks (power/modulo) after archiving Phase 2 */
export async function createPhase3Tasks(tmpDir: string): Promise<void> {
  const devloopDir = path.join(tmpDir, '.devloop');

  await fs.writeFile(path.join(devloopDir, 'requirements.md'), `# Calculator Project - Phase 3

## Overview
Add power and modulo operations to the calculator.

## Requirements
- Add power() and modulo() methods to Calculator
- Include unit tests for new operations
`, 'utf-8');

  await fs.writeFile(path.join(devloopDir, 'tasks.md'), `# Calculator Tasks - Phase 3

### TASK-008: Implement power function
- **Status**: pending
- **Dependencies**: none
- **Description**: Add power(base, exp) method to Calculator class
- **Verification**: Unit test for power() passes

### TASK-009: Implement modulo function
- **Status**: pending
- **Dependencies**: none
- **Description**: Add modulo(a, b) method to Calculator class
- **Verification**: Unit test for modulo() passes
`, 'utf-8');
}

// --- Mock Claude invoker ---

const DEFAULT_TOKEN_USAGE: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 1500,
  costUsd: 0.01
};

export interface MockInvokerOptions {
  /** Default result properties applied to all tasks */
  defaultResult?: Partial<ClaudeResult>;
  /** Per-task result overrides (keyed by task ID like 'TASK-001') */
  taskResults?: Record<string, Partial<ClaudeResult>>;
}

export interface MockCall {
  prompt: string;
  taskId: string;
  workingDir: string;
}

/**
 * Create a mock invoker that returns controlled ClaudeResult objects.
 * Extracts task ID from the prompt and returns configured results.
 * Tracks all calls for assertion.
 */
export function createMockInvoker(options?: MockInvokerOptions) {
  const calls: MockCall[] = [];

  const invoker = async (
    prompt: string,
    workingDir: string,
    _opts?: InvokeClaudeOptions
  ): Promise<ClaudeResult> => {
    const taskMatch = prompt.match(/Task ID: (TASK-\d+[a-z]*)/);
    const isReview = prompt.includes('final code review');
    const isVerification = prompt.includes('consolidated test verification');
    const isBatch = prompt.includes('TASKS TO COMPLETE:');
    const taskId = taskMatch?.[1] || (isReview ? 'REVIEW' : (isVerification ? 'VERIFICATION' : (isBatch ? 'BATCH' : 'unknown')));
    calls.push({ prompt, taskId, workingDir });

    // For batch prompts, extract all task IDs and generate TASK_RESULT lines
    if (isBatch) {
      const batchTaskIds = [...prompt.matchAll(/### (TASK-\d+[a-z]*):/g)].map(m => m[1]);
      const resultLines = batchTaskIds.map(id => {
        const override = options?.taskResults?.[id];
        if (override && !override.success) {
          return `TASK_RESULT: ${id}: FAILED: ${override.error || 'Task failed'}`;
        }
        return `TASK_RESULT: ${id}: SUCCESS`;
      });

      const result: ClaudeResult = {
        success: true,
        output: resultLines.join('\n'),
        rawOutput: resultLines.join('\n'),
        duration: 1500,
        exitCode: 0,
        signal: null,
        tokenUsage: { ...DEFAULT_TOKEN_USAGE },
        ...options?.defaultResult,
      };
      return result;
    }

    const taskOverride = options?.taskResults?.[taskId];

    const result: ClaudeResult = {
      success: true,
      output: isReview ? '# Code Review\n\nAll requirements met. No issues found.'
        : isVerification ? 'All verifications passed.'
        : `Completed ${taskId}`,
      rawOutput: `{"type":"result","result":"${isReview ? 'Review complete' : (isVerification ? 'Verification complete' : `Completed ${taskId}`)}"}`,
      duration: 1500,
      exitCode: 0,
      signal: null,
      tokenUsage: { ...DEFAULT_TOKEN_USAGE },
      ...options?.defaultResult,
      ...taskOverride,
    };

    return result;
  };

  return { invoker, calls };
}

/** Create a mock that fails on the first attempt for a task, succeeds on retries */
export function createRetryMockInvoker(failTaskId: string, failCount: number = 1) {
  const attemptCounts = new Map<string, number>();

  return createMockInvoker({
    taskResults: {
      [failTaskId]: {} // placeholder, overridden dynamically
    },
    defaultResult: {
      // We override the invoker to handle retry logic
    }
  });
  // The above won't work for dynamic behavior, so use a custom invoker:
}

/** Create a mock that fails a specific task N times before succeeding */
export function createFailThenSucceedMock(failTaskId: string, failCount: number = 1) {
  const calls: MockCall[] = [];
  const attemptCounts = new Map<string, number>();

  const invoker = async (
    prompt: string,
    workingDir: string,
    _opts?: InvokeClaudeOptions
  ): Promise<ClaudeResult> => {
    const taskMatch = prompt.match(/Task ID: (TASK-\d+[a-z]*)/);
    const isReview = prompt.includes('final code review');
    const isVerification = prompt.includes('consolidated test verification');
    const taskId = taskMatch?.[1] || (isReview ? 'REVIEW' : (isVerification ? 'VERIFICATION' : 'unknown'));
    calls.push({ prompt, taskId, workingDir });

    if (isReview || isVerification) {
      return {
        success: true,
        output: isReview ? '# Code Review\n\nAll requirements met. No issues found.' : 'All verifications passed.',
        rawOutput: `{"type":"result","result":"${isReview ? 'Review complete' : 'Verification complete'}"}`,
        duration: 1500,
        exitCode: 0,
        signal: null,
        tokenUsage: { ...DEFAULT_TOKEN_USAGE }
      };
    }

    const attempts = (attemptCounts.get(taskId) || 0) + 1;
    attemptCounts.set(taskId, attempts);

    if (taskId === failTaskId && attempts <= failCount) {
      return {
        success: false,
        output: '',
        rawOutput: '',
        error: `Task ${taskId} failed (attempt ${attempts})`,
        errorType: 'task_failure' as ClaudeErrorType,
        duration: 1000,
        exitCode: 1,
        signal: null,
        tokenUsage: { ...DEFAULT_TOKEN_USAGE, costUsd: 0.005 }
      };
    }

    return {
      success: true,
      output: `Completed ${taskId}`,
      rawOutput: `{"type":"result","result":"Completed ${taskId}"}`,
      duration: 1500,
      exitCode: 0,
      signal: null,
      tokenUsage: { ...DEFAULT_TOKEN_USAGE }
    };
  };

  return { invoker, calls };
}
