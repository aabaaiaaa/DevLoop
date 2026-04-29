# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run dev -- <command>    # Run CLI in development (e.g., npm run dev -- status)
npm run build               # Compile TypeScript to dist/
npm run typecheck           # Type-check without emitting
npm run start               # Run compiled CLI from dist/
npm test                    # Run tests
npm run test:coverage       # Run tests with coverage (enforces thresholds)
```

After changes, run `npm run build` to update the `dist/` folder. The CLI is globally linkable via `npm link`.

## Architecture

DevLoop is a CLI tool that automates iterative development by orchestrating Claude Code to complete tasks from a task list.

### Two Operational Modes

1. **Interactive Mode** (`init`, `continue` → "Continue working on requirements"): Spawns Claude CLI with `stdio: 'inherit'` for user interaction. Used for creating/refining `.devloop/requirements.md` and generating `.devloop/tasks.md`.

2. **Automated Mode** (`run`): Spawns Claude CLI with `-p` flag for non-interactive task execution. Each iteration is a fresh Claude context. Uses `--add-dir` to restrict file operations to workspace.

### Init Behavior

The `init` command follows a 4-phase workflow:
1. **Discovery**: Claude explores the project scope through conversation. For open-ended questions (features, user flows, edge cases) Claude uses natural conversation. For standard technical choices (language, framework, testing approach, etc.) Claude is instructed to use the `AskUserQuestion` tool to present selectable options. Once discovery is complete, Claude reviews for inconsistencies and gaps before proceeding.
2. **Write requirements.md**: Claude writes `.devloop/requirements.md` — a free-form, human-readable planning document describing the project
3. **Generate tasks.md**: Claude generates `.devloop/tasks.md` — the machine-parsed task list derived from the requirements. After writing both documents, Claude tells the user to exit the session (Ctrl+C or /exit) so DevLoop can commit the files.
4. **Self-review**: Claude reviews `requirements.md` and `tasks.md` for inconsistencies, missing dependencies, broken/circular deps, missing required fields, and scope drift. Auto-fixes major issues and re-reviews up to 3 times. Surfaces minor issues (ambiguity, granularity opinions) for the user to decide on.

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
                    parser/tasks.ts (find eligible tasks)
                              ↓
                    single task or batch (via Agent tool) execution
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
- **Type**: feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
- **Dependencies**: none|TASK-XXX, TASK-YYY
- **Description**: What to do
- **Verification**: How to confirm it's done
- **Breaking**: (optional) Description of any backwards-incompatible change introduced
```

The `Type` field drives the Conventional Commits prefix on the auto-generated git commit. Missing or unknown values default to `chore`. The `Breaking` field is optional; when present, its text becomes the body of a `BREAKING CHANGE:` footer in the commit, signalling a major version bump to semver tooling.

Task IDs support optional letter suffixes for subtasks (e.g., `TASK-001a`, `TASK-001b`). The `TASK_REGEX` is `/^### (TASK-\d+[a-z]*): (.+)$/`.

Task selection uses `getAvailableTasks` (returns all eligible tasks for parallel batching) or `getNextTask` (returns one, used as fallback):
1. In-progress tasks first (interrupted work that needs retrying)
2. Then pending tasks, sorted by task ID
3. Only pending tasks whose dependencies are all `done` are eligible
4. When 2+ tasks are eligible and `maxParallelTasks >= 2`, they are batched into a single Claude invocation

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

The run loop provides visual feedback for both single-task and batch execution:
- **Terminal title**: Updated via ANSI escape sequence (`\x1b]0;TITLE\x07`) to show current task/batch and progress
- **Spinner**: Built-in spinner (`core/spinner.ts`) shows elapsed time and current tool activity (e.g., `Working: TASK-001 (2/10 done) - Reading file (1m 23s)` or `Batch: 5 tasks (2/10 done) - Using Agent (45s)`)
- **Task details**: When a task or batch starts, each task's ID, title, description, and verification are printed to the console
- **Tool usage stats**: After completion, shows a breakdown of tool calls and durations (Bash, Read, Write, Edit, etc.) for both single tasks and batches
- **Terminal title format**: `DevLoop: TASK-XXX | {completed}/{total} done` or `DevLoop: Batch (N tasks) | {completed}/{total} done`

### Graceful Shutdown

The run loop uses **stdin keypresses** (not SIGINT) for graceful shutdown, avoiding the problem of SIGINT propagating to the child Claude process and killing it mid-task:

