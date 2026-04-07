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

DevLoop is a CLI tool that automates iterative development by orchestrating Claude Code to complete tasks from a task list.

### Two Operational Modes

1. **Interactive Mode** (`init`, `continue` → "Continue working on requirements"): Spawns Claude CLI with `stdio: 'inherit'` for user interaction. Used for creating/refining `.devloop/requirements.md` and generating `.devloop/tasks.md`.

2. **Automated Mode** (`run`): Spawns Claude CLI with `-p` flag for non-interactive task execution. Each iteration is a fresh Claude context. Uses `--add-dir` to restrict file operations to workspace.

### Init Behavior

The `init` command follows a 3-phase workflow:
1. **Discovery**: Claude explores the project scope through conversation. For open-ended questions (features, user flows, edge cases) Claude uses natural conversation. For standard technical choices (language, framework, testing approach, etc.) Claude is instructed to use the `AskUserQuestion` tool to present selectable options. Once discovery is complete, Claude reviews for inconsistencies and gaps before proceeding.
2. **Write requirements.md**: Claude writes `.devloop/requirements.md` — a free-form, human-readable planning document describing the project
3. **Generate tasks.md**: Claude generates `.devloop/tasks.md` — the machine-parsed task list derived from the requirements. After writing both documents, Claude tells the user to exit the session (Ctrl+C or /exit) so DevLoop can commit the files.

The command handles three scenarios:
- **Fresh init**: No requirements file exists → runs the 3-phase workflow and creates session
- **Adopt existing**: Requirements file exists but no session → keeps existing files, creates session and `.claude/CLAUDE.md` infrastructure
- **Already initialized**: Both exist → suggests using `continue` or `--force`

This allows users who manually create requirements and task files to run `devloop init` to set up the infrastructure needed for `devloop run`.

After creating the session, `init` also:
- Detects commit hooks from commitlint/husky/git hooks
- If hooks detected, prompts user for initial commit message with `{action}` placeholder support
- Saves the format to `devloopCommitFormat` config for reuse in future DevLoop commits

After the interactive Claude session ends:
- Ensures a git repo exists (initializes one if needed)
- Makes an initial commit with all created files
- If commit fails due to hooks, prompts for a valid message and retries

### Core Flow

```
cli.ts → commands/*.ts → core/loop.ts → core/claude.ts
                              ↓
                    parser/tasks.ts (parse tasks, find next task)
                              ↓
                    parser/progress.ts (log iteration)
                              ↓
                    consolidated verification (default) or per-task verification
                              ↓
                    final code review
```

### Key Abstractions

- **Workspace**: A directory containing `.devloop/` (with `requirements.md`, `tasks.md`, `progress.md`, `session.json`) and `.claude/` (with `CLAUDE.md`, `settings.json`). Resolved via: CLI flag → global config → cwd.
- **Session**: Persisted state in `.devloop/session.json` tracking phase (`init`/`run`), iteration count, the DevLoop version that created it (`devloopVersion`), and `activeTask: ActiveTask | null` for crash recovery.
- **Global Config**: `~/.devloop/config.json` stores default workspace and settings.

### Document Formats

DevLoop uses two separate documents:

- **`.devloop/requirements.md`**: A free-form, human-readable planning document. This is a narrative description of the project — goals, architecture decisions, constraints, etc. It is not parsed by the task engine.
- **`.devloop/tasks.md`**: The machine-parsed task list. This is what the run loop reads to find and execute tasks.

DevLoop also generates per-task log files in `.devloop/logs/TASK-XXX.log` containing the prompt sent to Claude and Claude's full raw output (stream-json format). These are overwritten on retry so only the latest attempt is kept.

Tasks in `.devloop/tasks.md` follow this structure (regex-parsed in `parser/tasks.ts`):
```markdown
### TASK-001: Title
- **Status**: pending|in-progress|done
- **Dependencies**: none|TASK-XXX, TASK-YYY
- **Description**: What to do
- **Verification**: How to confirm it's done
```

Task IDs support optional letter suffixes for subtasks (e.g., `TASK-001a`, `TASK-001b`). The `TASK_REGEX` is `/^### (TASK-\d+[a-z]*): (.+)$/`.

Task selection (`getNextTask`) returns the next task to work on:
1. In-progress tasks first (interrupted work that needs retrying)
2. Then pending tasks, sorted by task ID
3. Only pending tasks whose dependencies are all `done` are eligible

