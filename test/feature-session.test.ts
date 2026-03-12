import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  readFeatureSession,
  writeFeatureSession,
  createFeatureSession,
  updateFeatureSessionIteration,
  listFeatures
} from '../src/core/feature-session.js';

describe('feature-session', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-feat-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('readFeatureSession', () => {
    it('returns null when no session exists', async () => {
      const session = await readFeatureSession(tmpDir, 'auth');
      assert.equal(session, null);
    });

    it('reads existing feature session', async () => {
      const sessionDir = path.join(tmpDir, '.devloop', 'features');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionDir, 'auth.json'),
        JSON.stringify({
          feature: 'auth',
          phase: 'run',
          sessionId: null,
          lastIteration: 2,
          startedAt: '2025-01-01',
          requirementsPath: '/ws/requirements/auth.md',
          progressPath: '/ws/progress/auth.md'
        }),
        'utf-8'
      );

      const session = await readFeatureSession(tmpDir, 'auth');
      assert.ok(session);
      assert.equal(session!.feature, 'auth');
      assert.equal(session!.phase, 'run');
      assert.equal(session!.lastIteration, 2);
    });
  });

  describe('createFeatureSession', () => {
    it('creates and persists a feature session', async () => {
      const session = await createFeatureSession(tmpDir, 'auth', 'init');
      assert.equal(session.feature, 'auth');
      assert.equal(session.phase, 'init');
      assert.equal(session.lastIteration, 0);
      assert.ok(session.requirementsPath.includes('auth.md'));
      assert.ok(session.progressPath.includes('auth.md'));

      // Verify persisted
      const read = await readFeatureSession(tmpDir, 'auth');
      assert.ok(read);
      assert.equal(read!.feature, 'auth');
    });

    it('creates sessions for different features independently', async () => {
      await createFeatureSession(tmpDir, 'auth', 'run');
      await createFeatureSession(tmpDir, 'payments', 'init');

      const auth = await readFeatureSession(tmpDir, 'auth');
      const payments = await readFeatureSession(tmpDir, 'payments');

      assert.equal(auth!.feature, 'auth');
      assert.equal(auth!.phase, 'run');
      assert.equal(payments!.feature, 'payments');
      assert.equal(payments!.phase, 'init');
    });
  });

  describe('updateFeatureSessionIteration', () => {
    it('updates iteration count', async () => {
      await createFeatureSession(tmpDir, 'auth', 'run');
      await updateFeatureSessionIteration(tmpDir, 'auth', 5);

      const session = await readFeatureSession(tmpDir, 'auth');
      assert.equal(session!.lastIteration, 5);
    });

    it('throws if feature session does not exist', async () => {
      await assert.rejects(
        () => updateFeatureSessionIteration(tmpDir, 'nonexistent', 1),
        /Feature session not found/
      );
    });
  });

  describe('listFeatures', () => {
    it('returns empty array when requirements dir does not exist', async () => {
      const features = await listFeatures(tmpDir);
      assert.deepEqual(features, []);
    });

    it('returns feature names from .md files', async () => {
      const reqDir = path.join(tmpDir, 'requirements');
      await fs.mkdir(reqDir, { recursive: true });
      await fs.writeFile(path.join(reqDir, 'auth.md'), '# Auth', 'utf-8');
      await fs.writeFile(path.join(reqDir, 'payments.md'), '# Payments', 'utf-8');
      await fs.writeFile(path.join(reqDir, 'README.txt'), 'not a feature', 'utf-8');

      const features = await listFeatures(tmpDir);
      assert.deepEqual(features, ['auth', 'payments']);
    });

    it('returns sorted list', async () => {
      const reqDir = path.join(tmpDir, 'requirements');
      await fs.mkdir(reqDir, { recursive: true });
      await fs.writeFile(path.join(reqDir, 'zebra.md'), '', 'utf-8');
      await fs.writeFile(path.join(reqDir, 'alpha.md'), '', 'utf-8');
      await fs.writeFile(path.join(reqDir, 'mid.md'), '', 'utf-8');

      const features = await listFeatures(tmpDir);
      assert.deepEqual(features, ['alpha', 'mid', 'zebra']);
    });

    it('returns empty array when directory has no .md files', async () => {
      const reqDir = path.join(tmpDir, 'requirements');
      await fs.mkdir(reqDir, { recursive: true });
      await fs.writeFile(path.join(reqDir, 'notes.txt'), '', 'utf-8');

      const features = await listFeatures(tmpDir);
      assert.deepEqual(features, []);
    });
  });
});