- **Q key (during tasks)**: Toggles `stopRequested` on/off. First press shows yellow `>> Graceful stop requested... Press Q again to cancel.` — after the current task/batch completes, the loop stops. Second press shows green `>> Stop cancelled` and the loop continues normally. If the task succeeds while stop is requested, it is still marked as done; work is not lost. The `activeSpinner` module-level variable gives the `onData` handler access to the spinner so the message is visible immediately (plain `console.log` gets overwritten by spinner redraws).
- **Q key (during verification)**: Kills the entire Claude process tree immediately (including spawned test runners) and skips verification. The `inVerificationPhase` flag controls which Q behaviour applies. The final review still proceeds.
- **Ctrl+C**: Force stop. In raw mode this is handled as a keypress (`\x03`), calling `process.exit(1)`. This kills everything including all Claude child processes.

When stdin is a TTY, raw mode (`setRawMode(true)`) is used so keypresses arrive immediately. On Windows (especially Git Bash/mintty), stdin may not be detected as a TTY; in that case a line-buffered fallback is used (`q` + Enter). Raw mode is defensively re-enabled after each child process spawn, since spawning `cmd.exe` on Windows can reset the console input mode.

### Interrupted Work Recovery

If a run is interrupted (Ctrl+C) mid-task, the next run detects uncommitted git changes and commits them before continuing:
- Lists changed files to the console (excluding `.devloop/` and `.claude/` files, which are DevLoop's own state files and not interrupted work)
- Commits the partial work with message: `DevLoop: Interrupted work on TASK-XXX - Task title`
- Claude then starts fresh with a clean working tree
- The partial work is preserved in git history and can be recovered if needed
- If commit fails, DevLoop stops and requires manual resolution (prevents inconsistent state)
- The exclusion filter in `getUncommittedChanges` matches paths with or without a leading dot (e.g., both `.devloop/` and `devloop/`) to handle cases where the git root differs from the workspace root

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

Timing data is collected in an `IterationTiming[]` array during the run (raw milliseconds), avoiding the need to parse formatted duration strings from progress.md. The `workDuration` and `verificationDuration` fields in progress.md are only populated when `--verify-each-task` is used; in the default consolidated mode, these are null since test suites are deferred.

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

The review only runs when genuinely all tasks are complete — not on partial stops (Q key, cost limit, iteration limit, API errors). When consolidated verification is enabled (the default), the review is additionally gated on verification passing. The `invoke` function is used (respects `overrides.invoker` for testing) and file opening is skipped during tests (via `skipStdin`/`skipOpen`).

### Task Timeout

Tasks have a configurable timeout (default: 150 minutes / 2h30m) via `--task-timeout <minutes>` CLI option or `DevLoopConfig.taskTimeout` (in milliseconds).

- When the timeout fires, the Claude child process is killed via `SIGTERM`
- The error is classified as `task_failure` (not `network_error`) so the task is retried rather than stopping the loop
- The `wasTimedOut` flag in `invokeClaudeAutomated` overrides the normal `classifyError` result, which would otherwise match "timeout" as a `network_error` and stop the loop

### Consolidated Verification

By default, DevLoop defers test suite execution to a consolidated phase after all tasks complete. Quick checks (type-checking, linting) still run per-task.

- **Default behavior**: Each task prompt tells Claude to run only quick checks (`tsc --noEmit`, linting) and skip test suites. After all tasks complete, a verification phase runs all test suites once.
- **Consolidation**: Multiple filtered test commands (e.g., `npm test -- --grep "calculator"` from TASK-001, `npm test -- --grep "parser"` from TASK-002) are consolidated into a single `npm test` run. Different test runners (npm test + pytest) each run once. Exception: long-running E2E suites (Playwright, Cypress, Selenium) are NOT consolidated into full suite runs — only the specific E2E test files relevant to completed tasks are run.
- **Fix/retry**: If tests fail, Claude identifies which task's changes likely caused the failure, fixes the code, and re-runs only the affected tests. Up to 3 fix cycles.
- **Final review gate**: The final code review only runs if consolidated verification passes or is skipped by the user. If verification fails, the review is skipped.
- **Skip with Q key**: During the verification phase, the user can press Q to skip verification. This immediately kills the entire Claude process tree (including any spawned test runners) via `taskkill /T` on Windows or `process.kill(-pid)` on Unix. The skip is logged to `progress.md` as "Consolidated verification skipped by user" and the final review proceeds normally. The `onSpawn` callback in `InvokeClaudeOptions` provides the kill function.
- **Opt-out**: Use `--verify-each-task` to run verification per-task instead of consolidated at end. Each task runs its own tests before completing (the pre-3.3 behavior). Can be set per-run or permanently:
  ```bash
  devloop run --verify-each-task              # Per-run flag
  devloop continue --verify-each-task         # Also works with continue
  devloop config set verifyEachTask true      # Persistent workspace setting
  ```
- **Logging**: Verification results are logged to `.devloop/logs/VERIFICATION.log` and recorded in `progress.md`.

### Parallel Task Execution

When multiple tasks are eligible to run (all dependencies met), DevLoop batches them into a single Claude invocation that uses the Agent tool to parallelize work.

- **Default behavior**: Up to 5 eligible tasks per batch. Claude analyzes file impact and runs non-conflicting tasks in parallel via agents, serializing conflicting tasks within the batch.
- **Single-task fallback**: When only 1 task is eligible, the existing single-task flow is used unchanged.
- **Batch prompt**: Instructs Claude to use the Agent tool, includes all task descriptions and verifications, and requires a structured `TASK_RESULT: TASK-XXX: SUCCESS/FAILED` output for DevLoop to parse per-task outcomes.
- **Result parsing**: `parseBatchResults()` in `claude.ts` extracts per-task success/failure from Claude's output. Tasks not mentioned are treated as failed.
- **Partial failure**: If some tasks succeed and others fail in a batch, successful tasks are marked done and failed tasks remain in-progress for retry on the next iteration.
- **One git commit per batch**: All changes from a batch are committed together, not per-task.
- **Progress logging**: A batch produces one `IterationLog` entry with comma-separated task IDs in `taskAttempted` and `taskCompleted` fields. `getCompletedTaskIds()` handles comma-separated values.
- **Batch logs**: Written to `.devloop/logs/BATCH-{iteration}.log` instead of per-task log files.
- **Configuration**:
  ```bash
  devloop run --max-parallel-tasks 3        # Reduce for this run
  devloop config set maxParallelTasks 2     # Persistent workspace setting
  ```
- **Q key during batch**: Graceful stop after the batch completes (same as single-task behavior).
- **Display consistency**: Batch output matches single-task output — each task's description and verification shown before execution, spinner with timer and activity during, per-task ✓/✗ results after, token breakdown and tool usage stats at the end.

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

DevLoop's auto-generated commits use one of two formats:

**Default (no `devloopCommitFormat` set): Conventional Commits.**
DevLoop builds messages itself in the form `{type}: {description}`. The type comes from each task's `Type` field; non-task commits (init, amend, review, verification, .gitignore) use `chore`. Failed/attempted/interrupted task commits also use `chore` (failed work shouldn't bump the version). Batch commits promote the highest-priority type from the succeeded tasks (priority order: feat > fix > perf > refactor > revert > build > ci > test > docs > style > chore) and list each task's individual type in the body. Tasks with a `Breaking` field add a `BREAKING CHANGE:` footer.

