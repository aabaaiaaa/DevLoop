import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateAmendClaudeMd } from '../src/commands/init.js';

describe('generateAmendClaudeMd', () => {
  const workspace = '/test/workspace';
  const taskCounts = { total: 12, pending: 7, inProgress: 1, done: 4 };

  it('includes workspace path', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes(workspace));
  });

  it('includes task status summary', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('4 done'));
    assert.ok(content.includes('1 in-progress'));
    assert.ok(content.includes('7 pending'));
  });

  it('states rules about not modifying done/in-progress tasks', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('done'));
    assert.ok(content.includes('in-progress'));
    assert.ok(content.toLowerCase().includes('do not modify') || content.toLowerCase().includes('must not'));
  });

  it('allows modifying pending tasks', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('pending'));
    assert.ok(content.toLowerCase().includes('add') || content.toLowerCase().includes('modify') || content.toLowerCase().includes('remove'));
  });

  it('includes TodoWrite instructions', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('TodoWrite'));
  });

  it('includes the task format reference', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('TASK-'));
    assert.ok(content.includes('Status'));
    assert.ok(content.includes('Dependencies'));
    assert.ok(content.includes('Description'));
    assert.ok(content.includes('Verification'));
  });

  it('instructs user to exit when done', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('exit') || content.includes('Ctrl+C'));
  });
});
