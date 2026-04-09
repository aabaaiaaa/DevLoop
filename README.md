# DevLoop

Automate iterative development with Claude Code. DevLoop helps you break down projects into small tasks and automatically executes them in a loop using Claude.

![DevLoop in action](https://raw.githubusercontent.com/aabaaiaaa/DevLoop/master/images/example-devloop-usage-3.0.0.png)

## Why DevLoop?

DevLoop lets you build projects of any size in a fully unattended way — start a run before bed and wake up to a completed project. The scope of what it can build is limited only by the quality and detail of your requirements. Because each task runs in a fresh Claude context, there's no context window degradation over long runs.

> **Warning:** DevLoop runs Claude Code with `--dangerously-skip-permissions`, which allows Claude to execute commands, write files, and make changes without prompting for confirmation. This is required for unattended operation but means Claude has broad access to your system.
>
> **Mitigation:** DevLoop uses `--add-dir <workspace>` to restrict Claude's file operations to your workspace directory, and generates a `.claude/settings.json` with permission rules that block dangerous commands (including edits to `.devloop/` and `.claude/` directories). However, these are guardrails, not a sandbox. Review your `requirements.md` and `tasks.md` carefully before starting a long unattended run, and consider running in a VM or container for additional isolation.

## How It Works

1. **Define requirements** - Use an interactive Claude session to create a planning document (`requirements.md`) and a machine-parsed task list (`tasks.md`) with small tasks (~30 min each)
2. **Run the loop** - DevLoop picks the next task from `tasks.md`, spawns Claude to complete it, logs progress, and repeats
3. **Track progress** - View task status and iteration logs at any time

Each iteration runs in a fresh Claude context, so you get consistent behavior without context buildup.

## Installation

### From npm (recommended)

```bash
npm install -g claude-devloop
```

### From source

```bash
# Clone this repo, then:
npm install
npm run build
npm link
```

You may need `sudo npm link` (macOS/Linux) or run as Administrator (Windows) if you get permission errors.

### Verify Installation

```bash
devloop --version
devloop --help
```

## Uninstallation

```bash
npm uninstall -g claude-devloop
```

### Clean Up Config Files

DevLoop stores configuration in your home directory:

```powershell
# Windows - remove global config
rmdir /s /q %USERPROFILE%\.devloop
```

```bash
# macOS / Linux - remove global config
rm -rf ~/.devloop
```

Workspace files are stored in `.devloop/` and `.claude/` directories in each project directory. Use `devloop continue` → "Remove all DevLoop files" for safe cleanup with confirmation, or `rm -rf .devloop .claude` manually.

## Quick Start

```bash
# 1. Navigate to your project directory
cd C:\Projects\MyApp

# 2. Create requirements.md interactively with Claude
devloop init

# 3. Check your tasks
devloop status

# 4. Run the loop ($10 cost limit by default)
devloop run

# 5. Come back later and continue
devloop continue
```

## Tips for `devloop init`

When you run `devloop init`, DevLoop opens an interactive Claude session that guides you through a 3-phase planning process (discovery, requirements, tasks). Here's what to expect:

- **Claude will start by asking questions** — describe what you want to build, including any preferences for technologies, libraries, or approaches. Answer fully and don't rush; Claude needs to understand the full scope before writing anything.
- **Don't ask Claude to start building the project.** The init session is only for creating the requirements and task documents. Implementation happens later when you run `devloop run`. If Claude starts writing code or creating files, remind it to just write the requirements and tasks.
- **Discuss testing early.** Tell Claude how you'd like the project tested (unit, integration, e2e, specific frameworks). Claude will include verification steps in each task and run those tests automatically during implementation.
- **Review the task list before confirming.** Claude will propose a task list for your review. Ask it to split large tasks, reorder them, or add missing steps. Once you confirm, Claude writes the requirements and task files.
- **Exit when you're done** with Ctrl+C or `/exit`. DevLoop will commit the files and you can start running tasks.

## Commands

### `devloop init`

Starts an interactive Claude session that follows a 3-phase workflow: discovery (understanding your project), writing `.devloop/requirements.md` (a free-form planning document), and generating `.devloop/tasks.md` (the machine-parsed task list). Claude helps you break down your project into small, actionable tasks.

If `.devloop/requirements.md` already exists but no session has been created, the command will **adopt** the existing files and set up the necessary infrastructure (session, `.claude/` files, git commit).

```bash
devloop init                    # Use default/configured workspace
devloop init -w ./my-project    # Specify workspace
devloop init --force            # Overwrite existing requirements and reinitialize
```

**Behavior with existing files:**
- `.devloop/requirements.md` exists + no session → Adopts existing files, creates infrastructure
- `.devloop/requirements.md` exists + session exists → Prompts to use `continue` or `--force`
- No `.devloop/requirements.md` → Starts the 3-phase interactive Claude session

### `devloop run`

Executes tasks from `.devloop/tasks.md` in a loop. Each iteration:
1. Finds all eligible tasks (dependencies met). If 2+ are eligible, batches them into one Claude invocation using the Agent tool for parallel execution
2. Marks tasks as `in-progress` and spawns Claude
3. On success, marks tasks `done`; on failure, leaves as `in-progress` for retry
4. Logs the result to `.devloop/progress.md`
5. Repeats until all tasks done, cost limit reached, or max iterations reached
6. Runs consolidated test verification, then a final code review

```bash
devloop run                     # Run with defaults ($10 cost limit, 100 max iterations)
devloop run -i 5                # Limit to 5 iterations
devloop run -t 500000           # Stop when session tokens exceed 500k
devloop run -c 20               # Stop when session cost exceeds $20
devloop run --task-timeout 60   # Kill tasks after 60 minutes (default: 150)
devloop run --max-parallel-tasks 3  # Limit batch size (default: 5)
devloop run --verify-each-task  # Run tests per-task instead of consolidated at end
devloop run --verbose           # Verbose output (show Claude's raw output)
devloop run --dry-run           # Show what would run without executing
devloop run -w ./my-project     # Specify workspace
```

**Limits and ceilings:**
- Default cost limit: **$10** per session (override with `-c`)
- Default max iterations: **100** per session (override with `-i`)
- Hard ceilings: **$500** cost, **1000** iterations (cannot be exceeded)

### `devloop status`

Shows current progress, task list, and an **execution plan** that visualizes how tasks will be batched based on dependencies and `maxParallelTasks`.

```bash
devloop status                  # Human-readable output
devloop status --json           # JSON output for scripting
```

### `devloop continue`

The main hub for ongoing work after `devloop init`. Prompts you to choose:
- **Continue requirements** - Resume refining requirements with Claude
- **Continue run** - Resume task execution from where you left off
- **Archive and start new requirements** - Archive current iteration and plan the next phase (see [Iterations](#iterations))
- **Archive and start next phase (informed by review)** - Same as above, but Claude reads the review recommendations
- **Remove all DevLoop files** - Clean up `.devloop/` and `.claude/` with confirmation

```bash
devloop continue
devloop continue -i 20          # Continue run with 20 max iterations
devloop continue -t 500000      # Continue with token limit
devloop continue -c 20          # Continue with $20 cost limit
devloop continue --max-parallel-tasks 3  # Limit batch size
devloop continue --verify-each-task      # Per-task verification
```

### `devloop workspace`

View or set the default workspace directory.

```bash
devloop workspace               # Show current default
devloop workspace C:\Dev        # Set default workspace
```

## File Structure

DevLoop creates these files in your workspace:

```
my-project/
├── .devloop/
│   ├── requirements.md   # Free-form planning document (you + Claude create this)
│   ├── tasks.md          # Machine-parsed task list (generated from requirements)
│   ├── progress.md       # Iteration logs (auto-generated)
│   ├── review.md         # Final code review report (auto-generated when all tasks complete)
│   ├── session.json      # Session state, version tracking, crash recovery
│   ├── config.json       # Workspace config (commit format, etc.)
│   ├── debug.log         # Debug log for troubleshooting
│   ├── logs/             # Claude output logs
│   │   ├── TASK-001.log  # Full prompt + raw Claude output for single tasks
│   │   ├── BATCH-2.log   # Batch execution log (multiple tasks)
│   │   └── VERIFICATION.log  # Consolidated verification log
│   └── archive/          # Archived iterations (created by devloop continue)
│       └── iteration-1/
│           ├── requirements.md
│           ├── tasks.md
│           ├── progress.md
│           └── review.md
└── .claude/
    ├── CLAUDE.md         # Context for Claude (auto-generated)
    └── settings.json     # Claude permission rules (auto-generated)
```

Cleanup: `devloop continue` → "Remove all DevLoop files" for safe cleanup, or `rm -rf .devloop .claude` manually.

Global config is stored at `~/.devloop/config.json`.

## Task Format

`.devloop/requirements.md` is a free-form planning document — a narrative description of the project, its goals, architecture decisions, and constraints. It is not parsed by the task engine.

`.devloop/tasks.md` is the machine-parsed task list that DevLoop executes. Tasks follow this format:

```markdown
### TASK-001: Set up project structure
- **Status**: pending
- **Dependencies**: none
- **Description**: Initialize with package.json and tsconfig.json.
- **Verification**: Run `npm install` and `npx tsc --noEmit` successfully.

### TASK-002: Implement user authentication
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: Create login endpoint with JWT tokens.
- **Verification**: Run `npm test` and verify auth tests pass.
```

- **Status**: `pending`, `in-progress`, or `done`
- **Dependencies**: `none` or comma-separated task IDs (e.g., `TASK-001, TASK-002`)
- **Verification**: How to confirm the task is complete (e.g., test commands, expected output)

## Progress Indicators

DevLoop provides visual feedback during execution:

- **Terminal title**: Shows current task/batch and progress (e.g., "DevLoop: TASK-005 | 2/12 done")
- **Animated spinner**: Displays elapsed time and current tool activity (e.g., `Working: TASK-005 (2/12 done) - Reading file (1m 23s)`)
- **Task details**: Each task's description and verification printed before execution (for both single tasks and batches)
- **Tool usage stats**: After completion, shows a breakdown of tool calls and durations
- **Final status**: Terminal title updates to show completion status

## Graceful Shutdown

DevLoop supports graceful shutdown during task execution:

- **Press Q during tasks** (or type `q` + Enter in non-TTY terminals): Toggles graceful stop. First press requests stop after the current task/batch completes. Press Q again to cancel and continue normally. This lets you recover from accidental presses.
- **Press Q during verification**: Kills the Claude process tree immediately (including any spawned test runners) and skips verification. This is a one-way action (can't be undone since processes are killed). The final review still proceeds.
- **Ctrl+C**: Force stops immediately, killing the Claude process mid-task

A hint is shown before each task/batch and during the verification phase.

## Interrupted Work Recovery

If a task is interrupted (e.g., force Ctrl+C during execution), DevLoop detects and preserves partial work:

- **Detection**: At the start of each run, DevLoop checks for uncommitted git changes
- **Commit**: If uncommitted changes exist, they are committed with a message like `DevLoop: Interrupted work on TASK-001 - Task title`
- **Fresh start**: Claude then starts fresh with a clean working tree
- **Failure handling**: If the commit fails, DevLoop stops and provides instructions for manual resolution

The partial work is preserved in git history. If it was needed (and tests fail without it), you can recover it from the commit.

If DevLoop cannot commit the uncommitted changes (e.g., git configuration issues), it will stop and ask you to resolve manually using `git status`, then either commit or discard the changes before running `devloop continue`.

## Commit Message Format

DevLoop commits use a configurable format with an `{action}` placeholder that gets replaced with what DevLoop did.

- **Default format**: `DevLoop: {action}`
- **Example actions**: "Initialize workspace", "Complete TASK-001 - Fix bug", "Attempted TASK-002 - Add feature"

**Auto-detection during init**: When you run `devloop init`, DevLoop detects commit hooks (commitlint, husky, git hooks). If hooks are found, you're prompted for a commit message format.

**Manual configuration**:

```bash
devloop config set devloopCommitFormat "chore(devloop): {action}"
devloop config set verifyEachTask true     # Per-task verification
devloop config set maxParallelTasks 3      # Limit batch size
devloop config get devloopCommitFormat     # Show a specific config value
devloop config list                        # Show all config
devloop config unset devloopCommitFormat   # Remove a config value
```

**Hook failure handling**: If a commit fails due to a hook, DevLoop displays the error, prompts you for a valid commit message (with `{action}` placeholder), retries, and saves the format for future commits.

## Safety

When running automated tasks, DevLoop restricts Claude to your workspace:

- Uses `--add-dir <workspace>` to limit file operations
- Prompts explicitly state workspace boundaries
- Dangerous commands (rm -rf /, sudo, etc.) are blocked in settings
- `.devloop/` and `.claude/` directories are deny-listed, preventing Claude from editing DevLoop's own files during automated runs

## Token Tracking

DevLoop tracks API token usage across iterations:

- **Per-iteration tracking**: Each iteration logs input tokens, output tokens, and cost
- **Cumulative display**: After each task, shows running total of tokens used
- **Token limits**: Use `-t, --token-limit` to stop before exceeding a token threshold
- **Cost limits**: Default **$10** per session (override with `-c`), hard ceiling **$500**
- **Iteration limits**: Default **100** per session (override with `-i`), hard ceiling **1000**
- **Status display**: `devloop status` shows total tokens and cost for the project

Token data is stored in `.devloop/progress.md` and persists across sessions.

## Run Statistics

When a run completes, DevLoop displays a statistics summary:

- **Duration**: Total wall-clock time and average time per successful task
- **Longest/shortest tasks**: Identifies which tasks took the most and least time
- **Failure analysis**: Shows which tasks failed, how many attempts each took, and whether they were eventually completed
- **Error breakdown**: Counts by error type (task_failure, rate_limit, etc.)
- **Cost summary**: Session total and average cost per task

## Task Logs

Each task's full Claude interaction is saved for debugging and review:

- **Single tasks**: `.devloop/logs/TASK-XXX.log`
- **Batches**: `.devloop/logs/BATCH-{iteration}.log`
- **Verification**: `.devloop/logs/VERIFICATION.log`

Each log includes the prompt sent to Claude, raw stream-json output, and the final result text. Logs are overwritten on retry.

## Final Code Review

When all tasks complete, DevLoop automatically runs one final Claude invocation to review the entire project. The review report (`.devloop/review.md`) covers:

- **Requirements vs implementation** — gaps, partial implementations, scope creep
- **Code quality** — bugs, error handling, security concerns
- **Testing** — coverage adequacy, untested edge cases
- **Recommendations** — what to improve before production
- **Future considerations** — next features, tech debt, architectural notes

The report is automatically opened for the developer to read. It is committed to git and archived with other iteration files when starting a new iteration.

The review only runs when all tasks are genuinely complete and verification has passed (or been skipped).

## Consolidated Verification

By default, DevLoop defers test suite execution to a single consolidated phase after all tasks complete. Quick checks (type-checking, linting) still run per-task.

- **How it works**: Each task prompt tells Claude to skip test suites. After all tasks complete, a verification phase runs all test suites once, consolidating overlapping commands (e.g., multiple filtered `npm test` commands become one `npm test` run).
- **E2E tests**: Long-running E2E suites (Playwright, Cypress, Selenium) are NOT consolidated into full suite runs — only the specific test files relevant to completed tasks are run.
- **Fix/retry**: If tests fail, Claude identifies which task's changes caused the failure, fixes the code, and re-runs only the affected tests. Up to 3 fix cycles.
- **Skip with Q**: Press Q during verification to kill the test processes and proceed to the final review.
- **Per-task mode**: Use `--verify-each-task` to run verification per-task instead (the pre-v3.3 behavior).

```bash
devloop run --verify-each-task              # Per-run opt-out
devloop config set verifyEachTask true      # Persistent opt-out
```

## Parallel Task Execution

When multiple tasks are eligible (all dependencies met), DevLoop batches them into a single Claude invocation. Claude uses the Agent tool internally to run non-conflicting tasks in parallel.

- **Default**: Up to 5 tasks per batch. Claude analyzes file impact and serializes tasks that touch the same files.
- **Single-task fallback**: When only 1 task is eligible, the existing single-task flow is used.
- **Partial failure**: If some tasks succeed and others fail in a batch, successful tasks are marked done and failed tasks retry.
- **Execution plan**: `devloop status` shows a dependency-level visualization of how tasks will be batched.

```bash
devloop run --max-parallel-tasks 3          # Reduce batch size
devloop config set maxParallelTasks 2       # Persistent setting
```

## API Error Handling

DevLoop automatically detects and handles API-level errors:

- **Rate limits** (400/429): Stops the loop and displays the error message
- **Authentication errors** (401): Stops and prompts to check credentials
- **API overload** (503): Stops and suggests retrying later
- **Network errors**: Stops on connection failures

Task failures (Claude ran but couldn't complete the task) continue to the next iteration, as a future attempt may succeed.

When `devloop status` is run after a failure, it displays:
- Error type (rate_limit, auth_error, etc.)
- Error summary and detailed message
- Timestamp of the failure

## Iterations

DevLoop supports iterating on your project through multiple requirement phases. After completing your initial tasks, use `devloop continue` to start a new iteration:

1. **Archive current work** - Requirements, tasks, and progress are saved to `.devloop/archive/iteration-{N}/`
2. **Plan next phase** - Claude opens with context about what was built, helping you plan the next set of requirements and tasks
3. **Run again** - Execute the new tasks with `devloop run`

```bash
# After all tasks complete (or whenever you want a fresh set of requirements):
devloop continue
# Choose option 3: "Archive and start new requirements"

# Check your new tasks
devloop status

# Run the new iteration
devloop run
```

The archive option is always available — even if tasks remain incomplete. DevLoop will warn you and ask for confirmation before archiving unfinished work.

`devloop status` shows the current iteration number and how many previous iterations are archived.

## Dependencies

DevLoop has a minimal dependency footprint for supply chain transparency.

### Production Dependencies (shipped to users)

| Package | Version | Sub-deps | Purpose |
|---------|---------|----------|---------|
| [chalk](https://www.npmjs.com/package/chalk) | ^5.4.0 | 0 | Terminal color output |
| [commander](https://www.npmjs.com/package/commander) | ^13.0.0 | 0 | CLI argument parsing |

**Total: 2 packages** with zero transitive dependencies. No native modules, no post-install scripts, no network access.

The animated spinner (`src/core/spinner.ts`) is a built-in implementation with no external dependencies.

### Dev Dependencies (not shipped)

| Package | Purpose |
|---------|---------|
| @types/node | TypeScript type definitions |
| c8 | Test coverage reporting and threshold enforcement |
| typescript | TypeScript compiler (build time) |
| tsx | TypeScript execution for dev/test |

## Requirements

- Node.js >= 20.0.0
- [Claude Code CLI](https://claude.ai/code) installed and authenticated
