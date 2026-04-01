import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  getRequirementsPath,
  getProgressPath,
  readWorkspaceConfig,
  writeWorkspaceConfig
} from '../src/core/config.js';

// --- Pure path builders ---

describe('path builders', () => {
  const ws = '/home/user/project';

  it('getRequirementsPath returns workspace/.devloop/requirements.md', () => {
    assert.equal(getRequirementsPath(ws), path.join(ws, '.devloop', 'requirements.md'));
  });

  it('getProgressPath returns workspace/.devloop/progress.md', () => {
    assert.equal(getProgressPath(ws), path.join(ws, '.devloop', 'progress.md'));
  });
});

// --- readWorkspaceConfig / writeWorkspaceConfig ---

describe('workspace config I/O', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-config-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no config exists', async () => {
    const config = await readWorkspaceConfig(tmpDir);
    assert.deepEqual(config, {});
  });

  it('writes and reads config', async () => {
    await writeWorkspaceConfig(tmpDir, { devloopCommitFormat: 'chore: {action}' });
    const config = await readWorkspaceConfig(tmpDir);
    assert.equal(config.devloopCommitFormat, 'chore: {action}');
  });

  it('creates .devloop directory if missing', async () => {
    await writeWorkspaceConfig(tmpDir, { devloopCommitFormat: 'test' });
    const configPath = path.join(tmpDir, '.devloop', 'config.json');
    const exists = await fs.access(configPath).then(() => true).catch(() => false);
    assert.ok(exists);
  });

  it('overwrites existing config', async () => {
    await writeWorkspaceConfig(tmpDir, { devloopCommitFormat: 'first' });
    await writeWorkspaceConfig(tmpDir, { devloopCommitFormat: 'second' });
    const config = await readWorkspaceConfig(tmpDir);
    assert.equal(config.devloopCommitFormat, 'second');
  });
});
