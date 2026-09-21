import { EventEmitter } from 'node:events';
import type {
  TaskManagerAPI,
  TaskConfig,
  Task,
  TaskCallbacks,
  StorageAPI,
} from '@accomplish_ai/agent-core';
import { createTaskCallbacks } from './task-config-builder.js';
import { parseProjectPlan, type ProjectPlan, type ProjectSubtask } from './project-plan-parser.js';
import { buildDependencyBatches } from './project-scheduler.js';
import {
  assignModelForProjectSubtask,
  getCoordinatorModel,
  type ProjectModelRole,
} from './project-model-router.js';
import { ProjectContext, type ProjectSubtaskResult } from './project-context.js';

export interface ProjectOrchestratorOptions {
  taskManager: TaskManagerAPI;
  storage: StorageAPI;
  service: EventEmitter;
  runSubtask: (
    taskId: string,
    config: TaskConfig,
    callbacks: TaskCallbacks,
  ) => Promise<Task>;
  projectMode?: boolean;
  workingDirectory?: string;
  sessionId?: string;
}

export interface ProjectOrchestratorRunParams {
  goal: string;
  taskId: string;
  workingDirectory?: string;
  sessionId?: string;
}

export interface ProjectStatus {
  taskId: string;
  goal: string;
  plan?: ProjectPlan;
  subtasks: Array<{
    subtaskId: string;
    title: string;
    modelId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    output?: string;
  }>;
  stopped: boolean;
  synthesis?: string;
  unfinished: string[];
}

const MAX_FOLLOW_UP_ROUNDS = 2;

export class ProjectOrchestrator extends EventEmitter {
  private taskManager: TaskManagerAPI;
  private storage: StorageAPI;
  private service: EventEmitter;
  private runSubtask: (
    taskId: string,
    config: TaskConfig,
    callbacks: TaskCallbacks,
  ) => Promise<Task>;
  private context: ProjectContext | null = null;
  private status: ProjectStatus | null = null;

  constructor(opts: ProjectOrchestratorOptions) {
    super();
    this.taskManager = opts.taskManager;
    this.storage = opts.storage;
    this.service = opts.service;
    this.runSubtask = opts.runSubtask;
  }

  getStatus(): ProjectStatus | null {
    return this.status;
  }

  stop(): void {
    if (this.context) {
      this.context.stop();
    }
    if (this.status) {
      this.status.stopped = true;
      this.emit('status', this.status);
    }
  }

  async run(params: ProjectOrchestratorRunParams): Promise<ProjectStatus> {
    const { goal, taskId, workingDirectory, sessionId } = params;

    this.context = new ProjectContext(goal, { summary: goal, subtasks: [] });
    this.status = {
      taskId,
      goal,
      subtasks: [],
      stopped: false,
      unfinished: [],
    };

    // Step 1: ask coordinator (GLM 5.3 Cloud) to produce a plan.
    this.emit('progress', { taskId, stage: 'planning', message: 'Generating project plan…' });
    const plan = await this.generatePlan(taskId, goal, workingDirectory, sessionId);
    this.context.plan = plan;
    this.status.plan = plan;
    this.status.subtasks = plan.subtasks.map((s) => {
      const assignment = this.resolveAssignment(s);
      return {
        subtaskId: s.id,
        title: s.title,
        modelId: assignment.modelId,
        status: 'pending',
      };
    });
    this.emit('status', this.status);
    this.emit('plan', { taskId, plan });

    // Step 2: schedule and execute subtasks.
    await this.executePlan(taskId, plan, workingDirectory, sessionId);

    if (this.context.isStopped()) {
      this.status.synthesis = this.context.isStopped()
        ? 'Project stopped before synthesis.'
        : undefined;
      this.emit('status', this.status);
      this.emit('complete', { taskId, status: this.status });
      return this.status;
    }

    // Step 3: synthesize results.
    this.emit('progress', { taskId, stage: 'synthesis', message: 'Synthesizing results…' });
    const synthesis = await this.synthesize(taskId, workingDirectory, sessionId);

    // Step 4: optionally run follow-up subtasks (limited rounds).
    let rounds = 0;
    while (synthesis.needsMoreSubtasks && rounds < MAX_FOLLOW_UP_ROUNDS) {
      if (this.context.isStopped()) {
        break;
      }
      rounds++;
      this.emit('progress', {
        taskId,
        stage: 'follow-up',
        message: `Planning follow-up subtasks (round ${rounds})…`,
      });
      const followUpPlan: ProjectPlan = {
        summary: `${plan.summary} (follow-up round ${rounds})`,
        subtasks: synthesis.followUpSubtasks.map((s, idx) => ({
          id: `followup-${rounds}-${idx}`,
          title: s.title,
          description: s.description,
          dependsOn: s.dependsOn ?? [],
          fileEdits: s.fileEdits ?? false,
          assignedModel: s.assignedModel,
        })),
      };
      this.context.plan = followUpPlan;
      this.status.plan = followUpPlan;
      this.status.subtasks.push(
        ...followUpPlan.subtasks.map((s) => {
          const assignment = this.resolveAssignment(s);
          return {
            subtaskId: s.id,
            title: s.title,
            modelId: assignment.modelId,
            status: 'pending' as const,
          };
        }),
      );
      this.emit('status', this.status);
      await this.executePlan(taskId, followUpPlan, workingDirectory, sessionId);
      if (this.context.isStopped()) {
        break;
      }
      const next = await this.synthesize(taskId, workingDirectory, sessionId);
      synthesis.synthesis = next.synthesis;
      synthesis.unfinished = next.unfinished;
      synthesis.needsMoreSubtasks = next.needsMoreSubtasks;
      synthesis.followUpSubtasks = next.followUpSubtasks;
    }

    this.status.synthesis = synthesis.synthesis;
    this.status.unfinished = synthesis.unfinished;
    this.emit('status', this.status);
    this.emit('complete', { taskId, status: this.status });

    return this.status;
  }

