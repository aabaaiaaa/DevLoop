import * as fs from 'fs/promises';
import { Progress, IterationLog, ExitStatus, ClaudeErrorType, TokenUsage } from '../types/index.js';

export async function readProgress(filePath: string): Promise<Progress | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseProgressContent(content);
  } catch {
    return null; // File doesn't exist yet
  }
}

export function parseProgressContent(content: string): Progress {
  // Parse summary section
  const totalMatch = content.match(/\*\*Total Tasks\*\*:\s*(\d+)/);
  const completedMatch = content.match(/\*\*Completed\*\*:\s*(\d+)/);
  const remainingMatch = content.match(/\*\*Remaining\*\*:\s*(\d+)/);
  const lastUpdatedMatch = content.match(/\*\*Last Updated\*\*:\s*(.+)/);

  // Parse iteration logs - split by iteration headers
  const iterations: IterationLog[] = [];
  const iterationBlocks = content.split(/(?=### Iteration \d+)/).slice(1);

  for (const block of iterationBlocks) {
    const headerMatch = block.match(/### Iteration (\d+) - (.+)/);
    const taskMatch = block.match(/- \*\*Task Completed\*\*: ([\w-]+|none)/);
    const summaryMatch = block.match(/- \*\*Summary\*\*: (.+)/);
    const durationMatch = block.match(/- \*\*Duration\*\*: (.+)/);
    const statusMatch = block.match(/- \*\*Exit Status\*\*: (\w+)/);
    const errorTypeMatch = block.match(/- \*\*Error Type\*\*: (\w+)/);
    const errorDetailMatch = block.match(/- \*\*Error Detail\*\*:\s*\n```\n([\s\S]*?)\n```/);
    const tokensMatch = block.match(/- \*\*Tokens\*\*: ([\d,]+) total \(([\d,]+) in, ([\d,]+) out(?:, ([\d,]+) cache-create, ([\d,]+) cache-read)?\)/);
    const costMatch = block.match(/- \*\*Cost\*\*: \$([\d.]+)/);

    if (headerMatch && taskMatch && summaryMatch && durationMatch && statusMatch) {
      const log: IterationLog = {
        iteration: parseInt(headerMatch[1], 10),
        timestamp: headerMatch[2].trim(),
        taskCompleted: taskMatch[1] === 'none' ? null : taskMatch[1],
        summary: summaryMatch[1].trim(),
        duration: durationMatch[1].trim(),
        exitStatus: statusMatch[1] as ExitStatus
      };

      if (errorTypeMatch) {
        log.errorType = errorTypeMatch[1] as ClaudeErrorType;
      }
      if (errorDetailMatch) {
        log.errorDetail = errorDetailMatch[1].trim();
      }
      if (tokensMatch) {
        log.tokenUsage = {
          totalTokens: parseInt(tokensMatch[1].replace(/,/g, ''), 10),
          inputTokens: parseInt(tokensMatch[2].replace(/,/g, ''), 10),
          outputTokens: parseInt(tokensMatch[3].replace(/,/g, ''), 10),
          cacheCreationTokens: tokensMatch[4] ? parseInt(tokensMatch[4].replace(/,/g, ''), 10) : 0,
          cacheReadTokens: tokensMatch[5] ? parseInt(tokensMatch[5].replace(/,/g, ''), 10) : 0,
          costUsd: costMatch ? parseFloat(costMatch[1]) : 0
        };
      }

      iterations.push(log);
    }
  }

  return {
    totalTasks: parseInt(totalMatch?.[1] || '0', 10),
    completed: parseInt(completedMatch?.[1] || '0', 10),
    remaining: parseInt(remainingMatch?.[1] || '0', 10),
    lastUpdated: lastUpdatedMatch?.[1]?.trim() || new Date().toISOString(),
    iterations
  };
}

export function generateProgressContent(
  totalTasks: number,
  completedCount: number,
  iterations: IterationLog[]
): string {
  const now = new Date().toISOString();

  let content = `# DevLoop Progress Log

## Summary
- **Total Tasks**: ${totalTasks}
- **Completed**: ${completedCount}
- **Remaining**: ${totalTasks - completedCount}
- **Last Updated**: ${now}

## Iteration Log

`;

  for (const iter of iterations) {
    content += `### Iteration ${iter.iteration} - ${iter.timestamp}
- **Task Completed**: ${iter.taskCompleted || 'none'}
- **Summary**: ${iter.summary}
- **Duration**: ${iter.duration}
- **Exit Status**: ${iter.exitStatus}
`;

    if (iter.tokenUsage) {
      content += `- **Tokens**: ${iter.tokenUsage.totalTokens.toLocaleString()} total (${iter.tokenUsage.inputTokens.toLocaleString()} in, ${iter.tokenUsage.outputTokens.toLocaleString()} out, ${iter.tokenUsage.cacheCreationTokens.toLocaleString()} cache-create, ${iter.tokenUsage.cacheReadTokens.toLocaleString()} cache-read)
- **Cost**: $${iter.tokenUsage.costUsd.toFixed(4)}
`;
    }

    if (iter.errorType) {
      content += `- **Error Type**: ${iter.errorType}
`;
    }
    if (iter.errorDetail) {
      content += `- **Error Detail**:
\`\`\`
${iter.errorDetail}
\`\`\`
`;
    }

    content += '\n';
  }

  return content;
}

export async function writeProgress(filePath: string, progress: Progress): Promise<void> {
  const content = generateProgressContent(
    progress.totalTasks,
    progress.completed,
    progress.iterations
  );
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function appendIteration(
  filePath: string,
  totalTasks: number,
  iteration: IterationLog
): Promise<void> {
  let progress = await readProgress(filePath);

  if (!progress) {
    progress = {
      totalTasks,
      completed: 0,
      remaining: totalTasks,
      lastUpdated: new Date().toISOString(),
      iterations: []
    };
  }

  progress.iterations.push(iteration);
  if (iteration.exitStatus === 'success' && iteration.taskCompleted) {
    progress.completed++;
    progress.remaining--;
  }
  progress.lastUpdated = new Date().toISOString();

  await writeProgress(filePath, progress);
}
