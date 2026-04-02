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
                    parser/tasks.ts (parse tasks, find available tasks)
                              ↓
                    core/worktree.ts (create/merge worktrees, parallel mode)
                              ↓
                    parser/progress.ts (log iteration)
```

### Key Abstractions

- **Workspace**: A directory containing `.devloop/` (with `requirements.md`, `tasks.md`, `progress.md`, `session.json`) and `.claude/` (with `CLAUDE.md`, `settings.json`). Resolved via: CLI flag → global config → cwd.
- **Session**: Persisted state in `.devloop/session.json` tracking phase (`init`/`run`), iteration count, the DevLoop version that created it (`devloopVersion`), and `activeTasks: ActiveTask[]` for parallel-mode crash recovery (backward compat: also writes `activeTask` for the first task).
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

Task selection (`getNextTask`) returns the next task to work on:
1. In-progress tasks first (interrupted work that needs retrying)
2. Then pending tasks, sorted by task ID
3. Only pending tasks whose dependencies are all `done` are eligible

For parallel execution, `getAvailableTasks(taskList, excludeIds)` returns ALL tasks whose dependencies are met and that aren't currently being worked on.

When a task was previously interrupted (in-progress with an existing progress log), Claude receives context about the previous attempt so it can build on partial work rather than starting from scratch.

During execution, tasks transition: `pending` → `in-progress` (before Claude starts) → `done` (on success). On failure, tasks stay `in-progress` so they are retried next iteration. If the run is stopped gracefully (Q key) mid-task and Claude succeeds, the task is marked `done`.

### Parallel Execution

When git is available and `maxWorkers > 1` (default 5, ceiling 20, configurable via `--max-workers`), DevLoop runs multiple Claude instances simultaneously using git worktrees for file isolation. The parallel git config (`gc.auto=0`, `core.longpaths=true`) is only applied when `maxWorkers > 1`.

**Worker Pool Pattern**: The loop uses a continuous event-loop (`while` loop with `Promise.race`) rather than batched waves. As each worker completes and merges, newly unblocked tasks start immediately. Concurrency is dynamic — limited by the dependency graph and the `maxWorkers` cap. If no workers are active and no tasks are available (all remaining have unmet dependencies), the loop detects a deadlock and stops, listing the blocked tasks.

**Git Worktrees**: Each parallel task gets its own worktree (`.worktrees/T001`, `.worktrees/T003`, etc.) branching from current HEAD. Worktrees share the `.git` object store but have independent working trees. The prompt's workspace path and Claude's `--add-dir` flag both point to the worktree path, so Claude operates entirely within the isolated worktree.

**Merge Strategy**: After a worker completes successfully, the merge is processed on the main workspace (serialized via `mergeMutex`):
1. `git merge --no-commit --no-ff devloop/TASK-XXX` on main
2. Restore `.devloop/` and `.claude/` from HEAD via a triple-step process: `checkout HEAD --`, `reset HEAD --`, `checkout --` (handles both modified and newly-created files in those directories)
3. Run the task's verification command on the merged code (catches semantic conflicts where git merge succeeds but code is broken)
4. If merge + verification pass: `git commit` with the task completion message
5. If merge conflicts or verification fails: `git merge --abort` then `git reset --hard HEAD`

Merges are serialized via an async mutex — only one merge at a time.

**Merge Conflict Recovery**: On merge failure or post-merge verification failure:
1. Capture the diff: `git diff HEAD...devloop/TASK-XXX -- . ':!.devloop' ':!.claude'` (excludes DevLoop-managed files)
2. Store the diff in a `priorDiffs` map and increment the task's `mergeFailureCounts` counter
3. Mark the task back to `pending` for re-queue
4. Next time the task is picked up, `buildTaskPrompt` receives the diff via `priorDiff` option, which adds a "PRIOR ATTEMPT" section to the prompt instructing Claude to reapply the changes to the updated codebase
5. After 2 merge failures for the same task, it runs sequentially on the main workspace (no worktree) to guarantee no merge conflicts

**Concurrency Safety**:
- `gc.auto=0` and `core.longpaths=true` configured at run start (only when `maxWorkers > 1`)
- File writes (`tasks.md`, `progress.md`) protected by `fileMutex` (`AsyncMutex` in `core/mutex.ts`)
- Merge operations protected by `mergeMutex` (separate from `fileMutex`)
- `.worktrees/` added to `.gitignore`
- Stale worktrees cleaned up at start of each run via `git worktree prune` and deletion of orphaned `devloop/*` branches
- Session tracks `activeTasks: ActiveTask[]` for crash recovery, updated after each worker starts and each worker completes
- When `isParallel` is true (other workers active), the prompt includes a note: "Other tasks may be running concurrently. Focus only on your assigned task."

**Sequential Fallback**: When git is not available, `maxWorkers` is 1, or `skipWorktrees` override is set, the loop runs one task at a time using the main workspace directly (no worktrees). Tasks that fail to merge twice also fall back to sequential execution on the main workspace.

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

In parallel mode, each worktree gets its own `.claude/settings.json` generated with the worktree path (not the main workspace path), so the deny rules and `--add-dir` scope are correctly set for the worktree directory.

### Progress Indicators

The run loop provides visual feedback:
- **Terminal title**: Updated via ANSI escape sequence (`\x1b]0;TITLE\x07`) to show active workers and progress
- **Spinner**: Built-in spinner (`core/spinner.ts`) shows active tasks and completion status
- **Parallel format**: `Working: TASK-001, TASK-003 (2 active, 4/10 done)`
- **Terminal title format**: `DevLoop: {active} active | {completed}/{total} done`

### Graceful Shutdown

The run loop uses **stdin keypresses** (not SIGINT) for graceful shutdown, avoiding the problem of SIGINT propagating to the child Claude process and killing it mid-task:

- **Q key**: Sets `stopRequested` flag. The spinner is paused and a persistent `>> Graceful stop requested` message is displayed via `stopAndPersist`, then the spinner resumes. In parallel mode, the loop stops spawning new workers and waits for ALL active workers to complete via `Promise.allSettled`. Completed workers that succeeded are merged back to main. If merges succeed, the tasks are marked as done; work is not lost. The `activeSpinner` module-level variable gives the `onData` handler access to the spinner so the message is visible immediately (plain `console.log` gets overwritten by spinner redraws).
- **Ctrl+C**: Force stop. In raw mode this is handled as a keypress (`\x03`), calling `process.exit(1)`. This kills everything including all Claude child processes.

When stdin is a TTY, raw mode (`setRawMode(true)`) is used so keypresses arrive immediately. On Windows (especially Git Bash/mintty), stdin may not be detected as a TTY; in that case a line-buffered fallback is used (`q` + Enter). Raw mode is defensively re-enabled after each child process spawn, since spawning `cmd.exe` on Windows can reset the console input mode.

### Interrupted Work Recovery

If a run is interrupted (Ctrl+C) mid-task, the next run detects uncommitted git changes and commits them before continuing:
- Lists changed files to the console
- Commits the partial work with message: `DevLoop: Interrupted work on TASK-XXX - Task title`
- Claude then starts fresh with a clean working tree
- The partial work is preserved in git history and can be recovered if needed
- If commit fails, DevLoop stops and requires manual resolution (prevents inconsistent state)

In parallel mode, stale worktrees from crashed runs are also cleaned up at the start of each run via `cleanupStaleWorktrees()` which runs `git worktree prune` and deletes orphaned `devloop/*` branches.

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

### API Error Classification

Errors from Claude CLI are classified in `core/claude.ts`:

- **rate_limit**: 400/429 errors, "api usage limit" messages
- **api_overload**: 503 errors, "overloaded" messages
- **auth_error**: 401 errors, "unauthorized" messages  
- **network_error**: Connection refused, timeout, DNS failures
- **task_failure**: Claude ran but task didn't complete (not an API error)
- **unknown**: Unclassified API errors

API errors (all except `task_failure`) stop the loop. In parallel mode, when an API error is detected the loop stops spawning new workers and waits for active workers to finish before exiting. Task failures continue to the next iteration (the task remains in-progress for retry).

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

DevLoop supports iterating on requirements through `devloop continue`:
- **Option 1**: Continue working on current requirements (refine with Claude)
- **Option 2**: Continue running tasks
- **Option 3**: Archive and start new requirements (creates a new iteration)

When archiving, the current `requirements.md`, `tasks.md`, `progress.md`, and `review.md` (if present) are copied to `.devloop/archive/iteration-{N}/`, then tasks, progress, and review are deleted so the next iteration starts fresh. Claude is spawned with prior work context to create new requirements and tasks.

**Prior context optimization**: To avoid bloating the CLAUDE.md with large task lists, the prior context includes only task titles (not full descriptions/verification steps). Progress summaries are excluded entirely — Claude only needs the requirements and task names to understand what was built.

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
- **`skipGit`**: Skips `ensureGitRepo()`, `commitIteration()`, `commitInterruptedWork()`, and `getUncommittedChanges()` — also disables parallel worktree execution since worktrees require git
- **`stopAfterIterations`**: Sets `stopRequested = true` after N iterations complete — simulates Q key press for testing graceful shutdown behavior
- **`maxWorkers`**: Overrides `config.maxWorkers` for test predictability
- **`skipWorktrees`**: Forces sequential execution even when git is available — bypasses worktree creation/merge

Production behavior is unchanged when `overrides` is undefined.

Test fixtures in `test/fixtures/calculator.ts` provide:
- `createCalculatorWorkspace()` / `createPhase2Tasks()` — set up a calculator project with tasks, dependencies, and session
- `createMockInvoker()` — configurable mock with per-task result overrides and call tracking
- `createFailThenSucceedMock()` — mock that fails a task N times then succeeds (for retry testing)

Integration tests in `test/integration.test.ts` cover the full lifecycle: task execution in dependency order, retry on failure, archive + new iteration, cost/iteration limits, API error handling, graceful shutdown, status data, and final code review (creation, skipped on partial stop, archived correctly).
