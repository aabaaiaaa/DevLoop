# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run dev -- <command>    # Run CLI in development (e.g., npm run dev -- status)
npm run build               # Compile TypeScript to dist/
npm run typecheck           # Type-check without emitting
npm run start               # Run compiled CLI from dist/
```

After changes, run `npm run build` to update the `dist/` folder. The CLI is globally linkable via `npm link`.

## Architecture

DevLoop is a CLI tool that automates iterative development by orchestrating Claude Code to complete tasks from a requirements document.

### Two Operational Modes

1. **Interactive Mode** (`init`, `continue requirements`): Spawns Claude CLI with `stdio: 'inherit'` for user interaction. Used for creating/refining requirements.md.

2. **Automated Mode** (`run`): Spawns Claude CLI with `-p` flag for non-interactive task execution. Each iteration is a fresh Claude context. Uses `--add-dir` to restrict file operations to workspace.

### Init Behavior

The `init` command handles three scenarios:
- **Fresh init**: No `requirements.md` exists → creates template and session
- **Adopt existing**: `requirements.md` exists but no `.devloop/session.json` → keeps existing requirements, creates session and CLAUDE.md infrastructure
- **Already initialized**: Both exist → suggests using `continue` or `--force`

This allows users who manually create `requirements.md` to run `devloop init` to set up the infrastructure needed for `devloop run`.

### Core Flow

```
cli.ts → commands/*.ts → core/loop.ts → core/claude.ts
                              ↓
                    parser/requirements.ts (find next task)
                              ↓
                    parser/progress.ts (log iteration)
```

### Key Abstractions

- **Workspace**: A directory containing `requirements.md`, `progress.md`, and `.devloop/session.json`. Resolved via: CLI flag → global config → cwd.
- **Session**: Persisted state in `.devloop/session.json` tracking phase (`init`/`run`) and iteration count.
- **Global Config**: `~/.devloop/config.json` stores default workspace and settings.

### Document Formats

Tasks in `requirements.md` follow this structure (regex-parsed in `parser/requirements.ts`):
```markdown
### TASK-001: Title
- **Status**: pending|in-progress|done
- **Priority**: high|medium|low
- **Dependencies**: none|TASK-XXX, TASK-YYY
- **Description**: What to do
```

Task selection (`getNextTask`) respects dependencies and prioritizes by priority then ID.

### Safety

Automated mode uses `--add-dir <workspace>` to restrict Claude's file operations. The prompt explicitly states workspace boundaries. A `.claude/settings.json` is generated with permission rules.

### Progress Indicators

The run loop provides visual feedback:
- **Terminal title**: Updated via ANSI escape sequence (`\x1b]0;TITLE\x07`) to show iteration/task/progress
- **Timed spinner**: Uses `ora` with a 1-second interval to show elapsed time during task execution
- Format: `DevLoop: {iteration}/{max} - {taskId} ({completed}/{total} done)`

### Graceful Shutdown

The run loop handles SIGINT (Ctrl+C) gracefully:
- First Ctrl+C: Sets `stopRequested` flag, loop exits after current task completes
- Second Ctrl+C: Sets `forceStopRequested` flag, warns user
- Third Ctrl+C: Force exits with `process.exit(1)`

Signal handler is cleaned up when loop exits normally.

### Interrupted Work Recovery

If a run is interrupted (Ctrl+C) mid-task, the next run detects uncommitted git changes and commits them before continuing:
- Lists changed files to the console
- Commits the partial work with message: `DevLoop: Interrupted work on TASK-XXX - Task title`
- Claude then starts fresh with a clean working tree
- The partial work is preserved in git history and can be recovered if needed
- If commit fails, DevLoop stops and requires manual resolution (prevents inconsistent state)

### Git Integration

DevLoop automatically integrates with Git when available:

- **Auto-detection**: At the start of each run, DevLoop checks if Git is available on the system.
- **Auto-initialization**: If Git is available but no repo exists, DevLoop initializes one and creates an initial commit with all existing files.
- **Gitignore management**: Ensures `.gitignore` exists with sensible defaults (node_modules/, .env, dist/, etc.). For existing repos, adds critical patterns if missing.
- **Iteration commits**: After each iteration, all changes (including `.devloop/` and `.claude/` folders) are committed with a descriptive message.
- **Continuation support**: If Git becomes available after previous iterations (e.g., user installs Git), the repo is initialized before continuing.
- **Graceful degradation**: If Git is not available, DevLoop continues without version control.

### Token Tracking

DevLoop tracks API token usage via Claude's `--output-format json` flag:

- **ClaudeResult.tokenUsage**: Contains `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`, and `costUsd`
- **IterationLog.tokenUsage**: Persisted to `progress.md` for each iteration
- **Cumulative tracking**: Loop maintains running totals across iterations
- **Token limit**: `DevLoopConfig.tokenLimit` stops the loop before exceeding the threshold

### API Error Classification

Errors from Claude CLI are classified in `core/claude.ts`:

- **rate_limit**: 400/429 errors, "api usage limit" messages
- **api_overload**: 503 errors, "overloaded" messages
- **auth_error**: 401 errors, "unauthorized" messages  
- **network_error**: Connection refused, timeout, DNS failures
- **task_failure**: Claude ran but task didn't complete (not an API error)
- **unknown**: Unclassified API errors

API errors (all except `task_failure`) stop the loop immediately. Task failures continue to the next iteration.

Commit message format:
- Initial: `DevLoop: Initial commit`
- Success: `DevLoop iteration N: Complete TASK-XXX - Task title`
- Failure: `DevLoop iteration N: Attempted TASK-XXX - Task title (failed)`

This enables users and Claude to revert changes if an iteration produces undesirable results.
