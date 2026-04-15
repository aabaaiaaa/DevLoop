import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuOptions } from '../src/commands/continue.js';

describe('buildMenuOptions', () => {
  it('shows amend-requirements when tasks are partially done', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 5, inProgress: 0, done: 5 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.ok(amendItem, 'amend-requirements option should be present');
    assert.equal(amendItem.label, 'Amend requirements and tasks (5 pending, 5 done)');
  });

  it('hides amend-requirements when no tasks are done yet', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 10, inProgress: 0, done: 0 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.equal(amendItem, undefined, 'amend-requirements should not be present');
  });

  it('hides amend-requirements when all tasks are done', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: true,
      taskCounts: { total: 10, pending: 0, inProgress: 0, done: 10 },
      allTasksDone: true,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.equal(amendItem, undefined, 'amend-requirements should not be present');
  });

  it('places amend-requirements after continue-run', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 7, inProgress: 0, done: 3 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const actions = items.map(i => i.action);
    const runIdx = actions.indexOf('continue-run');
    const amendIdx = actions.indexOf('amend-requirements');

    assert.ok(runIdx >= 0, 'continue-run should be present');
    assert.ok(amendIdx >= 0, 'amend-requirements should be present');
    assert.equal(amendIdx, runIdx + 1, 'amend-requirements should follow continue-run');
  });

  it('includes in-progress tasks in the done count for the label', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 5, inProgress: 2, done: 3 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.ok(amendItem, 'amend-requirements option should be present');
    assert.equal(amendItem.label, 'Amend requirements and tasks (5 pending, 3 done)');
  });
});
