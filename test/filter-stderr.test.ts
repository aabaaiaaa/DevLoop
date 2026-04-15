import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterStderrNoise } from '../src/core/claude.js';

describe('filterStderrNoise', () => {
  it('removes sandbox disabled warning line', () => {
    const input = '⚠ Sandbox disabled: sandbox.enabled is set but windows is not supported (requires macOS, Linux, or WSL2)';
    const result = filterStderrNoise(input);
    assert.equal(result.trim(), '');
  });

  it('removes "Commands will run WITHOUT sandboxing" line', () => {
    const input = '  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.';
    const result = filterStderrNoise(input);
    assert.equal(result.trim(), '');
  });

  it('removes both sandbox warning lines together', () => {
    const input = [
      '⚠ Sandbox disabled: sandbox.enabled is set but windows is not supported (requires macOS, Linux, or WSL2)',
      '  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.',
    ].join('\n');
    const result = filterStderrNoise(input);
    assert.equal(result.trim(), '');
  });

  it('preserves non-matching lines', () => {
    const input = 'Error: something went wrong';
    const result = filterStderrNoise(input);
    assert.equal(result, 'Error: something went wrong');
  });

  it('preserves real errors mixed with sandbox warnings', () => {
    const input = [
      '⚠ Sandbox disabled: sandbox.enabled is set but windows is not supported (requires macOS, Linux, or WSL2)',
      '  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.',
      'Error: API rate limit exceeded',
    ].join('\n');
    const result = filterStderrNoise(input);
    assert.ok(result.includes('Error: API rate limit exceeded'));
    assert.ok(!result.includes('Sandbox disabled'));
    assert.ok(!result.includes('WITHOUT sandboxing'));
  });

  it('handles empty input', () => {
    const result = filterStderrNoise('');
    assert.equal(result, '');
  });
});
