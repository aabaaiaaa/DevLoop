# Mid-Run Requirements Amendment & Session Todos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `devloop continue` menu option for amending requirements/tasks mid-run, and add TodoWrite progress roadmaps to all interactive Claude sessions.

**Architecture:** Two changes to the interactive session layer. (1) New menu item + handler in `continue.ts` that spawns Claude with an amendment-specific CLAUDE.md. (2) TodoWrite instructions injected into all three CLAUDE.md generators (init, continue-requirements, amend). No changes to the run loop, parser, or core abstractions.

**Tech Stack:** TypeScript, Node.js built-in test runner, chalk

**Spec:** `docs/superpowers/specs/2026-04-15-amend-requirements-and-session-todos-design.md`

---

### Task 1: Export `buildMenuOptions` and add `amend-requirements` menu item

**Files:**
- Modify: `src/commands/continue.ts:94-122` (the `buildMenuOptions` function)

- [ ] **Step 1: Write the failing test for amend-requirements menu visibility**

Create `test/menu.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuOptions } from '../src/commands/continue.js';

describe('buildMenuOptions', () => {
  it('shows amend-requirements when tasks are partially done', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 5, inProgress: 0, done: 5 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.ok(amendItem, 'amend-requirements option should be present');
    assert.equal(amendItem.label, 'Amend requirements and tasks (5 pending, 5 done)');
  });

  it('hides amend-requirements when no tasks are done yet', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 10, inProgress: 0, done: 0 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.equal(amendItem, undefined, 'amend-requirements should not be present');
  });

  it('hides amend-requirements when all tasks are done', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: true,
      taskCounts: { total: 10, pending: 0, inProgress: 0, done: 10 },
      allTasksDone: true,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.equal(amendItem, undefined, 'amend-requirements should not be present');
  });

  it('places amend-requirements after continue-run', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 7, inProgress: 0, done: 3 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const actions = items.map(i => i.action);
    const runIdx = actions.indexOf('continue-run');
    const amendIdx = actions.indexOf('amend-requirements');

    assert.ok(runIdx >= 0, 'continue-run should be present');
    assert.ok(amendIdx >= 0, 'amend-requirements should be present');
    assert.equal(amendIdx, runIdx + 1, 'amend-requirements should follow continue-run');
  });

  it('includes in-progress tasks in the done count for the label', () => {
    const state = {
      phase: 'run' as const,
      hasRequirements: true,
      hasTasks: true,
      hasReview: false,
      taskCounts: { total: 10, pending: 5, inProgress: 2, done: 3 },
      allTasksDone: false,
    };

    const items = buildMenuOptions(state);
    const amendItem = items.find(i => i.action === 'amend-requirements');

    assert.ok(amendItem, 'amend-requirements option should be present');
    assert.equal(amendItem.label, 'Amend requirements and tasks (5 pending, 3 done)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/menu.test.ts`
Expected: FAIL — `buildMenuOptions` is not exported, and amend-requirements action doesn't exist.

- [ ] **Step 3: Export `buildMenuOptions` and add amend-requirements item**

In `src/commands/continue.ts`, add `export` to the function and add the new menu item:

Change:
```typescript
function buildMenuOptions(state: WorkspaceState): MenuItem[] {
```
to:
```typescript
export function buildMenuOptions(state: WorkspaceState): MenuItem[] {
```

Also export the `WorkspaceState` interface by changing:
```typescript
interface WorkspaceState {
```
to:
```typescript
export interface WorkspaceState {
```

Then in the `else` block (not all done), add the amend item after `continue-run`:

```typescript
  } else {
    // Not all done — show work-continuation options
    if (state.phase === 'init' || !state.hasTasks) {
      items.push({ key: String(key++), label: 'Continue working on requirements', action: 'continue-requirements' });
    }
    if (state.hasTasks && !state.allTasksDone) {
      const { done, total } = state.taskCounts;
      items.push({ key: String(key++), label: `Continue running tasks (${done}/${total} done)`, action: 'continue-run' });
    }
    if (state.hasTasks && !state.allTasksDone && state.taskCounts.done > 0) {
      const { pending, done } = state.taskCounts;
      items.push({ key: String(key++), label: `Amend requirements and tasks (${pending} pending, ${done} done)`, action: 'amend-requirements' });
    }
    items.push({ key: String(key++), label: 'Archive and start new requirements', action: 'archive-describe' });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/menu.test.ts`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/menu.test.ts src/commands/continue.ts
