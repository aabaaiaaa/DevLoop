import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../src/core/logger.js';

describe('logger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devloop-logger-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates .devloop directory and debug.log file', () => {
    const logger = createLogger(tmpDir);
    logger.info('test message');

    const logPath = path.join(tmpDir, '.devloop', 'debug.log');
    assert.ok(fsSync.existsSync(logPath));
  });

  it('writes INFO messages with timestamp', () => {
    const logger = createLogger(tmpDir);
    logger.info('hello world');

    const logPath = path.join(tmpDir, '.devloop', 'debug.log');
    const content = fsSync.readFileSync(logPath, 'utf-8');
    assert.match(content, /\[\d{4}-\d{2}-\d{2}T.*\] \[INFO\] hello world/);
  });

  it('writes ERROR messages with timestamp', () => {
    const logger = createLogger(tmpDir);
    logger.error('something failed');

    const logPath = path.join(tmpDir, '.devloop', 'debug.log');
    const content = fsSync.readFileSync(logPath, 'utf-8');
    assert.match(content, /\[ERROR\] something failed/);
  });

  it('includes stack trace for Error objects', () => {
    const logger = createLogger(tmpDir);
    const err = new Error('test error');
    logger.error('caught exception', err);

    const logPath = path.join(tmpDir, '.devloop', 'debug.log');
    const content = fsSync.readFileSync(logPath, 'utf-8');
    assert.match(content, /\[ERROR\] caught exception/);
    assert.match(content, /\[ERROR\] Error: test error/);
    assert.match(content, /at /); // Stack trace lines
  });

  it('handles non-Error objects in error()', () => {
    const logger = createLogger(tmpDir);
    logger.error('bad thing', 'string error');

    const logPath = path.join(tmpDir, '.devloop', 'debug.log');
    const content = fsSync.readFileSync(logPath, 'utf-8');
    assert.match(content, /\[ERROR\] bad thing/);
    assert.match(content, /\[ERROR\] string error/);
  });

  it('appends multiple messages', () => {
    const logger = createLogger(tmpDir);
    logger.info('first');
    logger.info('second');
    logger.error('third');

    const logPath = path.join(tmpDir, '.devloop', 'debug.log');
    const content = fsSync.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.ok(lines.length >= 3);
    assert.match(lines[0], /first/);
    assert.match(lines[1], /second/);
    assert.match(lines[2], /third/);
  });

  it('does not throw when workspace is invalid', () => {
    const logger = createLogger('/nonexistent/path/that/should/not/exist');
    // Should not throw
    logger.info('test');
    logger.error('test', new Error('test'));
  });

  it('works when .devloop directory already exists', async () => {
    await fs.mkdir(path.join(tmpDir, '.devloop'), { recursive: true });

    const logger = createLogger(tmpDir);
    logger.info('test');

    const logPath = path.join(tmpDir, '.devloop', 'debug.log');
    const content = fsSync.readFileSync(logPath, 'utf-8');
    assert.match(content, /test/);
  });
});
