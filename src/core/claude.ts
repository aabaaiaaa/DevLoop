import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Task, ClaudeResult, ClaudeErrorType, TokenUsage, ToolEvent } from '../types/index.js';

/**
 * Parse token usage from Claude JSON output
 */
export function parseTokenUsage(jsonOutput: any): TokenUsage | undefined {
  try {
    const usage = jsonOutput?.usage;
    if (!usage) return undefined;

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;

    return {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      costUsd: jsonOutput?.total_cost_usd || 0
    };
  } catch {
    return undefined;
  }
}

/**
 * Classifies an error from Claude CLI output to determine if it's an API error
 * (which should stop the loop) or a task failure (which can continue).
 */
export function classifyError(stderr: string, errorMessage: string | null): ClaudeErrorType {
  const errorText = ((stderr || '') + (errorMessage || '')).toLowerCase();

  // Rate limit errors (400/429)
  if (errorText.includes('rate limit') ||
    errorText.includes('api usage limit') ||
    errorText.includes('429') ||
    (errorText.includes('400') && errorText.includes('limit'))) {
    return 'rate_limit';
  }

  // API overload (503)
  if (errorText.includes('overload') || errorText.includes('503')) {
    return 'api_overload';
  }

  // Authentication errors (401)
  if (errorText.includes('401') ||
    errorText.includes('unauthorized') ||
    errorText.includes('authentication')) {
    return 'auth_error';
  }

  // Network errors
  if (errorText.includes('econnrefused') ||
    errorText.includes('enotfound') ||
    errorText.includes('timeout') ||
    errorText.includes('network')) {
    return 'network_error';
  }

  // If it has "api error" in it, treat as unknown API error
  if (errorText.includes('api error')) {
    return 'unknown';
  }

  // Otherwise it's likely a task failure (Claude ran but task didn't complete)
  return 'task_failure';
}

/**
 * Checks if an error type represents an API-level error that should stop the loop.
 */
export function isApiError(errorType: ClaudeErrorType | undefined): boolean {
  return errorType !== undefined && errorType !== 'task_failure';
}

/**
 * Filters out non-actionable warnings from Claude CLI stderr output.
 * These are informational messages that don't indicate errors and would
 * otherwise pollute error messages or verbose output.
 */
export function filterStderrNoise(chunk: string): string {
  return chunk
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      // Sandbox warning on Windows (sandbox.enabled set via remote-settings but unsupported)
      if (trimmed.includes('Sandbox disabled:') && trimmed.includes('sandbox.enabled')) return false;
      if (trimmed.startsWith('Commands will run WITHOUT sandboxing')) return false;
      return true;
    })
    .join('\n');
}

/**
 * Creates a workspace-scoped Claude settings file that restricts
 * file operations to the workspace directory only.
 */