  private static ROLE_TO_MODEL: Record<ProjectModelRole | string, string> = {
    coordinator: 'glm-5.3:cloud',
    fast: 'glm-5.3-flash:cloud',
    careful: 'gpt-oss:120b-cloud',
    code: 'kimi-k2.7-code:cloud',
  };

  private resolveAssignment(subtask: ProjectSubtask) {
    if (subtask.assignedModel) {
      const role = subtask.assignedModel as ProjectModelRole;
      const modelId = ProjectOrchestrator.ROLE_TO_MODEL[role] ?? subtask.assignedModel;
      return {
        modelId,
        label: modelId,
        reason: 'explicit coordinator assignment',
        role: role as ProjectModelRole,
      };
    }
    return assignModelForProjectSubtask(subtask.title, subtask.description);
  }

  private async generatePlan(
    projectTaskId: string,
    goal: string,
    workingDirectory?: string,
    sessionId?: string,
  ): Promise<ProjectPlan> {
    const coordinator = getCoordinatorModel();
    const prompt = this.buildPlanPrompt(goal);
    const config: TaskConfig = {
      prompt,
      taskId: `${projectTaskId}-plan`,
      modelId: coordinator.modelId,
      sessionId,
      workingDirectory,
      outputSchema: {},
    };

    const planTaskId = config.taskId as string;
    const callbacks = this.createSubtaskCallbacks(planTaskId, coordinator.modelId);
    const task = await this.runSubtask(planTaskId, config, callbacks);

    const raw = this.extractTextOutput(task);
    return parseProjectPlan(raw, goal);
  }

  private async executePlan(
    projectTaskId: string,
    plan: ProjectPlan,
    workingDirectory?: string,
    sessionId?: string,
  ): Promise<void> {
    const batches = buildDependencyBatches(plan.subtasks);
    for (const batch of batches) {
      if (!this.context || !this.status) {
        return;
      }
      if (this.context.isStopped()) {
        this.markRemainingCancelled(plan);
        this.emit('status', this.status);
        break;
      }

      if (batch.sequential) {
        // Run each file-editing subtask one at a time.
        for (const subtask of batch.subtasks) {
          if (this.context.isStopped()) {
            this.markRemainingCancelled(plan);
            this.emit('status', this.status);
            break;
          }
          const entry = this.status?.subtasks.find((x) => x.subtaskId === subtask.id);
          if (entry?.status !== 'pending') {
            continue;
          }
          await this.runSubtaskStep(projectTaskId, subtask, workingDirectory, sessionId);
        }
      } else {
        if (this.context.isStopped()) {
          this.markRemainingCancelled(plan);
          this.emit('status', this.status);
          break;
        }
        // Run independent subtasks in parallel.
        const notStarted = batch.subtasks.filter((s) => {
          const entry = this.status?.subtasks.find((x) => x.subtaskId === s.id);
          return entry?.status === 'pending';
        });
        const promises = notStarted.map((subtask) => this.runSubtaskStep(projectTaskId, subtask, workingDirectory, sessionId));
        await Promise.all(promises);
      }
    }
  }

