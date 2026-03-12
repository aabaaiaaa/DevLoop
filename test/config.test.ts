import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  getRequirementsPath,
  getProgressPath,
  getSessionPath,
  getFeatureRequirementsPath,
  getFeatureProgressPath,
  getWorkspaceConfigPath,
  validateFeatureName,
  resolveFeaturePath,
  readWorkspaceConfig,
  writeWorkspaceConfig
} from '../src/core/config.js';

// --- Pure path builders ---

describe('path builders', () => {
  const ws = '/home/user/project';

  it('getRequirementsPath returns workspace/requirements.md', () => {
    assert.equal(getRequirementsPath(ws), path.join(ws, 'requirements.md'));
  });

  it('getProgressPath returns workspace/progress.md', () => {
    assert.equal(getProgressPath(ws), path.join(ws, 'progress.md'));
  });

  it('getSessionPath returns workspace/.devloop/session.json', () => {
    assert.equal(getSessionPath(ws), path.join(ws, '.devloop', 'session.json'));
  });

  it('getFeatureRequirementsPath returns workspace/requirements/<feature>.md', () => {
    assert.equal(
      getFeatureRequirementsPath(ws, 'auth'),
      path.join(ws, 'requirements', 'auth.md')
    );
  });

  it('getFeatureProgressPath returns workspace/progress/<feature>.md', () => {
    assert.equal(
      getFeatureProgressPath(ws, 'auth'),
      path.join(ws, 'progress', 'auth.md')
    );
  });

  it('getWorkspaceConfigPath returns workspace/.devloop/config.json', () => {
    assert.equal(
      getWorkspaceConfigPath(ws),
      path.join(ws, '.devloop', 'config.json')
    );
  });
});

// --- validateFeatureName ---

describe('validateFeatureName', () => {
  it('accepts simple alphanumeric names', () => {
    assert.doesNotThrow(() => validateFeatureName('auth'));
    assert.doesNotThrow(() => validateFeatureName('myFeature123'));
  });

  it('accepts names with hyphens', () => {
    assert.doesNotThrow(() => validateFeatureName('my-feature'));
    assert.doesNotThrow(() => validateFeatureName('a-b-c'));
  });

  it('accepts names with underscores', () => {
    assert.doesNotThrow(() => validateFeatureName('my_feature'));
    assert.doesNotThrow(() => validateFeatureName('a_b_c'));
  });

  it('accepts mixed hyphens and underscores', () => {
    assert.doesNotThrow(() => validateFeatureName('my-feature_v2'));
  });

  it('rejects names with spaces', () => {
    assert.throws(() => validateFeatureName('my feature'), /Invalid feature name/);
  });

  it('rejects names with dots', () => {
    assert.throws(() => validateFeatureName('my.feature'), /Invalid feature name/);
  });

  it('rejects names with special characters', () => {
    assert.throws(() => validateFeatureName('my@feature'), /Invalid feature name/);
    assert.throws(() => validateFeatureName('feat!'), /Invalid feature name/);
    assert.throws(() => validateFeatureName('feat$1'), /Invalid feature name/);
  });

  it('rejects empty string', () => {
    assert.throws(() => validateFeatureName(''), /Invalid feature name/);
  });

  it('rejects path traversal with ..', () => {
    // Note: ".." contains dots which fail the alphanumeric regex first
    assert.throws(() => validateFeatureName('..'), /Invalid feature name/);
  });

  it('rejects names with slashes', () => {
    assert.throws(() => validateFeatureName('a/b'), /Invalid feature name/);
  });
});

// --- resolveFeaturePath ---

describe('resolveFeaturePath', () => {
  const ws = '/home/user/project';

  it('resolves short-form feature name', () => {
    const result = resolveFeaturePath(ws, 'auth');
    assert.equal(result.featureName, 'auth');
    assert.equal(result.requirementsPath, path.join(ws, 'requirements', 'auth.md'));
    assert.equal(result.progressPath, path.join(ws, 'progress', 'auth.md'));
  });

  it('strips .md extension from short form', () => {
    const result = resolveFeaturePath(ws, 'auth.md');
    assert.equal(result.featureName, 'auth');
  });

  it('resolves explicit path format', () => {
    const result = resolveFeaturePath(ws, 'requirements/auth.md');
    assert.equal(result.featureName, 'auth');
    assert.equal(result.requirementsPath, path.join(ws, 'requirements', 'auth.md'));
  });

  it('resolves explicit path with backslashes', () => {
    const result = resolveFeaturePath(ws, 'requirements\\auth.md');
    assert.equal(result.featureName, 'auth');
  });

  it('rejects invalid explicit path format', () => {
    assert.throws(
      () => resolveFeaturePath(ws, 'some/random/path.md'),
      /Invalid feature path/
    );
  });

  it('rejects explicit path without .md extension', () => {
    assert.throws(
      () => resolveFeaturePath(ws, 'requirements/auth'),
      /Invalid feature path/
    );
  });

  it('validates feature name from explicit path', () => {
    assert.throws(
      () => resolveFeaturePath(ws, 'requirements/my feature.md'),
      /Invalid feature name/
    );
  });

  it('validates feature name from short form', () => {
    assert.throws(
      () => resolveFeaturePath(ws, 'my feature'),
      /Invalid feature name/
    );
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
