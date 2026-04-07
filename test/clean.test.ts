import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { cleanWorkspace } from '../src/commands/continue.js';

describe('cleanWorkspace', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-clean-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createDevloopFiles(dir: string): Promise<void> {
    const devloopDir = path.join(dir, '.devloop');
    const claudeDir = path.join(dir, '.claude');
    await fs.mkdir(devloopDir, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(devloopDir, 'requirements.md'), 'req', 'utf-8');
    await fs.writeFile(path.join(devloopDir, 'tasks.md'), 'tasks', 'utf-8');
    await fs.writeFile(path.join(devloopDir, 'session.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(claudeDir, 'CLAUDE.md'), 'claude', 'utf-8');
    await fs.writeFile(path.join(claudeDir, 'settings.json'), '{}', 'utf-8');
  }

  async function dirExists(dirPath: string): Promise<boolean> {
    try { await fs.access(dirPath); return true; } catch { return false; }
  }

  const confirmYes = async () => true;
  const confirmNo = async () => false;

  it('removes .devloop/ and .claude/ when confirmed', async () => {
    await createDevloopFiles(tmpDir);

    const result = await cleanWorkspace(tmpDir, confirmYes);

    assert.equal(result, true);
    assert.equal(await dirExists(path.join(tmpDir, '.devloop')), false);
    assert.equal(await dirExists(path.join(tmpDir, '.claude')), false);
  });

  it('does nothing when user declines confirmation', async () => {
    await createDevloopFiles(tmpDir);

    const result = await cleanWorkspace(tmpDir, confirmNo);

    assert.equal(result, false);
    assert.equal(await dirExists(path.join(tmpDir, '.devloop')), true);
    assert.equal(await dirExists(path.join(tmpDir, '.claude')), true);
  });

  it('returns false when no DevLoop files exist', async () => {
    const result = await cleanWorkspace(tmpDir, confirmYes);
    assert.equal(result, false);
  });

  it('removes .devloop/ when only .devloop/ exists', async () => {
    const devloopDir = path.join(tmpDir, '.devloop');
    await fs.mkdir(devloopDir, { recursive: true });
    await fs.writeFile(path.join(devloopDir, 'tasks.md'), 'tasks', 'utf-8');

    const result = await cleanWorkspace(tmpDir, confirmYes);

    assert.equal(result, true);
    assert.equal(await dirExists(devloopDir), false);
  });

  it('removes .claude/ when only .claude/ exists', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, 'CLAUDE.md'), 'claude', 'utf-8');

    const result = await cleanWorkspace(tmpDir, confirmYes);

    assert.equal(result, true);
    assert.equal(await dirExists(claudeDir), false);
  });

  it('removes archived iterations', async () => {
    await createDevloopFiles(tmpDir);
    const archiveDir = path.join(tmpDir, '.devloop', 'archive');
    await fs.mkdir(path.join(archiveDir, 'iteration-1'), { recursive: true });
    await fs.mkdir(path.join(archiveDir, 'iteration-2'), { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'iteration-1', 'requirements.md'), 'req1', 'utf-8');
    await fs.writeFile(path.join(archiveDir, 'iteration-2', 'requirements.md'), 'req2', 'utf-8');

    const result = await cleanWorkspace(tmpDir, confirmYes);

    assert.equal(result, true);
    assert.equal(await dirExists(path.join(tmpDir, '.devloop')), false);
  });

  it('removes task logs', async () => {
    await createDevloopFiles(tmpDir);
    const logsDir = path.join(tmpDir, '.devloop', 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, 'TASK-001.log'), 'log1', 'utf-8');
    await fs.writeFile(path.join(logsDir, 'TASK-002.log'), 'log2', 'utf-8');

    const result = await cleanWorkspace(tmpDir, confirmYes);

    assert.equal(result, true);
    assert.equal(await dirExists(path.join(tmpDir, '.devloop')), false);
  });
});