  private async runSubtaskStep(
    projectTaskId: string,
    subtask: ProjectSubtask,
    workingDirectory?: string,
    sessionId?: string,
  ): Promise<void> {
    if (!this.context || !this.status) {
      return;
    }

    // Ensure we don't overwrite a cancelled/failed status set by stop.
    const current = this.status.subtasks.find((x) => x.subtaskId === subtask.id);
    if (current && current.status !== 'pending') {
      return;
    }

    if (this.context.isStopped()) {
      this.updateSubtaskStatus(subtask.id, 'cancelled');
      return;
    }

    this.updateSubtaskStatus(subtask.id, 'running');
    this.emit('progress', {
      taskId: projectTaskId,
      stage: 'subtask',
      message: `Running subtask: ${subtask.title}`,
      modelName: this.resolveAssignment(subtask).modelId,
    });

    const assignment = this.resolveAssignment(subtask);
    const prompt = this.context.buildSubtaskPrompt(subtask);
    const config: TaskConfig = {
      prompt,
      taskId: `${projectTaskId}-${subtask.id}`,
      modelId: assignment.modelId,
      sessionId,
      workingDirectory,
    };

    const subtaskTaskId = config.taskId as string;
    const callbacks = this.createSubtaskCallbacks(subtaskTaskId, assignment.modelId);
    let result: ProjectSubtaskResult;

    try {
      const task = await this.runSubtask(subtaskTaskId, config, callbacks);
      const output = this.extractTextOutput(task);
      const changedFiles = this.extractChangedFiles(output);
      result = {
        subtaskId: subtask.id,
        title: subtask.title,
        status: task.status === 'cancelled' || task.status === 'interrupted' ? 'cancelled' : 'completed',
        modelId: assignment.modelId,
        output,
        changedFiles,
      };
    } catch (error) {
      result = {
        subtaskId: subtask.id,
        title: subtask.title,
        status: 'failed',
        modelId: assignment.modelId,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.context.addResult(result);
    this.updateSubtaskStatus(
      subtask.id,
      result.status,
      result.status === 'failed' ? result.error : result.output,
    );
  }

  private updateSubtaskStatus(
    subtaskId: string,
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
    output?: string,
  ): void {
    if (!this.status) {
      return;
    }
    const entry = this.status.subtasks.find((s) => s.subtaskId === subtaskId);
    if (entry) {
      entry.status = status;
      if (output !== undefined) {
        entry.output = output;
      }
    }
    this.emit('status', this.status);
  }

  private markRemainingCancelled(plan: ProjectPlan): void {
    if (!this.status) {
      return;
    }
    const ids = new Set(plan.subtasks.map((s) => s.id));
    for (const entry of this.status.subtasks) {
      if (ids.has(entry.subtaskId) && entry.status === 'pending') {
        entry.status = 'cancelled';
      }
    }
    this.emit('status', this.status);
  }

  private async synthesize(
    projectTaskId: string,
    workingDirectory?: string,
    sessionId?: string,
  ): Promise<{
    synthesis: string;
    unfinished: string[];
    needsMoreSubtasks: boolean;
    followUpSubtasks: Array<{
      title: string;
      description: string;
      assignedModel?: string;
      fileEdits?: boolean;
      dependsOn?: string[];
    }>;
  }> {
    if (!this.context) {
      throw new Error('ProjectContext not initialized');
    }

    const coordinator = getCoordinatorModel();
    const prompt = this.context.buildSynthesisPrompt();
    const config: TaskConfig = {
      prompt,
      taskId: `${projectTaskId}-synthesis`,
      modelId: coordinator.modelId,
      sessionId,
      workingDirectory,
    };

    const synthesisTaskId = config.taskId as string;
    const callbacks = this.createSubtaskCallbacks(synthesisTaskId, coordinator.modelId);
    const task = await this.runSubtask(synthesisTaskId, config, callbacks);
    const raw = this.extractTextOutput(task);

    return this.parseSynthesis(raw);
  }

  private parseSynthesis(raw: string): {
    synthesis: string;
    unfinished: string[];
    needsMoreSubtasks: boolean;
    followUpSubtasks: Array<{
      title: string;
      description: string;
      assignedModel?: string;
      fileEdits?: boolean;
      dependsOn?: string[];
    }>;
  } {
    const candidate = raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? raw.trim();
    try {
      const parsed = JSON.parse(candidate);
      return {
        synthesis: typeof parsed.synthesis === 'string' ? parsed.synthesis : raw,
        unfinished: Array.isArray(parsed.unfinished) ? parsed.unfinished.filter((u: unknown) => typeof u === 'string') : [],
        needsMoreSubtasks: parsed.needsMoreSubtasks === true,
        followUpSubtasks: Array.isArray(parsed.followUpSubtasks) ? parsed.followUpSubtasks : [],
      };
    } catch {
      return { synthesis: raw, unfinished: [], needsMoreSubtasks: false, followUpSubtasks: [] };
    }
  }

  private buildPlanPrompt(goal: string): string {
    return [
      'You are a project coordinator. Break the following user goal into a small set of independent subtasks.',
      'Each subtask should be assignable to one of these models:',
      '- glm-5.3-flash:cloud for quick summaries, drafting, simple research, lightweight subtasks',
      '- gpt-oss:120b-cloud for careful analysis, architecture, planning, comparisons, risk assessment, math',
      '- kimi-k2.7-code:cloud for coding, debugging, tests, repository work, APIs, databases',
      'You (glm-5.3:cloud) handle coordination, synthesis, and follow-up planning.',
      '',
      `Goal: ${goal}`,
      '',
      'Return ONLY JSON in this shape (no extra prose):',
      '{',
      '  "summary": "one-line project summary",',
      '  "subtasks": [',
      '    {',
      '      "id": "unique-slug",',
      '      "title": "short title",',
      '      "description": "detailed prompt for the subtask",',
      '      "assignedModel": "fast" | "careful" | "code" | "coordinator",',
      '      "fileEdits": true | false,',
      '      "dependsOn": ["other-id"]',
      '    }',
      '  ]',
      '}',
      '',
      'Rules:',
      '- Keep subtasks independent when possible.',
      '- Mark fileEdits=true for any subtask that edits, renames, migrates, or deletes files.',
      '- fileEdits=true subtasks will run sequentially; others may run in parallel.',
      '- dependsOn references other subtask ids; avoid cycles.',
    ].join('\n');
  }

  private extractTextOutput(task: Task): string {
    if (task.result?.error) {
      return `Error: ${task.result.error}`;
    }
    const assistantMessages = task.messages.filter((m) => m.type === 'assistant' || m.type === 'tool');
    if (assistantMessages.length === 0) {
      return '';
    }
    return assistantMessages
      .map((m) => {
        let text = m.content;
        if (m.attachments && m.attachments.length > 0) {
          text +=
            '\n' +
            m.attachments
              .map((a) => (a.type === 'json' ? `[json: ${a.data}]` : `[attachment: ${a.label ?? a.type}]`))
              .join('\n');
        }
        return text;
      })
      .join('\n\n');
  }

  private extractChangedFiles(output: string): string[] {
    const changed: string[] = [];
    const regex = /(?:changed|modified|created|deleted|wrote)\s+(?:file\s+)?[`'"]?([a-zA-Z0-9_./\\~\-]+[.][a-zA-Z0-9]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
      changed.push(match[1]);
    }
    return [...new Set(changed)];
  }

  private createSubtaskCallbacks(taskId: string, modelName: string): TaskCallbacks {
    const base = createTaskCallbacks(taskId, this.service as never, this.storage, this.taskManager);
    const onComplete = base.onComplete;
    const wrappedOnComplete: typeof onComplete = (result) => {
      this.emit('subtask-complete', { taskId, modelName, result });
      return onComplete(result);
    };
    return { ...base, onComplete: wrappedOnComplete };
  }
}

/**
 * Map a ProjectStatus to TodoItem[] so the task panel's subtask list can show
 * each subtask's assigned model. Failed/cancelled subtasks are surfaced as
 * 'cancelled' in the todo list; authoritative state stays in ProjectStatus.
 */
export function projectStatusToTodos(
  status: ProjectStatus,
): Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority: 'high' | 'medium' | 'low'; model: string }> {
  return status.subtasks.map((subtask) => ({
    id: subtask.subtaskId,
    content: subtask.title,
    status:
      subtask.status === 'running'
        ? 'in_progress'
        : subtask.status === 'completed'
          ? 'completed'
          : subtask.status === 'pending'
            ? 'pending'
            : 'cancelled',
    priority: 'medium',
    model: subtask.modelId,
  }));
}
