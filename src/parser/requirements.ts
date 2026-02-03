import * as fs from 'fs/promises';
import { Task, Requirements, TaskStatus, TaskPriority } from '../types/index.js';

const TASK_REGEX = /^### (TASK-\d+): (.+)$/;
const STATUS_REGEX = /^\s*-\s*\*\*Status\*\*:\s*(pending|in-progress|done)/i;
const PRIORITY_REGEX = /^\s*-\s*\*\*Priority\*\*:\s*(high|medium|low)/i;
const DEPS_REGEX = /^\s*-\s*\*\*Dependencies\*\*:\s*(.+)/i;
const DESC_REGEX = /^\s*-\s*\*\*Description\*\*:\s*(.+)/i;

export async function parseRequirements(filePath: string): Promise<Requirements> {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseRequirementsContent(content);
}

export function parseRequirementsContent(content: string): Requirements {
  const lines = content.split('\n');

  const tasks: Task[] = [];
  let currentTask: Partial<Task> | null = null;

  // Parse metadata from header - try multiple formats
  const projectMatch = content.match(/\*\*Project\*\*:\s*(.+)/);
  const createdMatch = content.match(/\*\*Created\*\*:\s*(.+)/);
  const authorMatch = content.match(/\*\*Author\*\*:\s*(.+)/);

  // Also try to get project name from markdown title (# ProjectName - ...) or (# ProjectName)
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
        priority: 'medium',
        dependencies: [],
        description: ''
      };
      continue;
    }

    if (currentTask) {
      const statusMatch = line.match(STATUS_REGEX);
      if (statusMatch) {
        currentTask.status = statusMatch[1].toLowerCase() as TaskStatus;
        continue;
      }

      const priorityMatch = line.match(PRIORITY_REGEX);
      if (priorityMatch) {
        currentTask.priority = priorityMatch[1].toLowerCase() as TaskPriority;
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

export function getNextTask(requirements: Requirements): Task | null {
  const completedIds = new Set(
    requirements.tasks.filter(t => t.status === 'done').map(t => t.id)
  );

  // Sort by priority (high > medium > low), then by task ID
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const pendingTasks = requirements.tasks
    .filter(t => t.status === 'pending')
    .sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.id.localeCompare(b.id);
    });

  // Find first pending task whose dependencies are all done
  for (const task of pendingTasks) {
    const depsComplete = task.dependencies.every(dep => completedIds.has(dep));
    if (depsComplete) {
      return task;
    }
  }

  return null;
}

export function generateRequirementsTemplate(projectName: string): string {
  const today = new Date().toISOString().split('T')[0];
  return `# Project Requirements

## Metadata
- **Project**: ${projectName}
- **Created**: ${today}
- **Author**: Developer

## Tasks

### TASK-001: Example task one
- **Status**: pending
- **Priority**: high
- **Dependencies**: none
- **Description**: This is an example task. Replace with your actual task description.

### TASK-002: Example task two
- **Status**: pending
- **Priority**: medium
- **Dependencies**: TASK-001
- **Description**: This task depends on TASK-001. It will only be worked on after TASK-001 is complete.

### TASK-003: Example task three
- **Status**: pending
- **Priority**: low
- **Dependencies**: none
- **Description**: This is an independent task with no dependencies.
`;
}
