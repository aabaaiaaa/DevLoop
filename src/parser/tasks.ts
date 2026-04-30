import * as fs from 'fs/promises';
import { Task, TaskList, TaskStatus } from '../types/index.js';

const TASK_REGEX = /^### (TASK-\d+[a-z]*): (.+)$/;
const STATUS_REGEX = /^\s*-\s*\*\*Status\*\*:\s*(pending|in-progress|done)/i;
const DEPS_REGEX = /^\s*-\s*\*\*Dependencies\*\*:\s*(.+)/i;
const DESC_REGEX = /^\s*-\s*\*\*Description\*\*:\s*(.+)/i;
const VERIFICATION_REGEX = /^\s*-\s*\*\*Verification\*\*:\s*(.+)/i;
const TYPE_REGEX = /^\s*-\s*\*\*Type\*\*:\s*(.+)/i;
const BREAKING_REGEX = /^\s*-\s*\*\*Breaking\*\*:\s*(.+)/i;

export async function parseTasks(filePath: string): Promise<TaskList> {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseTasksContent(content);
}

export function parseTasksContent(content: string): TaskList {
  const lines = content.split('\n').map(l => l.replace(/\r$/, ''));

  const tasks: Task[] = [];
  let currentTask: Partial<Task> | null = null;

  // Parse metadata from header
  const projectMatch = content.match(/\*\*Project\*\*:\s*(.+)/);
  const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)/);
  const authorMatch = content.match(/\*\*Author\*\*:\s*(.+)/);

  // Also try to get project name from markdown title
  const titleMatch = content.match(/^#\s+([^-\n]+)/m);
  const projectName = projectMatch?.[1]?.trim() || titleMatch?.[1]?.trim() || 'Unknown Project';

  for (const line of lines) {
    const taskMatch = line.match(TASK_REGEX);
    if (taskMatch) {
      if (currentTask && currentTask.id) {
        tasks.push(currentTask as Task);
      }
      currentTask = {
        id: taskMatch[1],
        title: taskMatch[2],
        status: 'pending',
        dependencies: [],
        description: '',
        verification: ''
      };
      continue;
    }

    if (currentTask) {
      const statusMatch = line.match(STATUS_REGEX);
      if (statusMatch) {
        currentTask.status = statusMatch[1].toLowerCase() as TaskStatus;
        continue;
      }

      const depsMatch = line.match(DEPS_REGEX);
      if (depsMatch) {
        const deps = depsMatch[1].trim();
        currentTask.dependencies = deps.toLowerCase() === 'none'
          ? []
          : deps.split(',').map(d => d.trim());
        continue;
      }

      const descMatch = line.match(DESC_REGEX);
      if (descMatch) {
        currentTask.description = descMatch[1].trim();
        continue;
      }

      const verifyMatch = line.match(VERIFICATION_REGEX);
      if (verifyMatch) {
        currentTask.verification = verifyMatch[1].trim();
        continue;
      }

      const typeMatch = line.match(TYPE_REGEX);
      if (typeMatch) {
        // Validation is deferred to normalizeType() at commit-build time. Unknown
        // values flow through here and become 'chore' when a commit is constructed.
        currentTask.type = typeMatch[1].trim().toLowerCase() as Task['type'];
        continue;
      }

      const breakingMatch = line.match(BREAKING_REGEX);
      if (breakingMatch) {
        currentTask.breakingChange = breakingMatch[1].trim();
        continue;
      }
    }
  }

  // Don't forget the last task
  if (currentTask && currentTask.id) {
    tasks.push(currentTask as Task);
  }

  return {
    projectName,
    created: createdMatch?.[1]?.trim() || new Date().toISOString().split('T')[0],
    author: authorMatch?.[1]?.trim() || 'Unknown',
    tasks
  };
}

export function getNextTask(taskList: TaskList): Task | null {
  const completedIds = new Set(
    taskList.tasks.filter(t => t.status === 'done').map(t => t.id)
  );

  // In-progress tasks take priority (interrupted work that needs to be retried)
  const inProgressTasks = taskList.tasks.filter(t => t.status === 'in-progress');
  if (inProgressTasks.length > 0) {
    return inProgressTasks[0];
  }

  // Sort pending tasks by task ID (dependencies handle ordering)
  const pendingTasks = taskList.tasks
    .filter(t => t.status === 'pending')
    .sort((a, b) => a.id.localeCompare(b.id));

  // Find first pending task whose dependencies are all done
  for (const task of pendingTasks) {
    const depsComplete = task.dependencies.every(dep => completedIds.has(dep));
    if (depsComplete) {
      return task;
    }
  }

  return null;
}

/**
 * Returns all tasks that can run in parallel right now.
 * A task is available if: status is pending, all dependencies are done,
 * and its ID is not in the excludeIds set (currently being worked on).
 * Also returns in-progress tasks (interrupted work) that aren't excluded.
 */
export function getAvailableTasks(
  taskList: TaskList,
  excludeIds: Set<string>
): Task[] {
  const completedIds = new Set(
    taskList.tasks.filter(t => t.status === 'done').map(t => t.id)
  );

  const available: Task[] = [];

  // In-progress tasks first (interrupted work that needs retrying)
  for (const task of taskList.tasks) {
    if (task.status === 'in-progress' && !excludeIds.has(task.id)) {
      available.push(task);
    }
  }

  // Then pending tasks with all dependencies met
  const pendingTasks = taskList.tasks
    .filter(t => t.status === 'pending' && !excludeIds.has(t.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const task of pendingTasks) {
    const depsComplete = task.dependencies.every(dep => completedIds.has(dep));
    if (depsComplete) {
      available.push(task);
    }
  }

  return available;
}

export async function updateTaskStatus(
  filePath: string,
  taskId: string,
  newStatus: TaskStatus
): Promise<boolean> {
  const content = await fs.readFile(filePath, 'utf-8');
  // Normalize CRLF to LF before processing
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const taskHeaderRegex = new RegExp(`^### ${taskId}:`);
  let foundTask = false;

  for (let i = 0; i < lines.length; i++) {
    if (taskHeaderRegex.test(lines[i])) {
      foundTask = true;
      continue;
    }
    if (foundTask) {
      // If we hit another task header, stop searching
      if (TASK_REGEX.test(lines[i])) break;

      const statusMatch = lines[i].match(STATUS_REGEX);
      if (statusMatch) {
        lines[i] = lines[i].replace(
          /\*\*Status\*\*:\s*(pending|in-progress|done)/i,
          `**Status**: ${newStatus}`
        );
        await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
        return true;
      }
    }
  }

  return false;
}

