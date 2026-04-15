import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkspaceClaudeMd } from '../src/commands/init.js';

describe('generateWorkspaceClaudeMd TodoWrite instructions', () => {
  it('includes TodoWrite instructions for init session', () => {
    const content = generateWorkspaceClaudeMd('/test/workspace');
    assert.ok(content.includes('TodoWrite'), 'should mention TodoWrite tool');
  });

  it('includes the init session steps', () => {
    const content = generateWorkspaceClaudeMd('/test/workspace');
    assert.ok(content.includes('Explore project scope'));
    assert.ok(content.includes('gaps and inconsistencies'));
    assert.ok(content.includes('Write requirements.md'));
    assert.ok(content.includes('Generate tasks.md'));
    assert.ok(content.includes('exit session') || content.includes('exit'));
  });

  it('still includes TodoWrite instructions with prior context', () => {
    const content = generateWorkspaceClaudeMd('/test/workspace', {
      iterationNumber: 1,
      requirements: 'some requirements',
      tasks: '### TASK-001: First task',
      progress: 'some progress',
    });
    assert.ok(content.includes('TodoWrite'), 'should mention TodoWrite tool even with prior context');
  });
});