Example single-task commit:
```
feat: T14 - Add token tracking
```

Example batch commit:
```
feat: T1, T2, T3

- feat: T1 - Add token tracking
- fix: T2 - Handle CRLF in tasks.md
- chore: T3 - Update CLAUDE.md docs

BREAKING CHANGE: T1 changes the /v2 auth header
```

**Override (`devloopCommitFormat` is set): template substitution.**
The configured template is used verbatim with `{action}` replaced by a legacy action string ("Complete TASK-001 - Title", "Initialize workspace", etc.). Use this when your repo's commit hooks require a non-Conventional format.

```bash
devloop config set devloopCommitFormat "chore(devloop): {action}"
devloop config list  # Show current config
```

**Auto-detection**: During `devloop init`, commit hooks are auto-detected from commitlint, git hooks, and husky. When commitlint is detected, the user is informed that the new Conventional Commits default works out of the box; the user can still supply a custom format if needed.

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
- Archive and start next phase (informed by review) — CLAUDE.md references the archived review file path for Claude to read when planning the next phase

**When tasks are incomplete / in init phase:**
- Continue working on requirements (if in init phase or no tasks exist)
- Continue running tasks (with progress count, e.g., "5/12 done")
- Amend requirements and tasks (when at least one task is done — allows editing requirements.md and adding/modifying/removing pending tasks without affecting done/in-progress tasks). After amendments, the same Phase 4 self-review runs over the requirements diff and pending tasks; locked tasks are out of scope.
- Archive and start new requirements