export async function ensureWorkspaceSettings(workspacePath: string): Promise<void> {
  const claudeDir = path.join(workspacePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  try {
    await fs.mkdir(claudeDir, { recursive: true });
  } catch {
    // Directory exists
  }

  const settings = {
    permissions: {
      allow: [
        `Bash(cd:${workspacePath})`,
        `Bash(cd:${workspacePath}/**)`,
        "Bash(npm:*)",
        "Bash(npx:*)",
        "Bash(node:*)",
        "Bash(git:*)",
        "Bash(tsc:*)",
        "Bash(mkdir:*)",
        "Bash(ls:*)",
        "Bash(cat:*)",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep"
      ],
      deny: [
        "Bash(rm -rf /)",
        "Bash(rm -rf ~)",
        "Bash(rm -rf ..)",
        "Bash(sudo:*)",
        "Bash(chmod:*)",
        "Bash(chown:*)",
        `Edit(${workspacePath.replace(/\\/g, '/')}/.devloop/**)`,
        `Write(${workspacePath.replace(/\\/g, '/')}/.devloop/**)`,
        `Edit(${workspacePath.replace(/\\/g, '/')}/.claude/**)`,
        `Write(${workspacePath.replace(/\\/g, '/')}/.claude/**)`
      ]
    },
    restrictToWorkspace: true,
    workspacePath: workspacePath
  };

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Format a tool name and input into a human-readable activity string.
 */
export function formatToolActivity(toolName: string, toolInput: any): string {
  // Extract relevant info from tool input
  let detail = '';

  if (toolInput) {
    // Common patterns in tool inputs
    if (toolInput.file_path) {
      detail = toolInput.file_path;
    } else if (toolInput.path) {
      detail = toolInput.path;
    } else if (toolInput.pattern) {
      detail = toolInput.pattern;
    } else if (toolInput.command) {
      // For bash, show just the first word of the command
      detail = toolInput.command.split(' ')[0].split('\n')[0];
    } else if (toolInput.query) {
      detail = toolInput.query.slice(0, 30);
    } else if (toolInput.url) {
      detail = toolInput.url.slice(0, 30);
    }
  }

  // Shorten long details
  if (detail.length > 40) {
    detail = '...' + detail.slice(-37);
  }

  switch (toolName.toLowerCase()) {
    case 'read':
      return detail ? `Reading ${detail}` : 'Reading file';
    case 'write':
      return detail ? `Writing ${detail}` : 'Writing file';
    case 'edit':
      return detail ? `Editing ${detail}` : 'Editing file';
    case 'glob':
      return detail ? `Finding ${detail}` : 'Searching files';
    case 'grep':
      return detail ? `Searching: ${detail}` : 'Searching in files';
    case 'bash':
      return detail ? `Running ${detail}` : 'Running command';
    case 'webfetch':
      return 'Fetching URL';
    case 'websearch':
      return detail ? `Searching: ${detail}` : 'Searching web';
    case 'task':
      return 'Running sub-task';
    default:
      return `Using ${toolName}`;
  }
}

export interface InvokeClaudeOptions {
  verbose?: boolean;
  onProgress?: (activity: string) => void;
  onToolCall?: (event: ToolEvent) => void;
  taskTimeout?: number;  // Kill child process after this many milliseconds
  /** Called with a function that kills the child process tree. Caller can store it to abort later. */
  onSpawn?: (kill: () => void) => void;
}

export async function invokeClaudeAutomated(
  prompt: string,
  workingDirectory: string,
  options: InvokeClaudeOptions = {}
): Promise<ClaudeResult> {
  const { verbose = false, onProgress, onToolCall } = options;
  const startTime = Date.now();

  // Ensure workspace settings exist
  await ensureWorkspaceSettings(workingDirectory);

  return new Promise((resolve) => {
    // Write prompt to temp file to avoid command line length limits and quoting issues
    const tempDir = os.tmpdir();
    const promptFile = path.join(tempDir, `devloop-prompt-${Date.now()}.txt`);

    fsSync.writeFileSync(promptFile, prompt, 'utf-8');

    if (verbose) {
      console.log(`  Executing: claude -p [prompt from file] --dangerously-skip-permissions --output-format stream-json --add-dir "${workingDirectory}"`);
    }

    // Use stream-json format for real-time progress events
    // Note: stream-json requires --verbose when using -p
    const args = [
      '-p', '-',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '--add-dir', workingDirectory
    ];

    const child = spawn('claude', args, {
      cwd: workingDirectory,
      shell: true,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Pipe the prompt file content to stdin
    const promptContent = fsSync.readFileSync(promptFile, 'utf-8');
    child.stdin?.write(promptContent);
    child.stdin?.end();

    // Expose kill function to caller (for skip/abort support)
    if (options.onSpawn && child.pid) {
      const pid = child.pid;
      options.onSpawn(() => {
        if (process.platform === 'win32') {
          // On Windows, child.kill() only kills the shell, not the process tree.
          // Use taskkill /T to kill the entire tree (Claude + any spawned test runners).
          spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
        } else {
          // On Unix, kill the process group to include child processes
          try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        }
      });
    }

    // Task timeout — kill the child process if it exceeds the limit
    let wasTimedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (options.taskTimeout && options.taskTimeout > 0) {
      timeoutTimer = setTimeout(() => {
        wasTimedOut = true;
        child.kill('SIGTERM');
      }, options.taskTimeout);
    }

    let stderr = '';
    let resultText = '';
    let rawOutput = '';
    let tokenUsage: TokenUsage | undefined;
    let isError = false;
    let lineBuffer = '';

    // Parse streaming JSON events from stdout
    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      rawOutput += chunk;

      if (verbose) {
        process.stdout.write(chunk);
      }

      // Buffer lines (events are newline-delimited JSON)
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);

          // Handle different event types
          if (event.type === 'content_block_start') {
            // Tool usage starting
            const block = event.content_block;
            if (block?.type === 'tool_use' && block?.name) {
              if (onProgress) {
                const activity = formatToolActivity(block.name, block.input);
                onProgress(activity);
              }
              if (onToolCall) {
                onToolCall({
                  timestamp: Date.now(),
                  toolName: block.name,
                  command: block.input?.command || undefined
                });
              }
            }
          } else if (event.type === 'content_block_delta') {
            // Tool input being streamed (partial)
            const delta = event.delta;
            if (delta?.type === 'input_json_delta' && onProgress) {
              // Could parse partial input here if needed
            }
          } else if (event.type === 'result') {
            // Final result with token usage
            resultText = event.result || '';
            isError = event.is_error === true;
            tokenUsage = parseTokenUsage(event);

            if (verbose && tokenUsage) {
              console.log(`  Token usage: ${tokenUsage.totalTokens} total (${tokenUsage.inputTokens} in, ${tokenUsage.outputTokens} out)`);
            }
          } else if (event.type === 'assistant' && event.message?.content) {
            // Assistant message with tool uses
            for (const block of event.message.content) {
              if (block.type === 'tool_use' && block.name) {
                if (onProgress) {
                  const activity = formatToolActivity(block.name, block.input);
                  onProgress(activity);
                }
                if (onToolCall) {
                  onToolCall({
                    timestamp: Date.now(),
                    toolName: block.name,
                    command: block.input?.command || undefined
                  });
                }
              }
            }
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    });

    // Collect stderr for error messages (filtering out non-actionable Claude CLI warnings)
    child.stderr?.on('data', (data) => {
      const chunk = data.toString();
      const filtered = filterStderrNoise(chunk);
      if (filtered.trim()) {
        stderr += filtered;

        if (verbose) {
          process.stderr.write(filtered);
        }
      }
    });

    child.on('close', (code, signal) => {
      // Clear timeout timer
      if (timeoutTimer) clearTimeout(timeoutTimer);

      // Clean up temp file
      try {
        fsSync.unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }

      // Process any remaining buffered line
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          if (event.type === 'result') {
            resultText = event.result || resultText;
            isError = event.is_error === true;
            tokenUsage = parseTokenUsage(event) || tokenUsage;
          }
        } catch {
          // Ignore
        }
      }

      const duration = Date.now() - startTime;
      const hasError = code !== 0 || isError || wasTimedOut;

      // Combine all available error information
      let errorMessage: string | undefined;
      if (hasError) {
        const parts: string[] = [];
        if (stderr) parts.push(stderr.trim());
        if (resultText && resultText.includes('API Error')) {
          parts.push(resultText);
        }
        // Include exit code/signal info
        if (signal) {
          parts.push(`Killed by signal: ${signal}`);
        } else if (code !== null && code !== undefined) {
          parts.push(`Exit code: ${code}`);
        }
        errorMessage = parts.join('\n') || 'Unknown error (no exit code, no signal, no stderr)';
      }
      let errorType = hasError ? classifyError(errorMessage || stderr || '', null) : undefined;

      // Override for timeout: classify as task_failure so the loop retries
      // instead of stopping (classifyError would match "timeout" as network_error)
      if (wasTimedOut) {
        const timeoutMinutes = Math.round((options.taskTimeout || 0) / 60000);
        errorMessage = `Task exceeded ${timeoutMinutes} minute time limit`;
        errorType = 'task_failure';
      }

      resolve({
        success: !hasError,
        output: resultText,
        rawOutput,
        error: errorMessage,
        errorType,
        duration,
        tokenUsage,
        exitCode: code,
        signal: signal ?? null
      });
    });

    child.on('error', (err) => {
      // Clear timeout timer
      if (timeoutTimer) clearTimeout(timeoutTimer);

      // Clean up temp file
      try {
        fsSync.unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }

      resolve({
        success: false,
        output: '',
        rawOutput,
        error: err.message,
        errorType: classifyError(err.message, null),
        duration: Date.now() - startTime,
        tokenUsage: undefined
      });
    });
  });
}

