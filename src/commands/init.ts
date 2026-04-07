import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import chalk from 'chalk';
import { resolveWorkspace, getRequirementsPath, readWorkspaceConfig, writeWorkspaceConfig } from '../core/config.js';
import { createSession, readSession } from '../core/session.js';
import { spawnClaudeInteractive } from '../core/claude.js';
import { requireClaudeInstalled, promptUser, printBanner } from './shared.js';
import { detectCommitFormat } from '../core/commit-format.js';
import { ensureGitRepo, gitCommit, saveDevloopCommitFormat, getDevloopCommitMessage } from '../core/git.js';

export interface PriorContext {
  iterationNumber: number;
  requirements: string | null;
  tasks: string | null;
  progress: string | null;
  review?: string | null;
}

export function generateWorkspaceClaudeMd(workspace: string, priorContext?: PriorContext): string {
  const platform = os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'macOS' : 'Linux';
  const reqPath = path.join(workspace, '.devloop', 'requirements.md');
  const tasksPath = path.join(workspace, '.devloop', 'tasks.md');

  let content = `# CLAUDE.md

This file provides guidance to Claude Code when working in this workspace.

## Environment

- **Platform**: ${platform}
- **Workspace**: ${workspace}
${platform === 'Windows' ? '- Use Windows-compatible commands (e.g., use backslashes in paths, no Unix-specific commands)\n' : ''}
## Current Task

You are helping the user plan their project. This happens in three phases.

**IMPORTANT: Do NOT implement the project. Do NOT write code, create source files, install packages, or build anything. Your ONLY job right now is to plan and write the requirements and task list. The actual implementation will happen later in a separate automated process.**

---

### Phase 1 — Discovery (do NOT write any files)

**IMPORTANT: Use the AskUserQuestion tool whenever you need the user to make a choice or decision.** This includes both technical choices and design decisions. Only use free-form conversation for open-ended discovery questions where multiple-choice doesn't make sense.

Start by asking the user to describe their project in their own words. Understand:

- What does the project do? Who uses it?
- What are all the features and how do they connect?
- What are the user flows end-to-end?
- What does "done" look like — what are the success criteria?
- Are there any edge cases or failure modes to handle?

Use natural conversation for open-ended questions — let the user explain freely and ask follow-up questions.

For standard technical choices, use the **AskUserQuestion tool** to present options rather than asking open-ended questions. These include things like:

- Language/runtime (TypeScript, Python, Go, etc.)
- Framework (React, Express, FastAPI, etc.)
- Testing approach (unit, integration, e2e) and framework (Jest, Vitest, pytest, etc.)
- Package manager, build tools, linting
- Database, auth strategy, deployment target

Present sensible defaults based on what you've learned about the project. The user can always pick "Other" to specify something different.

Once discovery feels complete, review the full picture before moving to Phase 2:

- Flag any inconsistencies between features (e.g., conflicting requirements, missing glue between components)
- Identify gaps — features that were mentioned but not fully explored
- Check that the technical choices work together coherently
- Present your findings to the user and resolve any issues before proceeding

Iterate until the user is satisfied with the plan.

**Do NOT write any files during Phase 1.**

---

### Phase 2 — Write requirements.md (when user confirms the plan)

When the user says the plan is ready, write a detailed, human-readable requirements document to \`${reqPath}\`.

This document should be a **narrative planning document** — NOT a task list. Write it in free-form markdown with sections, descriptions, technical decisions, and context. This is the reference document that developers (and Claude during implementation) will read to understand what needs to be built and why.

Include things like: feature descriptions, user flows, technical approach, testing strategy, edge cases, dependencies, and any decisions made during discovery.

**Do NOT include task format (TASK-001, etc.) in this file.** That comes in Phase 3.

---

### Phase 3 — Generate tasks.md (after requirements.md is written)

After writing requirements.md, convert the plan into a structured task list at \`${tasksPath}\`.

Each task should reference the requirements document for full context. The task format is:

\`\`\`markdown
### TASK-001: Task title here
- **Status**: pending
- **Dependencies**: none
- **Description**: Clear description of what needs to be done. Reference the requirements doc for detail.
- **Verification**: A specific, testable check to confirm the task is complete.

### TASK-002: Another task
- **Status**: pending
- **Dependencies**: TASK-001
- **Description**: This task depends on TASK-001 completing first.
- **Verification**: Run "npm test" and all tests pass.
\`\`\`

### Task Rules

- Task IDs must be sequential: TASK-001, TASK-002, TASK-003, etc. For larger tasks that need to be broken down, use letter suffixes: TASK-001a, TASK-001b, etc.
- **Tasks must be small and focused** — each should be completable by an automated AI agent in approximately 10-20 minutes. If a task would take longer, break it into smaller subtasks using letter suffixes. Large tasks will time out and fail.
- Status must always be \`pending\` for new tasks
- Dependencies: \`none\` or comma-separated task IDs (e.g., \`TASK-001, TASK-002\`)
- Descriptions should be clear and actionable
- **Every task MUST have a Verification field** with a specific, **targeted** check. Run only the tests relevant to the task, NOT the full test suite. Examples:
  - Good: \`npm test -- --grep "calculator"\` or \`npx jest src/calc.test.ts\`
  - Bad: \`npm test\` (runs everything — slow, may fail for unrelated reasons)
  - Good: \`tsc --noEmit src/calc.ts\` (type-check just the changed file)
  - Bad: \`tsc --noEmit\` (type-checks entire project)
- **Do NOT create any files other than requirements.md and tasks.md** — no source code, no config files, no project scaffolding

After writing both documents, tell the user they need to exit this Claude session (Ctrl+C or /exit) to continue — DevLoop will commit the files and set up the workspace for task execution with "devloop run".
`;

  // For subsequent iterations, append prior work context
  if (priorContext && priorContext.iterationNumber > 0) {
    let section = `\n## Prior Work (Iteration ${priorContext.iterationNumber})\n\n`;
    section += `The following work was completed in a previous iteration. Use this context to inform the new plan.\n\n`;
    section += `**Build on the existing codebase. Do NOT re-implement completed work unless the user requests changes.**\n\n`;

    if (priorContext.requirements) {
      section += `### Previous Requirements\n\n\`\`\`markdown\n${priorContext.requirements}\n\`\`\`\n\n`;
    }

    if (priorContext.tasks) {
      // Extract just task titles to keep context concise
      const taskTitles = priorContext.tasks
        .match(/### (TASK-\d+[a-z]*:\s*.+)/g)
        ?.map(line => `- ${line.replace('### ', '')}`) || [];
      if (taskTitles.length > 0) {
        section += `### Previous Tasks (${taskTitles.length} tasks)\n\n${taskTitles.join('\n')}\n\n`;
      }
    }

    if (priorContext.review) {
      section += `### Review & Recommendations\n\n`;
      section += `The following review was generated after the previous iteration completed. `;
      section += `Use these findings and recommendations to guide the next iteration.\n\n`;
      section += `\`\`\`markdown\n${priorContext.review}\n\`\`\`\n\n`;
    }

    content += section;
  }

  return content;
}

interface InitOptions {
  workspace?: string;
  force?: boolean;
}

/**
 * Prompt user for a string input
 */
async function promptForInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Attempt to commit with retry on hook failure
 * Keeps asking for a new message until commit succeeds or user gives up
 * Saves the format for future DevLoop commits before retrying
 */
export async function commitWithRetry(workspace: string, initialMessage: string, action: string, maxRetries: number = 5): Promise<boolean> {
  let message = initialMessage;
  let attempts = 0;

  while (attempts < maxRetries) {
    attempts++;
    const result = await gitCommit(workspace, message, false);

    if (result.committed) {
      console.log(chalk.green('Committed initial files to git.'));
      return true;
    }

    if (result.isHookFailure) {
      // Hook failure message already printed by gitCommit, ask for new message
      console.log(chalk.gray(`\nTip: Use {action} as a placeholder for reusable formats.`));
      console.log(chalk.gray(`  Example: "chore(devloop): {action}" → "chore(devloop): ${action}"`));
      const newMessage = await promptForInput(chalk.cyan('Enter a valid commit message (or press Enter to skip): '));

      if (!newMessage) {
        console.log(chalk.yellow('Skipping initial commit. You can commit manually later.'));
        return false;
      }

      // Save the format BEFORE retrying so config.json is included in the commit
      await saveDevloopCommitFormat(workspace, newMessage, action);
      console.log(chalk.gray('Saved commit format for future DevLoop commits.'));

      // Expand {action} placeholder if present
      message = newMessage.replace(/\{action\}/g, action);
      // Loop continues with new message
    } else {
      // Some other error, don't retry
      return false;
    }
  }

  console.log(chalk.yellow(`Giving up after ${maxRetries} attempts. You can commit manually later.`));
  return false;
}

/**
 * Detect and configure commit message format based on project hooks/config
 * Returns the initial commit message to use and the action string for format saving
 */
export async function detectAndConfigureCommitFormat(workspace: string, action: string): Promise<{ message: string; action: string }> {
  const detection = await detectCommitFormat(workspace);
  const defaultMessage = `DevLoop: ${action}`;

  if (detection.detected) {
    // Ask user for initial commit message since hooks are present
    console.log(chalk.yellow(`\nDetected commit message hooks (${detection.source}).`));
    console.log(chalk.cyan('The default message may not pass validation.'));
    console.log(chalk.gray(`  Default: "${defaultMessage}"`));
    console.log(chalk.gray(`  Tip: Use {action} placeholder for reusable format, e.g., "chore(devloop): {action}"`));
    const customMessage = await promptForInput(chalk.cyan('Commit message (press Enter for default): '));

    if (customMessage) {
      // Expand {action} placeholder
      const expanded = customMessage.replace(/\{action\}/g, action);
      // Save the format for future DevLoop commits
      await saveDevloopCommitFormat(workspace, customMessage, action);
      console.log(chalk.gray('Saved commit format for future DevLoop commits.'));
      return { message: expanded, action };
    }
  }

  return { message: defaultMessage, action };
}

export async function initCommand(options: InitOptions): Promise<void> {
  await requireClaudeInstalled();

  const workspace = await resolveWorkspace(options.workspace);

  const requirementsPath = getRequirementsPath(workspace);

  printBanner('Init');

  // Show workflow guide
  console.log(chalk.white('Typical workflow:'));
  console.log(chalk.gray('  1. devloop init          - Create requirements (this step)'));
  console.log(chalk.gray('  2. devloop status        - View tasks and progress'));
  console.log(chalk.gray('  3. devloop run            - Execute tasks in a loop'));
  console.log(chalk.gray('  4. devloop continue      - Resume requirements or run later'));
  console.log();
  console.log(chalk.gray(`Workspace: ${workspace}`));

  // Check if requirements.md already exists
  let requirementsExists = false;
  let adoptExisting = false;
  try {
    await fs.access(requirementsPath);
    requirementsExists = true;
  } catch {
    // File doesn't exist
  }

  // Check if session already exists
  const existingSession = await readSession(workspace);

  if (requirementsExists) {
    if (existingSession && !options.force) {
      // Both requirements and session exist - already initialized
      console.log(chalk.yellow('\nWorkspace already initialized.'));
      console.log(chalk.gray('Use "devloop continue" to resume, or --force to reinitialize.'));
      return;
    } else if (!existingSession) {
      // requirements.md exists but no session - adopt the existing file
      adoptExisting = true;
      console.log(chalk.cyan('\nFound existing requirements - adopting it.'));
      console.log(chalk.gray('Setting up DevLoop infrastructure...'));
    }
    // If --force is used, we'll overwrite below
  }

  // When adopting existing file, show it; otherwise Claude will create requirements.md during the session
  if (adoptExisting) {
    console.log(chalk.green(`Using existing: ${requirementsPath}`));
  }

  // Create workspace CLAUDE.md to give Claude context about environment and task
  const claudeDir = path.join(workspace, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const claudeMdContent = generateWorkspaceClaudeMd(workspace);
  await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');
  console.log(chalk.green(`Created: ${claudeMdPath}`));

  // Create session for init phase
  await createSession(workspace, 'init');

  // Detect and configure commit message format, get initial commit message
  const initAction = 'Initialize workspace';
  const commitConfig = await detectAndConfigureCommitFormat(workspace, initAction);

  console.log(chalk.yellow.bold('\n--- Tips ---'));
  console.log(chalk.yellow('  Describe your project in detail — features, tech preferences, and how you want it tested.'));
  console.log(chalk.yellow('  Claude will create a requirements doc and a task list with built-in verification steps.'));
  console.log(chalk.yellow('  Review the task list before finishing — ask Claude to split, reorder, or add tasks if needed.'));
  console.log(chalk.yellow('  When the documents are ready, exit with Ctrl+C or /exit so DevLoop can commit them.'));
  console.log(chalk.yellow('------------\n'));

  // Spawn interactive Claude (no initial prompt - let user drive)
  const child = spawnClaudeInteractive(workspace, null);

  child.on('error', (err) => {
    console.log(chalk.red(`\nFailed to start Claude: ${err.message}`));
  });

  // Handle process exit
  child.on('close', async (code) => {
    try {
      console.log(chalk.blue('\n\nSession ended.'));
      if (code === 0) {
        // Ensure git repo exists and make initial commit
        await ensureGitRepo(workspace);
        await commitWithRetry(workspace, commitConfig.message, commitConfig.action);

        console.log(chalk.green('Requirements file is ready at:'), requirementsPath);
        console.log(chalk.gray('Run "devloop status" to see your tasks.'));
        console.log(chalk.gray('Run "devloop run" to start executing tasks.'));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`\nError during post-session setup: ${msg}`));
    }
  });
}
