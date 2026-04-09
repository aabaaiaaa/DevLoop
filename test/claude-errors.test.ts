import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isApiError, classifyError, parseTokenUsage, formatToolActivity } from '../src/core/claude.js';
import { ClaudeErrorType } from '../src/types/index.js';

describe('classifyError', () => {
  it('detects rate limit from stderr', () => {
    assert.equal(classifyError('rate limit exceeded', null), 'rate_limit');
  });

  it('detects rate limit from 429 status', () => {
    assert.equal(classifyError('Error 429: too many requests', null), 'rate_limit');
  });

  it('detects api usage limit', () => {
    assert.equal(classifyError('', 'api usage limit reached'), 'rate_limit');
  });

  it('detects 400 + limit combo', () => {
    assert.equal(classifyError('400 bad request: limit exceeded', null), 'rate_limit');
  });

  it('detects api overload from 503', () => {
    assert.equal(classifyError('503 service unavailable', null), 'api_overload');
  });

  it('detects api overload from keyword', () => {
    assert.equal(classifyError('API is overloaded', null), 'api_overload');
  });

  it('detects auth error from 401', () => {
    assert.equal(classifyError('401 unauthorized', null), 'auth_error');
  });

  it('detects auth error from keyword', () => {
    assert.equal(classifyError('', 'authentication failed'), 'auth_error');
  });

  it('detects network error from ECONNREFUSED', () => {
    assert.equal(classifyError('ECONNREFUSED', null), 'network_error');
  });

  it('detects network error from timeout', () => {
    assert.equal(classifyError('connection timeout', null), 'network_error');
  });

  it('detects network error from ENOTFOUND', () => {
    assert.equal(classifyError('ENOTFOUND api.anthropic.com', null), 'network_error');
  });

  it('detects unknown from generic api error', () => {
    assert.equal(classifyError('api error: something unexpected', null), 'unknown');
  });

  it('returns task_failure for unrecognized errors', () => {
    assert.equal(classifyError('some other error', null), 'task_failure');
  });

  it('returns task_failure for empty strings', () => {
    assert.equal(classifyError('', null), 'task_failure');
  });

  it('combines stderr and errorMessage for matching', () => {
    assert.equal(classifyError('partial', '401 error'), 'auth_error');
  });
});

describe('parseTokenUsage', () => {
  it('parses valid usage data', () => {
    const result = parseTokenUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
      total_cost_usd: 0.01
    });
    assert.ok(result);
    assert.equal(result!.inputTokens, 100);
    assert.equal(result!.outputTokens, 50);
    assert.equal(result!.cacheCreationTokens, 10);
    assert.equal(result!.cacheReadTokens, 5);
    assert.equal(result!.totalTokens, 165);
    assert.equal(result!.costUsd, 0.01);
  });

  it('returns undefined when no usage field', () => {
    assert.equal(parseTokenUsage({}), undefined);
  });

  it('returns undefined for null input', () => {
    assert.equal(parseTokenUsage(null), undefined);
  });

  it('returns undefined for undefined input', () => {
    assert.equal(parseTokenUsage(undefined), undefined);
  });

  it('defaults missing fields to 0', () => {
    const result = parseTokenUsage({ usage: { input_tokens: 50 } });
    assert.ok(result);
    assert.equal(result!.inputTokens, 50);
    assert.equal(result!.outputTokens, 0);
    assert.equal(result!.cacheCreationTokens, 0);
    assert.equal(result!.cacheReadTokens, 0);
    assert.equal(result!.totalTokens, 50);
    assert.equal(result!.costUsd, 0);
  });
});

describe('formatToolActivity', () => {
  it('formats Read with file path', () => {
    assert.equal(formatToolActivity('Read', { file_path: '/src/index.ts' }), 'Reading /src/index.ts');
  });

  it('formats Write with file path', () => {
    assert.equal(formatToolActivity('Write', { file_path: '/src/out.ts' }), 'Writing /src/out.ts');
  });

  it('formats Edit with file path', () => {
    assert.equal(formatToolActivity('Edit', { file_path: '/src/app.ts' }), 'Editing /src/app.ts');
  });

  it('formats Glob with pattern', () => {
    assert.equal(formatToolActivity('Glob', { pattern: '**/*.ts' }), 'Finding **/*.ts');
  });

  it('formats Grep with pattern', () => {
    assert.equal(formatToolActivity('Grep', { pattern: 'TODO' }), 'Searching: TODO');
  });

  it('formats Bash with first word of command', () => {
    assert.equal(formatToolActivity('Bash', { command: 'npm run test' }), 'Running npm');
  });

  it('formats WebSearch with query', () => {
    assert.equal(formatToolActivity('WebSearch', { query: 'node testing' }), 'Searching: node testing');
  });

  it('formats WebFetch', () => {
    assert.equal(formatToolActivity('WebFetch', { url: 'https://example.com' }), 'Fetching URL');
  });

  it('formats Task tool', () => {
    assert.equal(formatToolActivity('Task', {}), 'Running sub-task');
  });

  it('formats unknown tool', () => {
    assert.equal(formatToolActivity('CustomTool', {}), 'Using CustomTool');
  });

  it('truncates long paths', () => {
    const longPath = '/very/long/path/that/exceeds/forty/characters/file.ts';
    const result = formatToolActivity('Read', { file_path: longPath });
    assert.ok(result.length <= 50);
    assert.ok(result.includes('...'));
  });

  it('handles null input', () => {
    assert.equal(formatToolActivity('Read', null), 'Reading file');
  });

  it('handles empty input', () => {
    assert.equal(formatToolActivity('Bash', {}), 'Running command');
  });

  it('uses path field when file_path is absent', () => {
    assert.equal(formatToolActivity('Glob', { path: '/src' }), 'Finding /src');
  });
});

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