export function spawnClaudeInteractive(
  workingDirectory: string,
  sessionId?: string | null
): ChildProcess {
  const args: string[] = [];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  // Spawn Claude in fully interactive mode (no -p flag)
  const child = spawn('claude', args, {
    cwd: workingDirectory,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env }
  });

  return child;
}

export function buildTaskPrompt(
  task: Task,
  requirementsPath: string,
  tasksPath: string,
  progressPath: string,
  workspacePath: string,
  isRetry: boolean = false,
  verifyEachTask: boolean = false
): string {
  const retrySection = isRetry ? `RETRY CONTEXT:
This task was previously attempted but interrupted. Your partial work from the
previous attempt has been committed to git. Review the existing code and git log
before continuing — build on what is already there rather than starting from scratch.

` : '';

  const verificationSection = verifyEachTask
    ? `VERIFICATION REQUIREMENT:
${task.verification}
Before finishing, you MUST verify your work using the check above.
If verification fails, fix the issue. Do not finish until verification passes.
For E2E/integration tests (Playwright, Cypress, Selenium): only run the specific test files
relevant to this task, not the entire E2E suite — unless the verification explicitly requires it.`
    : `VERIFICATION REQUIREMENT:
${task.verification}

IMPORTANT: Only run quick checks now (type-checking like \`tsc --noEmit\`, linting).
Do NOT run test suites (npm test, jest, vitest, mocha, pytest, go test, cargo test, etc.)
— test verification will run in a consolidated phase after all tasks complete.
If the verification above only contains test commands, skip verification entirely.`;

  const verificationInstruction = verifyEachTask
    ? '5. Run the verification check before finishing'
    : '5. Run only quick verification checks (type-checking, linting) — skip test suites';

  return `You are working on an automated development task. Follow these instructions carefully:

WORKSPACE RESTRICTION:
You are ONLY allowed to work within: ${workspacePath}
- Do NOT read, write, or modify any files outside this directory
- Do NOT run commands that affect files outside this directory
- All file paths must be within the workspace
- Do NOT modify any files in .devloop/ or .claude/ directories

CONTEXT FILES:
1. READ the full requirements document at: ${requirementsPath}
   This contains the detailed project plan and context for all tasks.
2. The task list at ${tasksPath} contains all tasks — do NOT edit this file.
3. READ the progress file at: ${progressPath} (if it exists)

YOUR CURRENT TASK:
- Task ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description}

${verificationSection}

${retrySection}INSTRUCTIONS:
1. Complete the task described above
2. Make all necessary code changes WITHIN THE WORKSPACE ONLY
3. Do NOT work on any other tasks
4. Do NOT modify any files in .devloop/ or .claude/ directories
${verificationInstruction}

Begin working on ${task.id} now.`;
}