git commit -m "feat: add amend-requirements menu item to devloop continue"
```

---

### Task 2: Add `generateAmendClaudeMd` function

**Files:**
- Modify: `src/commands/init.ts` (add new exported function)

- [ ] **Step 1: Write the failing test**

Create `test/amend-claude-md.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateAmendClaudeMd } from '../src/commands/init.js';

describe('generateAmendClaudeMd', () => {
  const workspace = '/test/workspace';
  const taskCounts = { total: 12, pending: 7, inProgress: 1, done: 4 };

  it('includes workspace path', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes(workspace));
  });

  it('includes task status summary', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('4 done'));
    assert.ok(content.includes('1 in-progress'));
    assert.ok(content.includes('7 pending'));
  });

  it('states rules about not modifying done/in-progress tasks', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('done'));
    assert.ok(content.includes('in-progress'));
    assert.ok(content.toLowerCase().includes('do not modify') || content.toLowerCase().includes('must not'));
  });

  it('allows modifying pending tasks', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('pending'));
    assert.ok(content.toLowerCase().includes('add') || content.toLowerCase().includes('modify') || content.toLowerCase().includes('remove'));
  });

  it('includes TodoWrite instructions', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('TodoWrite'));
  });

  it('includes the task format reference', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('TASK-'));
    assert.ok(content.includes('Status'));
    assert.ok(content.includes('Dependencies'));
    assert.ok(content.includes('Description'));
    assert.ok(content.includes('Verification'));
  });

  it('instructs user to exit when done', () => {
    const content = generateAmendClaudeMd(workspace, taskCounts);
    assert.ok(content.includes('exit') || content.includes('Ctrl+C'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/amend-claude-md.test.ts`
Expected: FAIL — `generateAmendClaudeMd` does not exist.

- [ ] **Step 3: Implement `generateAmendClaudeMd`**

In `src/commands/init.ts`, add after the closing of `generateWorkspaceClaudeMd`:

```typescript
export interface TaskCounts {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
}

export function generateAmendClaudeMd(workspace: string, taskCounts: TaskCounts): string {
  const platform = os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'macOS' : 'Linux';
  const reqPath = path.join(workspace, '.devloop', 'requirements.md');
  const tasksPath = path.join(workspace, '.devloop', 'tasks.md');

  return `# CLAUDE.md

This file provides guidance to Claude Code when working in this workspace.

## Environment

- **Platform**: ${platform}
- **Workspace**: ${workspace}
${platform === 'Windows' ? '- Use Windows-compatible commands (e.g., use backslashes in paths, no Unix-specific commands)\n' : ''}
## Current Task

You are amending an in-progress project. The user wants to modify the plan while some tasks have already been completed.

### Task Status Summary

- **${taskCounts.done} tasks done** — these are locked, do NOT modify
- **${taskCounts.inProgress} tasks in-progress** — these are locked, do NOT modify
- **${taskCounts.pending} tasks pending** — these are available for changes

---

## Session Progress

At the START of this session, use the **TodoWrite** tool to create a progress checklist visible to the user. Check off each item as you complete it:

1. Review current state (completed work, pending tasks)
2. Discuss amendments with user
3. Update requirements.md
4. Update pending tasks in tasks.md (do not modify done/in-progress)
5. Tell user to exit session

---

## Rules

### requirements.md (\`${reqPath}\`)

You may update this file freely to reflect the new scope. Add, modify, or remove sections as needed to keep the narrative planning document accurate.

### tasks.md (\`${tasksPath}\`)

**You MUST NOT modify any task with status \`done\` or \`in-progress\`.** These represent completed or active work and are locked.

For tasks with status \`pending\`, you may:
- **Add** new tasks with valid sequential IDs and the correct format
- **Modify** any field (title, description, verification, dependencies)
- **Remove** tasks that are no longer needed

When making changes:
- If you remove a pending task that other pending tasks depend on, update those dependencies
- If you add new tasks that depend on completed work, you can reference done tasks as dependencies
- New task IDs should continue from the highest existing ID
- All new tasks must have status \`pending\`

### Task Format

\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.
- **Verification**: A specific, testable check to confirm the task is complete.
\`\`\`

Task IDs support optional letter suffixes for subtasks (e.g., TASK-001a, TASK-001b).

---

When you are finished with all amendments, tell the user to exit this session with **Ctrl+C** or **/exit** so DevLoop can commit the changes.
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/amend-claude-md.test.ts`
Expected: PASS — all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts test/amend-claude-md.test.ts
git commit -m "feat: add generateAmendClaudeMd for mid-run amendment sessions"
```

---

### Task 3: Add `amendRequirements` handler and wire into continue command

**Files:**
- Modify: `src/commands/continue.ts:126-210` (command entry point switch) and add new handler

- [ ] **Step 1: Add the import for `generateAmendClaudeMd` and `TaskCounts`**

In `src/commands/continue.ts`, update the import from `init.js`:

```typescript
import { generateWorkspaceClaudeMd, generateAmendClaudeMd, commitWithRetry, detectAndConfigureCommitFormat } from './init.js';
```

- [ ] **Step 2: Add the `amend-requirements` case to the switch**

In the `switch (selected.action)` block in `continueCommand`, add:

```typescript
    case 'amend-requirements':
      await amendRequirements(workspace, session, currentIteration);
      break;
```

- [ ] **Step 3: Implement the `amendRequirements` handler**

Add after the `continueRequirements` function:

```typescript
async function amendRequirements(workspace: string, session: Session, currentIteration: number): Promise<void> {
  // Generate amendment-specific CLAUDE.md
  const state = await detectWorkspaceState(workspace, session);
  const claudeDir = path.join(workspace, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const claudeMdContent = generateAmendClaudeMd(workspace, state.taskCounts);
  await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');

  console.log(chalk.cyan('\nAmending requirements and tasks...'));
  console.log(chalk.yellow.bold('\n--- Tips ---'));
  console.log(chalk.yellow('  Tell Claude what changes you need to the plan.'));
  console.log(chalk.yellow(`  ${state.taskCounts.done} completed task(s) are locked. ${state.taskCounts.pending} pending task(s) can be changed.`));
  console.log(chalk.yellow('  Exit with Ctrl+C or /exit when done.'));
  console.log(chalk.yellow('------------\n'));

  const child = spawnClaudeInteractive(workspace, session.sessionId);

  child.on('error', (err) => {
    console.log(chalk.red(`\nFailed to start Claude: ${err.message}`));
  });

  child.on('close', async (code) => {
    try {
      console.log(chalk.blue('\n\nSession ended.'));
      if (code === 0) {
        await ensureGitRepo(workspace);
        const action = `Amend requirements (Phase ${currentIteration})`;
        const commitMessage = await getDevloopCommitMessage(workspace, action);
        await commitWithRetry(workspace, commitMessage, action);

        console.log(chalk.green('\nRequirements amended.'));
        console.log(chalk.gray('Run "devloop status" to see your updated tasks.'));
        console.log(chalk.gray('Run "devloop run" to continue executing tasks.'));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`\nError during post-session commit: ${msg}`));
    }
  });
}
```

- [ ] **Step 4: Add the missing import for `getDevloopCommitMessage`**

Update the imports at the top of `continue.ts`:

```typescript
import { ensureGitRepo, getDevloopCommitMessage } from '../core/git.js';
```

The existing `ensureGitRepo` import is already there — verify and add `getDevloopCommitMessage` to it.

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Clean compilation, no errors.

Run: `npx tsx --test test/menu.test.ts`
Expected: PASS — existing menu tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/continue.ts
git commit -m "feat: add amendRequirements handler to devloop continue"
```

---

### Task 4: Add TodoWrite instructions to init CLAUDE.md

**Files:**
- Modify: `src/commands/init.ts:21-131` (the `generateWorkspaceClaudeMd` function)

- [ ] **Step 1: Write the failing test**

Create `test/init-claude-md.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkspaceClaudeMd } from '../src/commands/init.js';

describe('generateWorkspaceClaudeMd TodoWrite instructions', () => {
  it('includes TodoWrite instructions for init session', () => {
    const content = generateWorkspaceClaudeMd('/test/workspace');
    assert.ok(content.includes('TodoWrite'), 'should mention TodoWrite tool');
  });

  it('includes the init session steps', () => {
    const content = generateWorkspaceClaudeMd('/test/workspace');
    assert.ok(content.includes('Explore project scope'));
    assert.ok(content.includes('gaps and inconsistencies'));
    assert.ok(content.includes('Write requirements.md'));
    assert.ok(content.includes('Generate tasks.md'));
    assert.ok(content.includes('exit session') || content.includes('exit'));
  });

  it('still includes TodoWrite instructions with prior context', () => {
    const content = generateWorkspaceClaudeMd('/test/workspace', {
      iterationNumber: 1,
      requirements: 'some requirements',
      tasks: '### TASK-001: First task',
      progress: 'some progress',
    });
    assert.ok(content.includes('TodoWrite'), 'should mention TodoWrite tool even with prior context');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/init-claude-md.test.ts`
Expected: FAIL — no TodoWrite mention in the generated content.

- [ ] **Step 3: Add TodoWrite instructions to `generateWorkspaceClaudeMd`**

In `src/commands/init.ts`, in the `generateWorkspaceClaudeMd` function, insert a session progress section before the `---` separator that precedes Phase 1. Find this line:

```typescript
---

### Phase 1 — Discovery (do NOT write any files)
```

Insert before it:

```typescript
## Session Progress

At the START of this session, use the **TodoWrite** tool to create a progress checklist visible to the user. Check off each item as you complete it:

1. Explore project scope and requirements with user
2. Review for gaps and inconsistencies
3. Write requirements.md
4. Generate tasks.md
5. Tell user to exit session

---
```

So the template string section becomes:

```typescript
## Session Progress

At the START of this session, use the **TodoWrite** tool to create a progress checklist visible to the user. Check off each item as you complete it:

1. Explore project scope and requirements with user
2. Review for gaps and inconsistencies
3. Write requirements.md
4. Generate tasks.md
5. Tell user to exit session

---

### Phase 1 — Discovery (do NOT write any files)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/init-claude-md.test.ts`
Expected: PASS — all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts test/init-claude-md.test.ts
git commit -m "feat: add TodoWrite progress roadmap to init CLAUDE.md"
```

---

### Task 5: Add TodoWrite instructions to continue-requirements CLAUDE.md

**Files:**
- Modify: `src/commands/continue.ts:214-238` (the `continueRequirements` function)
- Modify: `src/commands/init.ts` (add new `generateContinueClaudeMd` function)

- [ ] **Step 1: Write the failing test**

Add to `test/init-claude-md.test.ts`:

```typescript
import { generateWorkspaceClaudeMd, generateContinueClaudeMd } from '../src/commands/init.js';

describe('generateContinueClaudeMd', () => {
  it('includes TodoWrite instructions', () => {
    const content = generateContinueClaudeMd('/test/workspace');
    assert.ok(content.includes('TodoWrite'));
  });

  it('includes the continue-requirements session steps', () => {
    const content = generateContinueClaudeMd('/test/workspace');
    assert.ok(content.includes('Review current requirements'));
    assert.ok(content.includes('Discuss changes'));
    assert.ok(content.includes('Update requirements.md'));
    assert.ok(content.includes('Update tasks.md'));
    assert.ok(content.includes('exit session') || content.includes('exit'));
  });

  it('includes workspace path', () => {
    const content = generateContinueClaudeMd('/test/workspace');
    assert.ok(content.includes('/test/workspace'));
  });
});
```

Update the import line at the top of the file to include `generateContinueClaudeMd`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/init-claude-md.test.ts`
Expected: FAIL — `generateContinueClaudeMd` does not exist.

- [ ] **Step 3: Implement `generateContinueClaudeMd`**

In `src/commands/init.ts`, add after `generateAmendClaudeMd`:

```typescript
export function generateContinueClaudeMd(workspace: string): string {
  const platform = os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'macOS' : 'Linux';
  const reqPath = path.join(workspace, '.devloop', 'requirements.md');
  const tasksPath = path.join(workspace, '.devloop', 'tasks.md');

  return `# CLAUDE.md

This file provides guidance to Claude Code when working in this workspace.

## Environment

- **Platform**: ${platform}
- **Workspace**: ${workspace}
${platform === 'Windows' ? '- Use Windows-compatible commands (e.g., use backslashes in paths, no Unix-specific commands)\n' : ''}
## Current Task

You are continuing work on the project requirements and task list. The user wants to review and refine the plan.

**IMPORTANT: Do NOT implement the project. Do NOT write code, create source files, install packages, or build anything. Your ONLY job is to update the requirements and task list.**

## Session Progress

At the START of this session, use the **TodoWrite** tool to create a progress checklist visible to the user. Check off each item as you complete it:

1. Review current requirements and tasks
2. Discuss changes with user
3. Update requirements.md
4. Update tasks.md
5. Tell user to exit session

---

## Files

- **Requirements**: \`${reqPath}\` — the narrative planning document
- **Tasks**: \`${tasksPath}\` — the structured task list

Start by reading both files to understand the current state, then ask the user what changes they'd like to make.

### Task Format

\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Dependencies**: none
- **Description**: Clear description of what needs to be done.
- **Verification**: A specific, testable check to confirm the task is complete.
\`\`\`

Task IDs support optional letter suffixes for subtasks (e.g., TASK-001a, TASK-001b).

---

When you are finished with all changes, tell the user to exit this session with **Ctrl+C** or **/exit** so DevLoop can continue.
`;
}
```

- [ ] **Step 4: Update `continueRequirements` to write CLAUDE.md before spawning**

In `src/commands/continue.ts`, update the `continueRequirements` function to write the CLAUDE.md:

Add the import for `generateContinueClaudeMd`:
```typescript
import { generateWorkspaceClaudeMd, generateAmendClaudeMd, generateContinueClaudeMd, commitWithRetry, detectAndConfigureCommitFormat } from './init.js';
```

Then update the handler:

```typescript
async function continueRequirements(workspace: string, sessionId: string | null): Promise<void> {
  await updateSessionPhase(workspace, 'init');

  // Generate continue-specific CLAUDE.md with TodoWrite instructions
  const claudeDir = path.join(workspace, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const claudeMdContent = generateContinueClaudeMd(workspace);
  await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');

  console.log(chalk.cyan('\nResuming requirements session...'));
  console.log(chalk.yellow.bold('\n--- Tips ---'));
  console.log(chalk.yellow('  Ask Claude to review the current requirements and tasks, then tell it what changes you need.'));
  console.log(chalk.yellow('  Exit with Ctrl+C or /exit when done.'));
  console.log(chalk.yellow('------------\n'));

  const child = spawnClaudeInteractive(workspace, sessionId);

  child.on('error', (err) => {
    console.log(chalk.red(`\nFailed to start Claude: ${err.message}`));
  });

  child.on('close', (code) => {
    console.log(chalk.blue('\n\nSession ended.'));
    if (code === 0) {
      const requirementsPath = getRequirementsPath(workspace);
      console.log(chalk.green('Requirements file is at:'), requirementsPath);
      console.log(chalk.gray('Run "devloop status" to see your tasks.'));
      console.log(chalk.gray('Run "devloop run" to start executing tasks.'));
    }
  });
}
```

- [ ] **Step 5: Run tests to verify everything passes**

Run: `npx tsx --test test/init-claude-md.test.ts`
Expected: PASS — all 6 tests pass (3 existing + 3 new).

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts src/commands/continue.ts test/init-claude-md.test.ts
git commit -m "feat: add TodoWrite progress roadmap to continue-requirements session"
```

---

### Task 6: Update CLAUDE.md documentation and bump version

**Files:**
- Modify: `CLAUDE.md`
- Modify: `package.json`

- [ ] **Step 1: Add documentation for the amend-requirements feature to CLAUDE.md**

In `CLAUDE.md`, find the `### Iterative Requirements` section. After the paragraph describing the "When tasks are incomplete / in init phase" menu options, add the amend option.

Find this block:
```markdown
**When tasks are incomplete / in init phase:**
- Continue working on requirements (if in init phase or no tasks exist)
- Continue running tasks (with progress count, e.g., "5/12 done")
- Archive and start new requirements
```

Replace with:
```markdown
**When tasks are incomplete / in init phase:**
- Continue working on requirements (if in init phase or no tasks exist)
- Continue running tasks (with progress count, e.g., "5/12 done")
- Amend requirements and tasks (when at least one task is done — allows editing requirements.md and adding/modifying/removing pending tasks without affecting done/in-progress tasks)
- Archive and start new requirements
```

- [ ] **Step 2: Add documentation for TodoWrite session progress**

In `CLAUDE.md`, add a new subsection after `### Iterative Requirements` and before `### Version Tracking`:

```markdown
### Interactive Session Progress

All interactive Claude sessions (init, continue-requirements, amend-requirements) instruct Claude to use the `TodoWrite` tool at the start of the session to create a visible progress roadmap. Each session type has its own step list matching its workflow. Claude checks items off as it completes each phase, giving the user a clear sense of where the session is in the process.
```

- [ ] **Step 3: Bump version in package.json**

Update `package.json` version from `4.0.2` to `4.1.0` (minor bump — new feature, no breaking changes).

- [ ] **Step 4: Run full test suite**

Run: `npm run build && npm test`
Expected: Clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md package.json
git commit -m "docs: document amend-requirements and session todos, bump to v4.1.0"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the full test suite with coverage**

Run: `npm run test:coverage`
Expected: All tests pass, coverage thresholds met.

- [ ] **Step 2: Run a quick manual check of the build**

Run: `npm run build && npm run dev -- continue --help`
Expected: Clean build, help output shows continue command.

- [ ] **Step 3: Verify all new tests pass independently**

Run: `npx tsx --test test/menu.test.ts test/amend-claude-md.test.ts test/init-claude-md.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit any remaining changes**

If there are any uncommitted changes (lint fixes, etc.):
```bash
git add -A
git commit -m "chore: final cleanup for amend-requirements feature"
```