**Always available:**
- Remove all DevLoop files — lists directories (`.devloop/`, `.claude/`) and warns about archived iterations, review docs, and logs before requiring explicit confirmation. Defaults to "no".

State detection uses `detectWorkspaceState()` which checks session phase, task counts, and `review.md` existence.

When archiving, the current `requirements.md`, `tasks.md`, `progress.md`, and `review.md` (if present) are copied to `.devloop/archive/iteration-{N}/` (directory naming uses "iteration" for backward compat), then all four files are deleted so the next phase starts fresh. Claude is spawned with prior work context to create new requirements and tasks.

**Prior context**: To avoid bloating the CLAUDE.md, the prior context includes only task titles (not full descriptions/verification steps). When the "informed by review" option is chosen, CLAUDE.md references the archived review file by path (`.devloop/archive/iteration-{N}/review.md`) rather than embedding its content, so Claude reads the current version from disk and context isn't bloated. `loadPriorContext()` in `core/archive.ts` loads requirements, tasks, progress, and review from the archive directory.

The `Session` type has an `iteration` field (1-based, defaults to 1 for backward compat) which represents the **phase** number — the requirements/planning cycle. User-facing displays use "Phase" (e.g., `devloop status` shows "Phase: 2 (1 previous phase(s) archived)") to distinguish from task attempts. The `lastIteration` field tracks task attempts within the current phase and is displayed as "Task attempts" in `devloop continue`. When `devloop run` creates a new session (`sessionAction: 'create'`), it reads the existing session's phase number and preserves it, so that archives from earlier phases are not overwritten.

**Session file handling**: Changes to `.devloop/` and `.claude/` are excluded from the uncommitted changes check that detects interrupted work, so they don't trigger false positives (e.g., `session.json` is commonly modified after each commit by DevLoop itself). The exclusion matches both `.devloop/` and `devloop/` paths. These files are still committed as part of regular iteration commits.

**Execution plan in `devloop status`**: When tasks remain, status shows an execution plan that walks the dependency graph level by level, showing which tasks will run as batches and which run solo. The first level ("next") is highlighted in bold cyan/white; subsequent levels ("then") are gray. The plan respects `maxParallelTasks` to determine batch sizes. If the project name in `tasks.md` already contains "iteration" or "phase", the phase suffix is omitted from the banner to avoid redundancy.

### Interactive Session Progress

All interactive Claude sessions (init, continue-requirements, amend-requirements) instruct Claude to use the `TodoWrite` tool at the start of the session to create a visible progress roadmap. Each session type has its own step list matching its workflow, including a self-review step before the final "exit session" item. Claude checks items off as it completes each phase, giving the user a clear sense of where the session is in the process.

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
- `createMockInvoker()` — configurable mock with per-task result overrides and call tracking. Recognizes task prompts (via `Task ID:`), batch prompts (`TASKS TO COMPLETE:`), review prompts (`final code review`), and verification prompts (`consolidated test verification`). For batch prompts, generates `TASK_RESULT` lines for each task in the batch.
- `createFailThenSucceedMock()` — mock that fails a task N times then succeeds (for retry testing). Also recognizes review, verification, and batch prompts

Integration tests in `test/integration.test.ts` cover the full lifecycle: task execution in dependency order, retry on failure, archive + new iteration (including a 3-phase test verifying archives survive across multiple iterations with `sessionAction: 'create'`), cost/iteration limits, API error handling, graceful shutdown, status data, final code review (creation, skipped on partial stop, archived correctly), and workspace cleanup.

### Test Coverage

`npm run test:coverage` runs tests with c8 and enforces minimum thresholds (75% lines, 75% functions, 70% branches). Coverage is configured in `.c8rc.json`:

- **Included**: All `src/**` files
- **Excluded**: CLI entry points (`index.ts`, `cli.ts`), command handlers (`commands/continue.ts`, `commands/init.ts`, `commands/config.ts`, `commands/run.ts`, `commands/status.ts`, `commands/workspace.ts`), type definitions (`types/index.ts`), and external-process-heavy modules (`core/git.ts`, `core/claude.ts`, `core/commit-format.ts`) — these are primarily wrappers around child process spawning that cannot be meaningfully unit tested

Pure logic functions extracted from process-heavy modules are exported and tested directly: `classifyError()`, `parseTokenUsage()`, `formatToolActivity()` from `claude.ts`; `isHookError()`, `parseGitStatusOutput()` from `git.ts`.
