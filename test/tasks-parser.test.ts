import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasksContent } from '../src/parser/tasks.js';

describe('parseTasksContent — Type field', () => {
  it('parses a valid Type field', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: Build login form.
- **Verification**: npm test -- --grep login
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].type, 'feat');
  });

  it('leaves type undefined when Type field is absent', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Dependencies**: none
- **Description**: Build login form.
- **Verification**: npm test
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].type, undefined);
  });

  it('lowercases the Type value', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Type**: FEAT
- **Dependencies**: none
- **Description**: x
- **Verification**: x
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].type, 'feat');
  });
});

describe('parseTasksContent — Breaking field', () => {
  it('parses a Breaking field as the breakingChange string', () => {
    const content = `### TASK-001: Rewrite API
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: x
- **Verification**: x
- **Breaking**: New /v2 endpoints require auth header.
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].breakingChange, 'New /v2 endpoints require auth header.');
  });

  it('leaves breakingChange undefined when Breaking field is absent', () => {
    const content = `### TASK-001: Add login
- **Status**: pending
- **Type**: feat
- **Dependencies**: none
- **Description**: x
- **Verification**: x
`;
    const result = parseTasksContent(content);
    assert.equal(result.tasks[0].breakingChange, undefined);
  });
});