When a task was previously interrupted (in-progress with an existing progress log), Claude receives context about the previous attempt so it can build on partial work rather than starting from scratch.

During execution, tasks transition: `pending` → `in-progress` (before Claude starts) → `done` (on success). On failure, tasks stay `in-progress` so they are retried next iteration. If the run is stopped gracefully (Q key) mid-task and Claude succeeds, the task is marked `done`.

### Status Cross-Reference

At the start of each run, the loop cross-references `tasks.md` against `progress.md` to fix inconsistencies (e.g., from crashes or interrupted runs):
- Task marked `done` in tasks but **no completion log** in progress → reverted to `pending`
- Task marked `in-progress` in tasks but **has a completion log** in progress → promoted to `done`
- Task marked `pending` in tasks but **has a completion log** in progress → promoted to `done`

### CRLF Handling

Parsers for `tasks.md` and `progress.md` normalize CRLF line endings to LF before regex matching. This ensures DevLoop works correctly on Windows even if files are edited with tools that save with CRLF endings.

### Safety

Automated mode uses `--add-dir <workspace>` to restrict Claude's file operations. The prompt explicitly states workspace boundaries. A `.claude/settings.json` is generated with permission rules via `ensureWorkspaceSettings(workspacePath)`.

Additionally, `.devloop/` and `.claude/` directories are deny-listed in `settings.json` during automated runs, preventing Claude from editing DevLoop's own configuration, task definitions, or progress files.

### Progress Indicators

The run loop provides visual feedback:
- **Terminal title**: Updated via ANSI escape sequence (`\x1b]0;TITLE\x07`) to show current task and progress
- **Spinner**: Built-in spinner (`core/spinner.ts`) shows elapsed time and current tool activity (e.g., `Working: TASK-001 (2/10 done) - Reading file (1m 23s)`)
- **Task details**: When a task starts, its description and verification are printed to the console
- **Terminal title format**: `DevLoop: TASK-XXX | {completed}/{total} done`

### Graceful Shutdown

The run loop uses **stdin keypresses** (not SIGINT) for graceful shutdown, avoiding the problem of SIGINT propagating to the child Claude process and killing it mid-task:

- **Q key**: Sets `stopRequested` flag. The spinner is paused and a persistent `>> Graceful stop requested` message is displayed via `stopAndPersist`, then the spinner resumes. After the current task completes, the loop stops. If the task succeeds, it is marked as done; work is not lost. The `activeSpinner` module-level variable gives the `onData` handler access to the spinner so the message is visible immediately (plain `console.log` gets overwritten by spinner redraws).
- **Ctrl+C**: Force stop. In raw mode this is handled as a keypress (`\x03`), calling `process.exit(1)`. This kills everything including all Claude child processes.

When stdin is a TTY, raw mode (`setRawMode(true)`) is used so keypresses arrive immediately. On Windows (especially Git Bash/mintty), stdin may not be detected as a TTY; in that case a line-buffered fallback is used (`q` + Enter). Raw mode is defensively re-enabled after each child process spawn, since spawning `cmd.exe` on Windows can reset the console input mode.

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

DevLoop tracks API token usage via Claude's `--output-format stream-json` flag:

- **ClaudeResult.tokenUsage**: Contains `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`, and `costUsd`
- **IterationLog.tokenUsage**: Persisted to `.devloop/progress.md` for each iteration
- **Session vs Project tracking**: Loop tracks both session tokens (current run) and project tokens (all-time from `.devloop/progress.md`)
- **Token limit**: `DevLoopConfig.tokenLimit` stops the loop when the current session exceeds the threshold (not cumulative across all runs)
- **Cost limit**: `DevLoopConfig.costLimit` stops the loop when session cost exceeds the threshold. Default: `$10`. Hard ceiling: `$500`.
- **Task timeout**: `DevLoopConfig.taskTimeout` kills the Claude child process if a task exceeds the limit. Default: `150 minutes` (2h30m). Configurable via `--task-timeout <minutes>`.
- **Iteration ceiling**: `maxIterations` defaults to `100` with a hard ceiling of `1000`, clamped in `buildRunConfig()`.
- **Detailed breakdown**: Displays individual token counts (input, output, cache write, cache read) and blended price per million tokens
- **Price per million**: Calculated as `(cost / tokens) * 1,000,000` - a blended rate useful for gauging efficiency

### Run Statistics

