import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { archiveIteration } from '../src/core/archive.js';
import { createSession, readSession } from '../src/core/session.js';
import { generateWorkspaceClaudeMd } from '../src/commands/init.js';

describe('iteration workflow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-iter-'));
    await fs.mkdir(path.join(tmpDir, '.devloop'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('archive + new session cycle works end-to-end', async () => {
    // Setup iteration 1 files
    await fs.writeFile(path.join(tmpDir, '.devloop', 'requirements.md'), '### TASK-001: First task\n- **Status**: done', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.devloop', 'tasks.md'), '### TASK-001: First task\n- **Status**: done\n- **Verification**: Check it', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.devloop', 'progress.md'), '## Summary\n- **Completed**: 1', 'utf-8');
    await createSession(tmpDir, 'run', 1);

    // Archive iteration 1
    await archiveIteration(tmpDir, 1);

    // Create new session for iteration 2
    await createSession(tmpDir, 'init', 2);

    // Verify archive
    const archivedReq = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'requirements.md'), 'utf-8');
    assert.ok(archivedReq.includes('TASK-001'));

    const archivedTasks = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'tasks.md'), 'utf-8');
    assert.ok(archivedTasks.includes('TASK-001'));

    const archivedProg = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'progress.md'), 'utf-8');
    assert.ok(archivedProg.includes('Completed'));

    // Verify tasks.md deleted
    await assert.rejects(fs.access(path.join(tmpDir, '.devloop', 'tasks.md')));

    // Verify progress.md deleted
    await assert.rejects(fs.access(path.join(tmpDir, '.devloop', 'progress.md')));

    // Verify new session
    const session = await readSession(tmpDir);
    assert.ok(session);
    assert.equal(session!.iteration, 2);
    assert.equal(session!.phase, 'init');
    assert.equal(session!.lastIteration, 0);
  });

  it('archive works even with incomplete tasks', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.devloop', 'requirements.md'),
      '### TASK-001: Done task\n- **Status**: done\n\n### TASK-002: Pending task\n- **Status**: pending',
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, '.devloop', 'progress.md'), 'some progress', 'utf-8');

    // Should succeed without error
    await archiveIteration(tmpDir, 1);

    const archived = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'requirements.md'), 'utf-8');
    assert.ok(archived.includes('TASK-001'));
    assert.ok(archived.includes('TASK-002'));
  });

  it('generateWorkspaceClaudeMd includes prior context when provided', () => {
    const content = generateWorkspaceClaudeMd(tmpDir, {
      iterationNumber: 1,
      requirements: '### TASK-001: Setup\n- **Status**: done',
      tasks: '### TASK-001: Setup\n- **Status**: done\n- **Verification**: Run tests',
      progress: '## Summary\n- **Completed**: 1\n\n## Iteration Log\n...'
    });

    assert.ok(content.includes('Prior Work (Iteration 1)'));
    assert.ok(content.includes('TASK-001: Setup'));
    assert.ok(content.includes('Previous Tasks'));
  });

  it('generateWorkspaceClaudeMd has no prior section when no context', () => {
    const content = generateWorkspaceClaudeMd(tmpDir);

    assert.ok(!content.includes('Prior Work'));
  });
});
