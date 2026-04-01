import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  readSession,
  writeSession,
  createSession,
  updateSessionPhase,
  updateSessionIteration
} from '../src/core/session.js';

describe('session', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-session-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('readSession', () => {
    it('returns null when no session exists', async () => {
      const session = await readSession(tmpDir);
      assert.equal(session, null);
    });

    it('reads existing session', async () => {
      const sessionDir = path.join(tmpDir, '.devloop');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionDir, 'session.json'),
        JSON.stringify({ phase: 'run', sessionId: 'abc', lastIteration: 5, startedAt: '2025-01-01' }),
        'utf-8'
      );
      const session = await readSession(tmpDir);
      assert.ok(session);
      assert.equal(session!.phase, 'run');
      assert.equal(session!.sessionId, 'abc');
      assert.equal(session!.lastIteration, 5);
    });
  });

  describe('writeSession', () => {
    it('creates .devloop directory and writes session', async () => {
      const session = { phase: 'init' as const, sessionId: null, lastIteration: 0, startedAt: '2025-01-01', iteration: 1 };
      await writeSession(tmpDir, session);

      const read = await readSession(tmpDir);
      assert.ok(read);
      assert.equal(read!.phase, 'init');
      assert.equal(read!.lastIteration, 0);
    });

    it('overwrites existing session', async () => {
      const s1 = { phase: 'init' as const, sessionId: null, lastIteration: 0, startedAt: '2025-01-01', iteration: 1 };
      const s2 = { phase: 'run' as const, sessionId: 'xyz', lastIteration: 3, startedAt: '2025-01-01', iteration: 1 };
      await writeSession(tmpDir, s1);
      await writeSession(tmpDir, s2);

      const read = await readSession(tmpDir);
      assert.ok(read);
      assert.equal(read!.phase, 'run');
      assert.equal(read!.lastIteration, 3);
    });
  });

  describe('createSession', () => {
    it('creates session with init phase', async () => {
      const session = await createSession(tmpDir, 'init');
      assert.equal(session.phase, 'init');
      assert.equal(session.sessionId, null);
      assert.equal(session.lastIteration, 0);
      assert.ok(session.startedAt);

      // Verify it was persisted
      const read = await readSession(tmpDir);
      assert.ok(read);
      assert.equal(read!.phase, 'init');
    });

    it('creates session with run phase', async () => {
      const session = await createSession(tmpDir, 'run');
      assert.equal(session.phase, 'run');
    });
  });

  describe('updateSessionPhase', () => {
    it('updates phase of existing session', async () => {
      await createSession(tmpDir, 'init');
      await updateSessionPhase(tmpDir, 'run');

      const read = await readSession(tmpDir);
      assert.ok(read);
      assert.equal(read!.phase, 'run');
    });

    it('does nothing if no session exists', async () => {
      // Should not throw
      await updateSessionPhase(tmpDir, 'run');
      const read = await readSession(tmpDir);
      assert.equal(read, null);
    });
  });

  describe('updateSessionIteration', () => {
    it('updates iteration count', async () => {
      await createSession(tmpDir, 'run');
      await updateSessionIteration(tmpDir, 5);

      const read = await readSession(tmpDir);
      assert.ok(read);
      assert.equal(read!.lastIteration, 5);
    });

    it('does nothing if no session exists', async () => {
      await updateSessionIteration(tmpDir, 3);
      const read = await readSession(tmpDir);
      assert.equal(read, null);
    });

    it('updates incrementally', async () => {
      await createSession(tmpDir, 'run');
      await updateSessionIteration(tmpDir, 1);
      await updateSessionIteration(tmpDir, 2);
      await updateSessionIteration(tmpDir, 3);

      const read = await readSession(tmpDir);
      assert.equal(read!.lastIteration, 3);
    });
  });

  describe('iteration field', () => {
    it('readSession defaults iteration to 1 for old sessions without field', async () => {
      const sessionDir = path.join(tmpDir, '.devloop');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionDir, 'session.json'),
        JSON.stringify({ phase: 'run', sessionId: null, lastIteration: 5, startedAt: '2025-01-01' }),
        'utf-8'
      );
      const session = await readSession(tmpDir);
      assert.ok(session);
      assert.equal(session!.iteration, 1);
    });

    it('createSession defaults iteration to 1', async () => {
      const session = await createSession(tmpDir, 'init');
      assert.equal(session.iteration, 1);

      const read = await readSession(tmpDir);
      assert.equal(read!.iteration, 1);
    });

    it('createSession accepts custom iteration', async () => {
      const session = await createSession(tmpDir, 'init', 3);
      assert.equal(session.iteration, 3);

      const read = await readSession(tmpDir);
      assert.equal(read!.iteration, 3);
    });

    it('preserves iteration across phase updates', async () => {
      await createSession(tmpDir, 'init', 2);
      await updateSessionPhase(tmpDir, 'run');

      const read = await readSession(tmpDir);
      assert.equal(read!.phase, 'run');
      assert.equal(read!.iteration, 2);
    });
  });

  describe('devloopVersion field', () => {
    it('createSession records devloopVersion', async () => {
      const session = await createSession(tmpDir, 'init');
      assert.ok(session.devloopVersion);
      assert.equal(typeof session.devloopVersion, 'string');

      const read = await readSession(tmpDir);
      assert.equal(read!.devloopVersion, session.devloopVersion);
    });

    it('readSession returns undefined for old sessions without devloopVersion', async () => {
      const sessionDir = path.join(tmpDir, '.devloop');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionDir, 'session.json'),
        JSON.stringify({ phase: 'run', sessionId: null, lastIteration: 0, startedAt: '2025-01-01', iteration: 1 }),
        'utf-8'
      );
      const session = await readSession(tmpDir);
      assert.ok(session);
      assert.equal(session!.devloopVersion, undefined);
    });
  });
});
