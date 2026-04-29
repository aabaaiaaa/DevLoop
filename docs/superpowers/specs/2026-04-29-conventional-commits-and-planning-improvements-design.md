# Conventional Commits and Planning Improvements

**Date:** 2026-04-29
**Status:** Draft

## Summary

Make Conventional Commits the default commit format for DevLoop's auto-generated commits, so its history feeds standard semver tooling (semantic-release, standard-version) cleanly. Add a `Type` and optional `Breaking` field to tasks in `tasks.md` so each commit gets the correct conventional type. Encourage finer-grained task decomposition during planning. Add a self-review pass to the init and amend phases that catches inconsistencies, missing dependencies, and ambiguities before tasks reach the run loop.

## Motivation

Today, DevLoop's default commit format is `DevLoop: {action}`, which doesn't fit any semver release tooling. Users who already use Conventional Commits in their own work (`feat:`, `fix:`, `chore:`) get a mixed history when DevLoop runs. The user can override the format via `devloopCommitFormat`, but a single template applies to every action — so even a custom `chore(devloop): {action}` types every commit as `chore`, which means no semver bumps regardless of what the task actually did.

Two adjacent improvements ride along:

1. **Task granularity.** The current init prompt frames task size purely as a timeout-avoidance concern ("10–20 minutes"), which can lead Claude to bundle multiple distinct concerns into a single task to keep counts low. Long-running DevLoop sessions are normal and expected — task count is not a thing to minimize. Finer-grained decomposition also produces better-typed commits.
2. **Self-review of generated docs.** Today, requirements.md and tasks.md are written once and committed. Inconsistencies (e.g., a dependency on a task that doesn't exist) only surface when the run loop trips on them.

## Design

### 1. Conventional Commits as default

The behavioural rule is a single switch keyed on whether the user has set `devloopCommitFormat`:

| `devloopCommitFormat` | Behaviour |
| --- | --- |
| Not set | DevLoop builds a Conventional Commits message itself |
| Set | User's template is used exactly as today (escape hatch for repos with custom hook conventions) |

No new config key is added. Existing workspaces that already have `devloopCommitFormat` set are unaffected. Existing workspaces without it switch from `DevLoop: {action}` to `chore: {action}` (or `feat:`/`fix:` once their tasks are regenerated with `Type` fields).

The init flow's existing commit-hook detection continues to work. When commitlint is detected, the user-facing CLI prompt that asks for a commit format mentions that Conventional Commits is the new default and works out of the box; the user can still supply a custom format if they want.

### 2. Task schema additions

Two new optional fields in each task entry in `tasks.md`:

```markdown
### TASK-014: Add token tracking
- **Status**: pending
- **Type**: feat
- **Dependencies**: TASK-001
- **Description**: ...
- **Verification**: ...
- **Breaking**: New API requires auth header on /v2 endpoints
```

**`Type`** — one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Unknown values: warn during parsing and fall back to `chore`
- Missing field: default to `chore` (safe — no semver bump for legacy tasks created before this change)

**`Breaking`** — free-text description of what breaks. The text is used verbatim as the body of a `BREAKING CHANGE:` footer. Absent → no footer. Multiple tasks in one commit (batch) with `Breaking` set produce multiple footer lines.

The `Type` field is parsed in `src/parser/tasks.ts`. The task regex stays as-is; the field-extraction logic gets new branches for `Type` and `Breaking`.

### 3. Subject formatting

Helper `formatTaskIdShort(taskId)` strips leading zeros and preserves the letter suffix:
- `TASK-001` → `T1`
- `TASK-014` → `T14`
- `TASK-001a` → `T1a`

Subject format by situation:

| Situation | Subject |
| --- | --- |
| Single completed task | `feat: T14 - Add token tracking` |
| Single attempted/failed task | `chore: T14 (attempted) - Add token tracking` |
| Interrupted task | `chore: T14 (interrupted) - Add token tracking` |
| Init | `chore: Initialize workspace` |
| Amend requirements | `chore: Amend requirements (phase 2)` |
| Batch of N tasks | `feat: T1, T2, T3` (titles in body) |

The `(attempted)` / `(interrupted)` parenthetical markers are preserved because otherwise an attempted-feat (committed as `chore`) and a completed-chore look identical in the subject, and the distinction matters when reading the log.

No scope is included in the subject (`feat:`, never `feat(scope):`). No `feat!:` exclamation style — breaking changes are signalled exclusively via the `BREAKING CHANGE:` footer.

### 4. Per-action type rules

| Action | Type used in subject |
| --- | --- |
| Single task **completed** | task's `Type` field |
| Single task **attempted/failed** | `chore` (failed work shouldn't bump version) |
| **Interrupted** work | `chore` |
| **Initial** commit (`devloop init`) | `chore` |
| **Amend requirements** | `chore` |
| **Iteration / batch** of N completed tasks | highest-priority type (see below) |

### 5. Batch commit handling

Batch commits cover multiple tasks committed together (one git commit per batch is an existing constraint — see CLAUDE.md). The subject's type is determined by promoting the highest-priority type present in the batch:

`feat > fix > perf > refactor > revert > build > ci > test > docs > style > chore`

Rationale: the subject line is what semver tooling reads to decide the version bump. A batch containing one `feat` and one `chore` must surface `feat:` in the subject or the minor bump is missed. Beyond `feat`/`fix`/`perf` (which have direct semver consequences), the rest of the priority order is cosmetic — but a batch of pure `docs` commits reading as `docs:` is more accurate than collapsing to `chore:`. Users who want strict per-task type accuracy can set `maxParallelTasks: 1`.

### 6. Body and footer formatting

**Single-task commits** have no body unless `Breaking` is set:

```
feat: T14 - Add token tracking

BREAKING CHANGE: New API requires auth header on /v2 endpoints
```

**Batch commits** include a body listing each task's individual type, ID, and title, plus any breaking footers:

```
feat: T1, T2, T3

- feat: T1 - Add token tracking
- fix: T2 - Handle CRLF in tasks.md
- chore: T3 - Update CLAUDE.md docs

BREAKING CHANGE: T1 changes the /v2 auth header
```

If multiple tasks in a batch have `Breaking` set, each produces its own `BREAKING CHANGE:` footer line.

### 7. Task decomposition guidance

The init and amend prompts get reframed guidance on task granularity. Today the relevant line in `src/commands/init.ts` (around line 129) says tasks should be small primarily to avoid timeouts. The new framing:

- Long-running DevLoop sessions are normal and expected. Task count is not a thing to minimize.
- Prefer logical decomposition over bundling. If a task touches multiple distinct concerns (schema + parser + tests + docs), split it into separate tasks tied by dependencies rather than packing them together.
- Use letter suffixes (`TASK-001a`, `TASK-001b`) when a parent concept needs sub-steps that are tightly coupled.
- The 10–20 minute size hint stays as a *floor* for timeout avoidance, but with explicit removal of any implicit pressure to keep totals low.

The same guidance is added to the amend prompt's "Add new tasks" section and to the task format documentation in CLAUDE.md.

### 8. Self-review loop on generated docs

A new final phase in the init Claude session (Phase 4) and the equivalent point in the amend session. Review happens inside the same Claude session — same context, no extra invocation.

**What's checked.** Claude is instructed to look for:

*Major (auto-fix and re-review):*
- Inconsistencies between `requirements.md` and `tasks.md` (e.g., requirements mention an SQLite migration but no task addresses it)
- Internal contradictions (one section says "use Postgres", another says "use SQLite")
- Missing or broken dependencies (`TASK-005` depends on `TASK-004` that doesn't exist)
- Circular dependencies in the task graph
- Non-sequential or duplicate task IDs
- Tasks missing required fields (`Verification`, `Description`, `Type`)
- Scope drift (tasks doing things requirements don't describe, or vice versa)

*Minor (report to user):*
- Ambiguous or under-specified wording where multiple reasonable interpretations exist
- Tasks that could be decomposed further (granularity opinion)
- Ordering choices that could go either way
- Optional features that may be over-scoped

**Loop bound.** Up to 3 review passes. After each pass:
- If majors found → fix and re-review
- If only minors → exit loop, list minors for user
- If pass 3 still has unresolved majors → demote them to a "couldn't auto-resolve" list shown to the user (don't oscillate further)

**User interaction.** When the loop converges, Claude prints something like:

```
Self-review complete after N pass(es).

Minor issues for your review:
1. TASK-007 description doesn't specify whether retries should be exponential or fixed-interval
2. Could TASK-012 be split into separate "schema" and "migration" tasks?

You can ask me to address any of these, or exit (Ctrl+C) to accept as-is.
```

The user can iterate inline or exit and let DevLoop commit. No new DevLoop UI is required — it's all prompt-driven inside the existing Claude session.

**Amend phase.** Same self-review runs at the end of amend. Scope is limited to the requirements diff and pending tasks; locked tasks (done, in-progress) are not reviewed because they can't be changed.

**TodoWrite roadmap.** The init and amend session todo lists (see CLAUDE.md "Interactive Session Progress") get a "Self-review the documents" item so the progress is visible.

## Backward compatibility

- Workspaces with `devloopCommitFormat` set: unchanged.
- Workspaces without `devloopCommitFormat`: switch from `DevLoop: {action}` to Conventional Commits format. Tasks without a `Type` field default to `chore` (no semver bump), so legacy tasks don't trigger spurious version changes.
- Tasks created before this change have no `Type` or `Breaking` fields. Parsing accepts their absence and treats them as `chore` / no breaking change. No migration is needed; the user can amend tasks to add types when they want.
- No new config keys are added. No breaking changes to existing config.

## Implementation areas

- `src/types/index.ts` — add `Task.type` (one of the 11 conventional types), `Task.breakingChange` (string | null).
- `src/parser/tasks.ts` — extract `Type` and `Breaking` fields. Validate type against the whitelist; warn and fall back to `chore` for unknowns.
- `src/core/git.ts` — `formatDevloopCommit()` becomes context-aware, taking optional task metadata. New helper `buildConventionalMessage()` constructs subject + body + footers from task data. New helper `formatTaskIdShort()` for the `T1` format.
- `src/core/loop.ts` — pass task metadata (single task or batch) to commit functions. The commit call sites need to know which task(s) the commit covers so types can be looked up. Affects `commitIteration`, `commitInterruptedWork`.
- `src/commands/init.ts` — add Phase 4 self-review instructions to the init prompt; reframe task granularity guidance; document `Type` and `Breaking` fields in the task format section of the prompt; update the TodoWrite roadmap to include self-review.
- `src/commands/continue.ts` — same self-review additions in the amend-requirements path; same granularity reframing; same TodoWrite update.
- `src/commands/config.ts` — update help text for `devloopCommitFormat` to describe the new default behaviour when unset.

## Testing

Unit tests:
- `formatTaskIdShort()`: `TASK-001` → `T1`, `TASK-014` → `T14`, `TASK-001a` → `T1a`.
- `Type` field parsing: valid types pass through; unknown types warn and fall back to `chore`; missing field defaults to `chore`.
- `Breaking` field parsing: free-text body captured; absent → null.
- Conventional message construction:
  - Single completed task with each type
  - Single attempted/failed task → `chore` regardless of task type
  - Single interrupted task → `chore` with `(interrupted)` marker
  - Init / amend → `chore` with appropriate action text
  - Batch with mixed types → highest-priority type promoted to subject; body lists each task
  - Single task with `Breaking` → `BREAKING CHANGE:` footer present
  - Batch with multiple `Breaking` tasks → multiple footer lines
- Type priority resolution: every adjacent pair in the priority list (feat > fix, fix > perf, …, style > chore).
- `devloopCommitFormat` override: when set, the template is used unchanged; when unset, the conventional path is used.

The self-review loop is prompt-driven and not unit-testable directly. The integration tests in `test/integration.test.ts` continue to use mocked Claude invokers, so the prompt change doesn't break those tests; an integration test can verify that the init prompt includes the Phase 4 instructions.

## Documentation updates

- `CLAUDE.md`:
  - "Init Behavior" section: add Phase 4 self-review.
  - "Document Formats" section: document `Type` and `Breaking` fields in the task format.
  - "Commit Message Format" section: rewrite to explain the new default and the `devloopCommitFormat` override.
  - "Iterative Requirements" / amend section: mention the self-review at the end of amend.
  - "Interactive Session Progress" section: mention the self-review todo item.
- `README.md`: short note on the new conventional commits default and the `Type` / `Breaking` task fields.
- `src/commands/config.ts` help text: update `devloopCommitFormat` description.

## Versioning

Minor version bump. This is a feature addition with backward-compatible defaults — no breaking config changes, existing workspaces continue to work.

## Out of scope

- Per-task scope in commit subjects (`feat(parser):`). Could be added later as an optional `Scope` field on tasks if demand emerges.
- Splitting batch commits into per-task commits. The existing one-commit-per-batch constraint stands; users who want strict per-task type accuracy can set `maxParallelTasks: 1`.
- Auto-classification of `Type` from task descriptions at commit time (option C from the design discussion). Type comes from the schema, written during init/amend.
- Migration of existing workspaces' commit history. Only future commits use the new format.
- Custom type whitelists (e.g., adding `wip` or project-specific types). The 11 standard types are fixed.
