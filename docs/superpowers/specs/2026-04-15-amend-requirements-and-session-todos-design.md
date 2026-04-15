# Mid-Run Requirements Amendment & Interactive Session Todos

**Date**: 2026-04-15
**Status**: Approved

## Overview

Two related features for DevLoop's interactive sessions:

1. **Mid-run requirements amendment** — a new `devloop continue` menu option that lets users amend `requirements.md` and pending tasks in `tasks.md` while a run is partially complete.
2. **Todo checkboxes in interactive sessions** — all interactive Claude sessions (init, continue-requirements, amend-requirements) use `TodoWrite` to show a progress roadmap of the session phases.

## Feature 1: Mid-Run Requirements Amendment

### Menu Integration

A new `amend-requirements` action in `buildMenuOptions()` in `src/commands/continue.ts`.

**Visibility conditions** (all must be true):
- Tasks exist (`hasTasks`)
- At least one task is done (`done > 0`)
- Not all tasks are done (`!allTasksDone`)

**Label**: `Amend requirements and tasks (N pending, M done)`

**Position**: Between "Continue running tasks" and "Archive and start new requirements".

When no tasks are done yet, the existing "Continue working on requirements" option covers that case (init-phase behavior).

Example menu when tasks are mid-run:
```
1. Continue running tasks (5/12 done)
2. Amend requirements and tasks (7 pending, 5 done)
3. Archive and start new requirements
4. Remove all DevLoop files
5. Cancel
```

### Interactive Session

The `amendRequirements()` handler in `src/commands/continue.ts`:

1. Generates an amendment-specific CLAUDE.md via `generateAmendClaudeMd()` (new function in `src/commands/init.ts`)
2. Writes it to `.claude/CLAUDE.md` in the workspace
3. Spawns an interactive Claude session via `spawnClaudeInteractive(workspace, sessionId)`
4. On session close (exit code 0):
   - Ensures git repo exists
   - Commits with format: `DevLoop: Amend requirements (Phase {N})` (using `devloopCommitFormat` config)
   - Prints guidance to run `devloop run` to continue

### Amendment CLAUDE.md Prompt

The `generateAmendClaudeMd(workspace, taskCounts)` function generates a CLAUDE.md that:

- States the workspace path and platform (same preamble as existing)
- Explains context: "You are amending an in-progress project. Some tasks are already completed."
- Includes a task status summary: "M tasks done, P in-progress, N pending"
- **Rules for requirements.md**: May be updated freely to reflect new scope
- **Rules for tasks.md**:
  - May add new tasks (with valid sequential IDs and correct format)
  - May modify any task with status `pending` (description, verification, dependencies, title)
  - May remove any task with status `pending`
  - Must NOT modify tasks with status `done` or `in-progress`
  - If removing a pending task that other pending tasks depend on, must update those dependencies
  - If adding new tasks that depend on completed work, can reference done tasks as dependencies
- Includes the standard task format reference (TASK-ID, status fields, etc.)
- Reminds Claude to tell the user to exit with Ctrl+C or /exit when done
- Includes `TodoWrite` session roadmap instructions (see Feature 2)

### What Happens After Amendment

No special handling is needed in the run loop. When `devloop run` is invoked after amendment:
- `parseTasks()` reads the updated `tasks.md` as usual
- `getAvailableTasks()` picks up any new pending tasks whose dependencies are met
- Modified pending tasks are executed with their updated descriptions/verifications
- Removed tasks are simply gone — no trace needed
- Done/in-progress tasks are unaffected

## Feature 2: Todo Checkboxes in Interactive Sessions

### Approach

All three interactive session types instruct Claude (via CLAUDE.md) to use the `TodoWrite` tool at the start of the session to create a visible progress roadmap. Claude checks items off as it completes each phase.

The CLAUDE.md prompt includes an instruction block like:

```
At the START of this session, use the TodoWrite tool to create a progress checklist 
for the user. Check off each item as you complete it.
```

Followed by the specific steps for that session type.

### Per-Session Step Lists

**Init session** (`generateWorkspaceClaudeMd` — no prior context):
1. Explore project scope and requirements with user
2. Review for gaps and inconsistencies
3. Write requirements.md
4. Generate tasks.md
5. Tell user to exit session

**Continue requirements session** (`continueRequirements` handler):
1. Review current requirements and tasks
2. Discuss changes with user
3. Update requirements.md
4. Update tasks.md
5. Tell user to exit session

**Amend requirements session** (`generateAmendClaudeMd`):
1. Review current state (completed work, pending tasks)
2. Discuss amendments with user
3. Update requirements.md
4. Update pending tasks in tasks.md (do not modify done/in-progress)
5. Tell user to exit session

### Implementation

The todo instructions are embedded directly in the CLAUDE.md content for each session type. No changes to the Claude invocation mechanism — `TodoWrite` is a standard tool available in interactive sessions.

For init: added to `generateWorkspaceClaudeMd()` in `src/commands/init.ts`.

For continue-requirements: the `continueRequirements()` handler in `src/commands/continue.ts` currently just spawns Claude with the existing session. It will need to update CLAUDE.md with the todo instructions before spawning. This can reuse `generateWorkspaceClaudeMd()` or write a small continue-specific CLAUDE.md.

For amend: built into `generateAmendClaudeMd()` from the start.

## Files Changed

- **`src/commands/continue.ts`**:
  - `buildMenuOptions()` — add `amend-requirements` menu item with visibility conditions
  - `continueCommand()` switch — add `amend-requirements` case
  - New `amendRequirements()` handler
  - `continueRequirements()` — update CLAUDE.md before spawning to include todo instructions
- **`src/commands/init.ts`**:
  - `generateWorkspaceClaudeMd()` — add `TodoWrite` progress roadmap instructions to the init prompt
  - New `generateAmendClaudeMd()` function
- **`CLAUDE.md`** — document the new menu option and todo behavior
- **`package.json`** — version bump
- **Tests** — new test cases for:
  - Menu option visibility (shows when done > 0 and pending > 0, hidden otherwise)
  - `generateAmendClaudeMd()` output contains expected rules and todo instructions
  - `generateWorkspaceClaudeMd()` output contains todo instructions

## Non-Goals

- No changes to the automated run loop (`core/loop.ts`)
- No merge logic or filtered views — Claude sees and edits the full files
- No enforcement beyond prompt instructions — Claude is trusted to follow the rules about locked tasks
- No changes to task parsing or status management
