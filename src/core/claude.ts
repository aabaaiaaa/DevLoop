import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Task, ClaudeResult, ClaudeErrorType, TokenUsage } from '../types/index.js';

/**
 * Parse token usage from Claude JSON output
 */
function parseTokenUsage(jsonOutput: any): TokenUsage | undefined {
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
function classifyError(stderr: string, errorMessage: string | null): ClaudeErrorType {
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
        "Bash(echo:*)",
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
        "Bash(chown:*)"
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
function formatToolActivity(toolName: string, toolInput: any): string {
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
}

export async function invokeClaudeAutomated(
  prompt: string,
  workingDirectory: string,
  options: InvokeClaudeOptions = {}
): Promise<ClaudeResult> {
  const { verbose = false, onProgress } = options;
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

    let stderr = '';
    let resultText = '';
    let tokenUsage: TokenUsage | undefined;
    let isError = false;
    let lineBuffer = '';

    // Parse streaming JSON events from stdout
    child.stdout?.on('data', (data) => {
      const chunk = data.toString();

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
            if (block?.type === 'tool_use' && block?.name && onProgress) {
              const activity = formatToolActivity(block.name, block.input);
              onProgress(activity);
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
              if (block.type === 'tool_use' && block.name && onProgress) {
                const activity = formatToolActivity(block.name, block.input);
                onProgress(activity);
              }
            }
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    });

    // Collect stderr for error messages
    child.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;

      if (verbose) {
        process.stderr.write(chunk);
      }
    });

    child.on('close', (code) => {
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
      const hasError = code !== 0 || isError;

      // Combine all available error information
      let errorMessage: string | undefined;
      if (hasError) {
        const parts: string[] = [];
        if (stderr) parts.push(stderr.trim());
        if (resultText && resultText.includes('API Error')) {
          parts.push(resultText);
        }
        errorMessage = parts.join('\n') || 'Unknown error';
      }
      const errorType = hasError ? classifyError(errorMessage || stderr || '', null) : undefined;

      resolve({
        success: !hasError,
        output: resultText,
        error: errorMessage,
        errorType,
        duration,
        tokenUsage
      });
    });

    child.on('error', (err) => {
      // Clean up temp file
      try {
        fsSync.unlinkSync(promptFile);
      } catch {
        // Ignore cleanup errors
      }

      resolve({
        success: false,
        output: '',
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
  progressPath: string,
  workspacePath: string
): string {
  return `You are working on an automated development task. Follow these instructions carefully:

WORKSPACE RESTRICTION:
You are ONLY allowed to work within: ${workspacePath}
- Do NOT read, write, or modify any files outside this directory
- Do NOT run commands that affect files outside this directory
- All file paths must be within the workspace

1. READ the requirements file at: ${requirementsPath}
2. READ the progress file at: ${progressPath} (if it exists)

YOUR CURRENT TASK:
- Task ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description}
- Priority: ${task.priority}

INSTRUCTIONS:
1. Complete the task described above
2. Make all necessary code changes WITHIN THE WORKSPACE ONLY
3. After completing the task, update the requirements file to mark task ${task.id} as "done" by changing its Status line from "pending" to "done"
4. Do NOT work on any other tasks

IMPORTANT:
- Focus only on this specific task
- Make clean, well-documented changes
- If you encounter blockers, document them but still attempt the task
- Update the task status to "done" when complete
- NEVER modify files outside ${workspacePath}

Begin working on ${task.id} now.`;
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
