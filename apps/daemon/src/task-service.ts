import { EventEmitter } from 'node:events';
import { tmpdir, homedir } from 'node:os';
import {
  createTaskManager,
  createTaskId,
  createMessageId,
  validateTaskConfig,
  getModelDisplayName,
  type TaskManagerAPI,
  type TaskCallbacks,
  type TaskConfig,
  type Task,
  type TaskMessage,
  type TaskStatus,
  type StorageAPI,
} from '@accomplish_ai/agent-core';
import {
  type TaskConfigBuilderOptions,
  getCliCommand,
  buildEnvironment,
  buildCliArgs,
  isCliAvailable,
  onBeforeStart,
  createOnBeforeTaskStart,
  createTaskCallbacks,
  runTaskSummaryGeneration,
} from './task-config-builder.js';

import { type TaskServiceEvents, type TaskServiceOptions } from './task-service-events.js';
import { recommendModelForPrompt } from './prompt-model-router.js';
import { ProjectOrchestrator, projectStatusToTodos } from './project-orchestrator.js';

export type { TaskServiceEvents, TaskServiceOptions };

export class TaskService extends EventEmitter {
  private taskManager: TaskManagerAPI;
  private storage: StorageAPI;
  private opts: TaskConfigBuilderOptions;
  private projectOrchestrators: Map<string, ProjectOrchestrator> = new Map();

  constructor(storage: StorageAPI, options: TaskServiceOptions) {
    super();
    this.storage = storage;
    this.opts = {
      ...options,
      isPackaged: options.isPackaged ?? false,
      resourcesPath: options.resourcesPath ?? '',
      appPath: options.appPath ?? '',
    };

    this.taskManager = createTaskManager({
      adapterOptions: {
        platform: process.platform,
        isPackaged: this.opts.isPackaged,
        tempPath: tmpdir(),
        getCliCommand: () => getCliCommand(this.opts),
        buildEnvironment: (taskId) => buildEnvironment(taskId, this.storage, this.opts),
        buildCliArgs: (config) => buildCliArgs(config, this.storage),
        onBeforeStart: async () => {
          const result = await onBeforeStart(this.storage, this.opts);
          return result.env;
        },
        getModelDisplayName,
      },
      defaultWorkingDirectory: homedir(),
      maxConcurrentTasks: 10,
      isCliAvailable: () => isCliAvailable(this.opts),
      onBeforeTaskStart: createOnBeforeTaskStart(this.opts),
    });
  }

  async startTask(params: {
    prompt: string;
    taskId?: string;
    modelId?: string;
    sessionId?: string;
    workingDirectory?: string;
    workspaceId?: string;
    projectMode?: boolean;
  }): Promise<Task> {
    const taskId = params.taskId || createTaskId();

    if (params.projectMode) {
      const orchestrator = new ProjectOrchestrator({
        taskManager: this.taskManager,
        storage: this.storage,
        service: this,
        runSubtask: (subtaskTaskId, subtaskConfig, subtaskCallbacks) =>
          this.taskManager.startTask(subtaskTaskId, subtaskConfig, subtaskCallbacks),
      });
      this.projectOrchestrators.set(taskId, orchestrator);

      orchestrator.on('plan', ({ plan }) => {
        this.emit('project-plan', { taskId, plan });
      });
      orchestrator.on('status', (status) => {
        this.emit('project-status', { taskId, status });
        // Keep the task panel's subtask list (todo sidebar) in sync, including
        // each subtask's assigned model.
        const todos = projectStatusToTodos(status);
        this.storage.saveTodosForTask(taskId, todos);
        this.emit('todoUpdate', { taskId, todos });
      });
      orchestrator.on('progress', (progress) => {
        this.emit('progress', { taskId, ...progress });
      });
      orchestrator.on('subtask-complete', ({ subtaskTaskId, modelName, result }) => {
        this.emit('subtask-complete', { taskId, subtaskTaskId, modelName, result });
      });
      orchestrator.on('complete', ({ status }) => {
        this.emit('project-complete', { taskId, status });
      });

      // Run the orchestrator without awaiting it so the HTTP call returns immediately.
      orchestrator
        .run({ goal: params.prompt, taskId, workingDirectory: params.workingDirectory, sessionId: params.sessionId })
        .catch((error) => {
          this.emit('error', { taskId, error: error instanceof Error ? error.message : String(error) });
        });
    }

    const config: TaskConfig = {
      prompt: params.prompt,
      taskId,
      modelId: params.modelId,
      sessionId: params.sessionId,
      workingDirectory: params.workingDirectory,
      projectMode: params.projectMode,
    };
    const validatedConfig = validateTaskConfig(config);
    const activeModel = this.storage.getActiveProviderModel();
    const selectedModel = activeModel || this.storage.getSelectedModel();
    if (selectedModel?.model && !validatedConfig.modelId) {
      validatedConfig.modelId = recommendModelForPrompt(validatedConfig.prompt).modelId;
    }

    const task = await this._runTask(taskId, validatedConfig);

    const initialUserMessage: TaskMessage = {
      id: createMessageId(),
      type: 'user',
      content: validatedConfig.prompt,
      timestamp: new Date().toISOString(),
    };
    task.messages = [initialUserMessage];
    this.storage.saveTask(task);

    runTaskSummaryGeneration(taskId, validatedConfig.prompt, this.storage, (summary) => {
      this.emit('summary', { taskId, summary });
    });

    return task;
  }