When the run loop completes (all tasks done, Q key, cost/token limit, or API error), `displayRunStatistics()` in `loop.ts` shows a detailed summary:

- **Duration and iteration counts**: Wall-clock time, successful/failed iteration counts
- **Average time per task**: Computed from successful iterations only
- **Longest/shortest tasks**: By duration, with task IDs and titles (skipped if ≤1 task)
- **Failure analysis**: Per-task failure counts, whether each was eventually overcome ("succeeded" vs "still in-progress"), and error type breakdown
- **Token/cost summary**: Session totals and average cost per task

Timing data is collected in an `IterationTiming[]` array during the run (raw milliseconds), avoiding the need to parse formatted duration strings from progress.md.

The `IterationLog` type includes a `taskAttempted` field that records which task was targeted in each iteration, even on failure. This enables failure correlation — determining whether a failed task was later retried and succeeded.

### Task Logging

After each iteration, Claude's full output is written to `.devloop/logs/TASK-XXX.log`. Each log file contains:
- Task metadata (ID, title, iteration, timestamp, duration, result)
- The full prompt sent to Claude
- Claude's raw stream-json output (all tool calls, reasoning, content blocks)
- Claude's final result text

Log files are overwritten on retry (same task ID = same file), so only the latest attempt is kept. The `writeTaskLog()` function in `loop.ts` handles this, with errors logged silently to avoid disrupting the run.

### Final Code Review

When all tasks complete, `runFinalReview()` in `loop.ts` automatically invokes Claude one more time to review the entire project:

- Cross-references requirements against the implementation, flagging gaps or scope creep
- Reviews code quality, error handling, and security
- Checks test coverage adequacy
- Provides recommendations and future considerations (next features, tech debt, architectural notes)

The report is written to `.devloop/review.md` and automatically opened in the user's default application. It is committed to git and archived alongside other files when starting a new iteration.

The review only runs when genuinely all tasks are complete — not on partial stops (Q key, cost limit, iteration limit, API errors). The `invoke` function is used (respects `overrides.invoker` for testing) and file opening is skipped during tests (via `skipStdin`/`skipOpen`).

### Task Timeout

Tasks have a configurable timeout (default: 150 minutes / 2h30m) via `--task-timeout <minutes>` CLI option or `DevLoopConfig.taskTimeout` (in milliseconds).

- When the timeout fires, the Claude child process is killed via `SIGTERM`
- The error is classified as `task_failure` (not `network_error`) so the task is retried rather than stopping the loop
- The `wasTimedOut` flag in `invokeClaudeAutomated` overrides the normal `classifyError` result, which would otherwise match "timeout" as a `network_error` and stop the loop

### Consolidated Verification

By default, DevLoop defers test suite execution to a consolidated phase after all tasks complete. Quick checks (type-checking, linting) still run per-task.

- **Default behavior**: Each task prompt tells Claude to run only quick checks (`tsc --noEmit`, linting) and skip test suites. After all tasks complete, a verification phase runs all test suites once.
- **Consolidation**: Multiple filtered test commands (e.g., `npm test -- --grep "calculator"` from TASK-001, `npm test -- --grep "parser"` from TASK-002) are consolidated into a single `npm test` run. Different test runners (npm test + pytest) each run once.
- **Fix/retry**: If tests fail, Claude identifies which task's changes likely caused the failure, fixes the code, and re-runs only the affected tests. Up to 3 fix cycles.
- **Final review gate**: The final code review only runs if consolidated verification passes.
- **Opt-out**: Use `--verify-each-task` CLI flag or `devloop config set verifyEachTask true` to use the old per-task verification behavior where each task runs its own tests before completing.
- **Logging**: Verification results are logged to `.devloop/logs/VERIFICATION.log` and recorded in `progress.md`.

### API Error Classification

Errors from Claude CLI are classified in `core/claude.ts`:

- **rate_limit**: 400/429 errors, "api usage limit" messages
- **api_overload**: 503 errors, "overloaded" messages
- **auth_error**: 401 errors, "unauthorized" messages  
- **network_error**: Connection refused, timeout, DNS failures
- **task_failure**: Claude ran but task didn't complete (not an API error)
- **unknown**: Unclassified API errors

API errors (all except `task_failure`) stop the loop. Task failures continue to the next iteration (the task remains in-progress for retry).

### Commit Message Format