export function buildBatchPrompt(
  tasks: Task[],
  requirementsPath: string,
  tasksPath: string,
  progressPath: string,
  workspacePath: string,
  verifyEachTask: boolean = false
): string {
  const taskSection = tasks.map(t => `### ${t.id}: ${t.title}
- Description: ${t.description}
- Verification: ${t.verification}`).join('\n\n');

  const verificationInstructions = verifyEachTask
    ? `Each agent MUST run its task's verification before reporting success.
If verification fails, the agent should fix the issue. Do not report success until verification passes.
For E2E/integration tests (Playwright, Cypress, Selenium): only run the specific test files
relevant to the task, not the entire E2E suite — unless the verification explicitly requires it.`
    : `Agents should run only quick checks (type-checking, linting) per task.
Do NOT run test suites — those will run in a consolidated verification phase after all tasks complete.
If a task's verification only contains test commands, skip verification for that task.`;

  return `You are working on multiple development tasks simultaneously. You have access to
the Agent tool to run tasks in parallel.

WORKSPACE RESTRICTION:
You are ONLY allowed to work within: ${workspacePath}
- Do NOT read, write, or modify any files outside this directory
- Do NOT run commands that affect files outside this directory
- All file paths must be within the workspace
- Do NOT modify any files in .devloop/ or .claude/ directories

CONTEXT FILES:
1. READ the full requirements document at: ${requirementsPath}
   This contains the detailed project plan and context for all tasks.
2. The task list at ${tasksPath} contains all tasks — do NOT edit this file.
3. READ the progress file at: ${progressPath} (if it exists)

TASKS TO COMPLETE:

${taskSection}

EXECUTION STRATEGY:
1. Read the requirements and understand all tasks above
2. Analyze which tasks touch the same files or have overlapping concerns
3. Group tasks that can safely run in parallel (touch different files/modules)
4. For each parallel group, use the Agent tool to spawn agents:
   - Give each agent a clear description including the task ID, what to do, and the workspace path
   - Include the task ID in the agent description (e.g., "TASK-003: Implement auth middleware")
   - Each agent works within ${workspacePath}
5. After parallel agents complete, run any remaining tasks that had file conflicts sequentially
6. Do NOT modify any files in .devloop/ or .claude/ directories

VERIFICATION:
${verificationInstructions}

RESULT FORMAT:
When all tasks are done, report the result for EACH task in this EXACT format (one per line):
TASK_RESULT: TASK-XXX: SUCCESS
TASK_RESULT: TASK-YYY: FAILED: reason for failure

DevLoop parses these lines to determine task outcomes. Every task listed above MUST have a TASK_RESULT line.`;
}

export interface BatchTaskResult {
  success: boolean;
  error?: string;
}

export function parseBatchResults(
  output: string,
  taskIds: string[]
): Map<string, BatchTaskResult> {
  const results = new Map<string, BatchTaskResult>();

  // Parse TASK_RESULT lines
  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/TASK_RESULT:\s*(TASK-\d+[a-z]*):\s*(SUCCESS|FAILED)(?::\s*(.+))?/);
    if (match) {
      const [, taskId, status, reason] = match;
      results.set(taskId, {
        success: status === 'SUCCESS',
        error: reason?.trim()
      });
    }
  }

  // Tasks not mentioned are treated as failed
  for (const id of taskIds) {
    if (!results.has(id)) {
      results.set(id, { success: false, error: 'No result reported by Claude' });
    }
  }

  return results;
}

export async function checkClaudeInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      shell: true,
      stdio: 'pipe'
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}
