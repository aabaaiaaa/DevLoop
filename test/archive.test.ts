import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { archiveIteration, getArchivedIterations, loadPriorContext } from '../src/core/archive.js';

describe('archiveIteration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-archive-'));
    await fs.mkdir(path.join(tmpDir, '.devloop'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('copies requirements.md, tasks.md, and progress.md to archive dir', async () => {
    await fs.writeFile(path.join(tmpDir, '.devloop', 'requirements.md'), 'req content', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.devloop', 'tasks.md'), 'tasks content', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.devloop', 'progress.md'), 'prog content', 'utf-8');

    await archiveIteration(tmpDir, 1);

    const archivedReq = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'requirements.md'), 'utf-8');
    const archivedTasks = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'tasks.md'), 'utf-8');
    const archivedProg = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'progress.md'), 'utf-8');
    assert.equal(archivedReq, 'req content');
    assert.equal(archivedTasks, 'tasks content');
    assert.equal(archivedProg, 'prog content');
  });

  it('deletes requirements.md, tasks.md, and progress.md after archiving', async () => {
    await fs.writeFile(path.join(tmpDir, '.devloop', 'requirements.md'), 'req', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.devloop', 'tasks.md'), 'tasks', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.devloop', 'progress.md'), 'prog', 'utf-8');

    await archiveIteration(tmpDir, 1);

    await assert.rejects(
      fs.access(path.join(tmpDir, '.devloop', 'requirements.md')),
      'requirements.md should be deleted'
    );
    await assert.rejects(
      fs.access(path.join(tmpDir, '.devloop', 'tasks.md')),
      'tasks.md should be deleted'
    );
    await assert.rejects(
      fs.access(path.join(tmpDir, '.devloop', 'progress.md')),
      'progress.md should be deleted'
    );
  });

  it('handles missing progress.md gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, '.devloop', 'requirements.md'), 'req only', 'utf-8');

    // Should not throw
    await archiveIteration(tmpDir, 1);

    const archivedReq = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'requirements.md'), 'utf-8');
    assert.equal(archivedReq, 'req only');
  });

  it('handles missing tasks.md gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, '.devloop', 'requirements.md'), 'req', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.devloop', 'progress.md'), 'prog', 'utf-8');

    // Should not throw even without tasks.md
    await archiveIteration(tmpDir, 1);

    const archivedReq = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'requirements.md'), 'utf-8');
    assert.equal(archivedReq, 'req');
    const archivedProg = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'progress.md'), 'utf-8');
    assert.equal(archivedProg, 'prog');
  });

  it('handles missing requirements.md gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, '.devloop', 'progress.md'), 'prog only', 'utf-8');

    // Should not throw
    await archiveIteration(tmpDir, 1);

    const archivedProg = await fs.readFile(path.join(tmpDir, '.devloop', 'archive', 'iteration-1', 'progress.md'), 'utf-8');
    assert.equal(archivedProg, 'prog only');
  });
});

describe('getArchivedIterations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-archive-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no archive exists', async () => {
    const result = await getArchivedIterations(tmpDir);
    assert.deepEqual(result, []);
  });

  it('returns sorted iteration numbers', async () => {
    const archiveBase = path.join(tmpDir, '.devloop', 'archive');
    await fs.mkdir(path.join(archiveBase, 'iteration-3'), { recursive: true });
    await fs.mkdir(path.join(archiveBase, 'iteration-1'), { recursive: true });
    await fs.mkdir(path.join(archiveBase, 'iteration-2'), { recursive: true });

    const result = await getArchivedIterations(tmpDir);
    assert.deepEqual(result, [1, 2, 3]);
  });

  it('ignores non-iteration directories', async () => {
    const archiveBase = path.join(tmpDir, '.devloop', 'archive');
    await fs.mkdir(path.join(archiveBase, 'iteration-1'), { recursive: true });
    await fs.mkdir(path.join(archiveBase, 'other-stuff'), { recursive: true });

    const result = await getArchivedIterations(tmpDir);
    assert.deepEqual(result, [1]);
  });
});

describe('loadPriorContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-archive-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads requirements, tasks, and progress from archive', async () => {
    const archiveDir = path.join(tmpDir, '.devloop', 'archive', 'iteration-1');
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'requirements.md'), 'req data', 'utf-8');
    await fs.writeFile(path.join(archiveDir, 'tasks.md'), 'tasks data', 'utf-8');
    await fs.writeFile(path.join(archiveDir, 'progress.md'), 'prog data', 'utf-8');

    const result = await loadPriorContext(tmpDir, 1);
    assert.equal(result.requirements, 'req data');
    assert.equal(result.tasks, 'tasks data');
    assert.equal(result.progress, 'prog data');
  });

  it('returns null for missing files', async () => {
    const archiveDir = path.join(tmpDir, '.devloop', 'archive', 'iteration-1');
    await fs.mkdir(archiveDir, { recursive: true });

    const result = await loadPriorContext(tmpDir, 1);
    assert.equal(result.requirements, null);
    assert.equal(result.tasks, null);
    assert.equal(result.progress, null);
  });

  it('returns null for non-existent iteration', async () => {
    const result = await loadPriorContext(tmpDir, 99);
    assert.equal(result.requirements, null);
    assert.equal(result.tasks, null);
    assert.equal(result.progress, null);
  });
});