All DevLoop commits use the `devloopCommitFormat` config with `{action}` placeholder:
- Default: `DevLoop: {action}`
- Example actions: "Initialize workspace", "Complete TASK-001 - Fix bug", "Attempted TASK-002 - Add feature"

**Auto-detection**: During `devloop init`, commit hooks are auto-detected from commitlint, git hooks, and husky. If detected, the user is prompted for a commit message format.

**Manual configuration**:
```bash
devloop config set devloopCommitFormat "chore(devloop): {action}"
devloop config list  # Show current config
```

**Hook failure handling**: If a commit fails due to a hook, DevLoop:
1. Displays the hook error and attempted message
2. Prompts for a valid commit message (with `{action}` placeholder hint)
3. Retries until successful or user skips
4. Saves the format for future commits

### Iterative Requirements

DevLoop supports iterating on requirements through `devloop continue`. The menu is **contextual** — options shown depend on the current workspace state:

**When all tasks are complete:**
- View the review (if `review.md` exists)
- Archive and start next phase
- Archive and start next phase (informed by review) — includes review content in CLAUDE.md for Claude to use when planning the next iteration

**When tasks are incomplete / in init phase:**
- Continue working on requirements (if in init phase or no tasks exist)
- Continue running tasks (with progress count, e.g., "5/12 done")
- Archive and start new requirements

State detection uses `detectWorkspaceState()` which checks session phase, task counts, and `review.md` existence.

When archiving, the current `requirements.md`, `tasks.md`, `progress.md`, and `review.md` (if present) are copied to `.devloop/archive/iteration-{N}/`, then tasks, progress, and review are deleted so the next iteration starts fresh. Claude is spawned with prior work context to create new requirements and tasks.

**Prior context**: To avoid bloating the CLAUDE.md with large task lists, the prior context includes only task titles (not full descriptions/verification steps). When the "informed by review" option is chosen, the review content is also included via the `PriorContext.review` field so Claude can use the recommendations to guide the next iteration. `loadPriorContext()` in `core/archive.ts` loads requirements, tasks, progress, and review from the archive directory.

The `Session` type has an `iteration` field (1-based, defaults to 1 for backward compat). `devloop status` displays the iteration number when > 1.

**Session file handling**: Changes to `.devloop/` and `.claude/` are excluded from the uncommitted changes check that detects interrupted work, so they don't trigger false positives. These files are still committed as part of regular iteration commits.

### Version Tracking

The `Session` type includes a `devloopVersion` field that records the DevLoop version (from `package.json`) when a session is created. This enables future compatibility checks when a workspace created by one version is used with another.

- **Recording**: `createSession()` in `session.ts` automatically sets `devloopVersion` via `getVersion()` from `core/version.ts`
- **Display**: `devloop status` shows the version that created the session (or "unknown (pre-3.0)" for old sessions)
- **Backward compat**: Old session files without the field parse as `devloopVersion: undefined`
- **Shared helper**: `getVersion()` in `core/version.ts` reads the version from `package.json` using `createRequire`. Used by both `cli.ts` and `session.ts`.

### Testing Infrastructure

`runLoop` accepts an optional second parameter `RunLoopOverrides` (defined in `core/loop.ts`) for dependency injection in tests:

- **`invoker`**: Replaces `invokeClaudeAutomated` — tests pass a mock that returns controlled `ClaudeResult` objects without spawning Claude CLI
- **`skipStdin`**: Skips `setupGracefulShutdown()` and `ensureStdinListening()` — avoids stdin raw mode interference with the test runner
- **`skipGit`**: Skips `ensureGitRepo()`, `commitIteration()`, `commitInterruptedWork()`, and `getUncommittedChanges()`
- **`stopAfterIterations`**: Sets `stopRequested = true` after N iterations complete — simulates Q key press for testing graceful shutdown behavior

Production behavior is unchanged when `overrides` is undefined.

Test fixtures in `test/fixtures/calculator.ts` provide:
- `createCalculatorWorkspace()` / `createPhase2Tasks()` — set up a calculator project with tasks, dependencies, and session
- `createMockInvoker()` — configurable mock with per-task result overrides and call tracking
- `createFailThenSucceedMock()` — mock that fails a task N times then succeeds (for retry testing)

Integration tests in `test/integration.test.ts` cover the full lifecycle: task execution in dependency order, retry on failure, archive + new iteration, cost/iteration limits, API error handling, graceful shutdown, status data, and final code review (creation, skipped on partial stop, archived correctly).