  async stopTask(params: { taskId: string }): Promise<void> {
    const { taskId } = params;

    const orchestrator = this.projectOrchestrators.get(taskId);
    if (orchestrator) {
      orchestrator.stop();
    }

    if (this.taskManager.isTaskQueued(taskId)) {
      this.taskManager.cancelQueuedTask(taskId);
      this.storage.updateTaskStatus(taskId, 'cancelled', new Date().toISOString());
      return;
    }
    if (this.taskManager.hasActiveTask(taskId)) {
      await this.taskManager.cancelTask(taskId);
      this.storage.updateTaskStatus(taskId, 'cancelled', new Date().toISOString());
    }
  }

  async interruptTask(params: { taskId: string }): Promise<void> {
    const { taskId } = params;
    if (this.taskManager.hasActiveTask(taskId)) {
      await this.taskManager.interruptTask(taskId);
    }
  }

  async resumeSession(params: {
    sessionId: string;
    prompt: string;
    existingTaskId?: string;
  }): Promise<Task> {
    const { sessionId, prompt, existingTaskId } = params;
    const taskId = existingTaskId || createTaskId();

    if (existingTaskId) {
      const userMessage: TaskMessage = {
        id: createMessageId(),
        type: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      };
      this.storage.addTaskMessage(existingTaskId, userMessage);
    }

    const activeModel = this.storage.getActiveProviderModel();
    const selectedModel = activeModel || this.storage.getSelectedModel();
    const recommendation = recommendModelForPrompt(prompt);
    const task = await this._runTask(taskId, {
      prompt,
      sessionId,
      taskId,
      modelId: recommendation.modelId || selectedModel?.model,
    });

    if (existingTaskId) {
      this.storage.updateTaskStatus(existingTaskId, task.status, new Date().toISOString());
    }
    return task;
  }

  private async _runTask(taskId: string, config: TaskConfig): Promise<Task> {
    const callbacks: TaskCallbacks = createTaskCallbacks(
      taskId,
      this,
      this.storage,
      this.taskManager,
    );
    return this.taskManager.startTask(taskId, config, callbacks);
  }

  listTasks(): Task[] {
    return this.storage.getTasks() as Task[];
  }

  getTaskStatus(params: {
    taskId: string;
  }): { taskId: string; status: TaskStatus; prompt: string; createdAt: string } | null {
    const task = this.storage.getTask(params.taskId);
    if (!task) {
      return null;
    }
    return { taskId: task.id, status: task.status, prompt: task.prompt, createdAt: task.createdAt };
  }

  getActiveTaskId(): string | null {
    return this.taskManager.getActiveTaskId();
  }
  hasActiveTask(taskId: string): boolean {
    return this.taskManager.hasActiveTask(taskId);
  }
  getActiveTaskCount(): number {
    return this.taskManager.getActiveTaskCount();
  }

  async sendResponse(taskId: string, response: string): Promise<void> {
    await this.taskManager.sendResponse(taskId, response);
  }

  /**
   * Deliver a user message to a running task mid-execution.
   *
   * The message is persisted into the task conversation and broadcast to the
   * UI immediately (via the 'message' event → task.message notification), so
   * the user sees their message appear right away. The agent then picks it
   * up: the current turn is interrupted and the session is respawned with a
   * redirect prompt so the agent re-plans around the new input.
   *
   * @throws when the task is not actively running — the UI falls back to a
   *   normal follow-up (session resume) in that case.
   */
  async sendUserMessage(params: { taskId: string; message: string }): Promise<void> {
    const taskId = params.taskId;
    const message = params.message.trim();
    if (!message) {
      throw new Error('Message cannot be empty');
    }

    // Refuse delivery to tasks that are not running so the UI can fall back
    // to a normal follow-up (session.resume) instead of losing the message.
    if (!this.taskManager.hasActiveTask(taskId) || !this.taskManager.isTaskRunning(taskId)) {
      throw new Error(
        `Task ${taskId} is not running - send a follow-up via session.resume instead`,
      );
    }

    // Queue the message with the adapter first - it interrupts the current
    // turn and respawns the session with a redirect prompt on process exit.
    const queued = await this.taskManager.sendUserMessage(taskId, message);
    if (!queued) {
      // The task finished between our check and the adapter call. Nothing was
      // persisted - surface the miss so the UI can fall back to a follow-up.
      throw new Error(
        `Task ${taskId} stopped before the mid-run message could be delivered - ` +
          `send a follow-up instead`,
      );
    }

    // Delivered - persist the user message into the conversation and
    // broadcast it to the UI immediately (mirrors how resumeSession records
    // its user message).
    const userMessage: TaskMessage = {
      id: createMessageId(),
      type: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    this.storage.addTaskMessage(taskId, userMessage);
    this.emit('message', { taskId, messages: [userMessage] });
  }
  dispose(): void {
    this.taskManager.dispose();
  }
}
