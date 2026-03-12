import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isApiError } from '../src/core/claude.js';
import { ClaudeErrorType } from '../src/types/index.js';

describe('isApiError', () => {
  it('returns false for undefined', () => {
    assert.equal(isApiError(undefined), false);
  });

  it('returns false for task_failure', () => {
    assert.equal(isApiError('task_failure'), false);
  });

  it('returns true for rate_limit', () => {
    assert.equal(isApiError('rate_limit'), true);
  });

  it('returns true for api_overload', () => {
    assert.equal(isApiError('api_overload'), true);
  });

  it('returns true for auth_error', () => {
    assert.equal(isApiError('auth_error'), true);
  });

  it('returns true for network_error', () => {
    assert.equal(isApiError('network_error'), true);
  });

  it('returns true for unknown', () => {
    assert.equal(isApiError('unknown'), true);
  });

  it('covers all error types', () => {
    // Ensure we test every ClaudeErrorType value
    const allTypes: ClaudeErrorType[] = [
      'rate_limit', 'api_overload', 'auth_error',
      'network_error', 'task_failure', 'unknown'
    ];
    const apiErrors = allTypes.filter(t => isApiError(t));
    const nonApiErrors = allTypes.filter(t => !isApiError(t));

    assert.deepEqual(nonApiErrors, ['task_failure']);
    assert.equal(apiErrors.length, 5);
  });
});
