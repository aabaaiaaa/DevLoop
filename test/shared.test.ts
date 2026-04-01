import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { buildRunConfig, RunConfigOptions } from '../src/commands/shared.js';

describe('buildRunConfig', () => {
  const baseOptions: RunConfigOptions = {
    workspace: '/home/user/project'
  };

  it('returns defaults for minimal options', () => {
    const config = buildRunConfig(baseOptions);
    assert.equal(config.maxIterations, 100);
    assert.equal(config.workspacePath, '/home/user/project');
    assert.equal(config.requirementsPath, path.join('/home/user/project', '.devloop', 'requirements.md'));
    assert.equal(config.progressPath, path.join('/home/user/project', '.devloop', 'progress.md'));
    assert.equal(config.verbose, false);
    assert.equal(config.dryRun, false);
    assert.equal(config.tokenLimit, undefined);
    assert.equal(config.costLimit, 10);
    assert.equal(config.sessionAction, undefined);
  });

  it('parses maxIterations from string', () => {
    const config = buildRunConfig({ ...baseOptions, maxIterations: '25' });
    assert.equal(config.maxIterations, 25);
  });

  it('parses tokenLimit from string', () => {
    const config = buildRunConfig({ ...baseOptions, tokenLimit: '50000' });
    assert.equal(config.tokenLimit, 50000);
  });

  it('parses costLimit from string', () => {
    const config = buildRunConfig({ ...baseOptions, costLimit: '1.50' });
    assert.equal(config.costLimit, 1.50);
  });

  it('passes through boolean flags', () => {
    const config = buildRunConfig({ ...baseOptions, verbose: true, dryRun: true });
    assert.equal(config.verbose, true);
    assert.equal(config.dryRun, true);
  });

  it('uses custom requirements and progress paths', () => {
    const config = buildRunConfig({
      ...baseOptions,
      requirementsPath: '/custom/req.md',
      progressPath: '/custom/prog.md'
    });
    assert.equal(config.requirementsPath, '/custom/req.md');
    assert.equal(config.progressPath, '/custom/prog.md');
  });

  it('passes through sessionAction', () => {
    const config = buildRunConfig({ ...baseOptions, sessionAction: 'create' });
    assert.equal(config.sessionAction, 'create');
  });

  it('handles NaN maxIterations gracefully', () => {
    const config = buildRunConfig({ ...baseOptions, maxIterations: 'abc' });
    assert.ok(Number.isNaN(config.maxIterations));
  });

  it('clamps maxIterations to ceiling of 1000', () => {
    const config = buildRunConfig({ ...baseOptions, maxIterations: '5000' });
    assert.equal(config.maxIterations, 1000);
  });

  it('clamps costLimit to ceiling of 500', () => {
    const config = buildRunConfig({ ...baseOptions, costLimit: '999' });
    assert.equal(config.costLimit, 500);
  });
});
