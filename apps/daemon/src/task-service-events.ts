/**
 * Event type declarations for TaskService.
 * Extracted from task-service.ts to keep files under 200 lines.
 */
import type { TaskMessage, TaskResult, TaskStatus, TodoItem } from '@accomplish_ai/agent-core';
import type { ProjectStatus } from './project-orchestrator.js';
import type { ProjectPlan } from './project-plan-parser.js';

export interface TaskServiceEvents {
  progress: [data: { taskId: string; stage: string; message?: string; modelName?: string }];
  message: [data: { taskId: string; messages: TaskMessage[] }];
  complete: [data: { taskId: string; result: TaskResult }];
  error: [data: { taskId: string; error: string }];
  permission: [data: unknown];
  statusChange: [data: { taskId: string; status: TaskStatus }];
  summary: [data: { taskId: string; summary: string }];
  todoUpdate: [data: { taskId: string; todos: TodoItem[] }];
  'project-plan': [data: { taskId: string; plan: ProjectPlan }];
  'project-status': [data: { taskId: string; status: ProjectStatus }];
  'project-complete': [data: { taskId: string; status: ProjectStatus }];
  'subtask-complete': [
    data: {
      taskId: string;
      subtaskTaskId: string;
      modelName: string;
      result: { output?: string; error?: string; status: string };
    },
  ];
}

export interface TaskServiceOptions {
  userDataPath: string;
  mcpToolsPath: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
}
