import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ProjectOrchestrator, type ProjectOrchestratorOptions } from '../../src/project-orchestrator.js';
import type { Task, TaskCallbacks, TaskConfig, TaskManagerAPI, StorageAPI } from '@accomplish_ai/agent-core';

const coordinatorModel = 'glm-5.3:cloud';

function makeTask(id: string, content: string, status: Task['status'] = 'completed'): Task {
  return {
    id,
    prompt: content,
    summary: '',
    status,
    messages: [
      { id: '1', type: 'user', content, timestamp: new Date().toISOString() },
      { id: '2', type: 'assistant', content, timestamp: new Date().toISOString() },
    ],
    createdAt: new Date().toISOString(),
  } as Task;
}

function createFakeStorage(): StorageAPI {
  return {
    getTasks: vi.fn(() => []),
    getTask: vi.fn(() => null),
    saveTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    addTaskMessage: vi.fn(),
    getActiveProviderModel: vi.fn(() => null),
    getSelectedModel: vi.fn(() => null),
  } as unknown as StorageAPI;
}

function createFakeTaskManager(): TaskManagerAPI {
  return {
    startTask: vi.fn(),
    hasActiveTask: vi.fn(() => false),
    isTaskQueued: vi.fn(() => false),
  } as unknown as TaskManagerAPI;
}

describe('ProjectOrchestrator', () => {
  let opts: ProjectOrchestratorOptions;
  let runSubtaskMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runSubtaskMock = vi.fn();
    opts = {
      taskManager: createFakeTaskManager(),
      storage: createFakeStorage(),
      service: new EventEmitter(),
      runSubtask: runSubtaskMock,
    };
  });

  it('generates plan, runs subtasks, and synthesizes', async () => {
    runSubtaskMock.mockImplementation(async (taskId: string) => {
      if (taskId.includes('-plan')) {
        return makeTask(
          taskId,
          JSON.stringify({
            summary: 'Project plan',
            subtasks: [
              {
                id: 'research',
                title: 'Research models',
                description: 'Research available models.',
                assignedModel: 'fast',
                fileEdits: false,
                dependsOn: [],
              },
              {
                id: 'code',
                title: 'Write orchestrator',
                description: 'Implement orchestration.',
                assignedModel: 'code',
                fileEdits: true,
                dependsOn: ['research'],
              },
            ],
          }),
        );
      }
      if (taskId.includes('-synthesis')) {
        return makeTask(
          taskId,
          JSON.stringify({
            synthesis: 'Done.',
            unfinished: [],
            needsMoreSubtasks: false,
            followUpSubtasks: [],
          }),
        );
      }
      return makeTask(taskId, `Result for ${taskId}`);
    });

    const orchestrator = new ProjectOrchestrator(opts);
    const status = await orchestrator.run({
      goal: 'Build multi-model project mode',
      taskId: 'project-1',
    });

    expect(status.goal).toBe('Build multi-model project mode');
    expect(status.plan?.subtasks).toHaveLength(2);
    expect(status.subtasks).toHaveLength(2);
    expect(status.synthesis).toBe('Done.');

    // Plan + research + code + synthesis = 4 subtask invocations.
    expect(runSubtaskMock).toHaveBeenCalledTimes(4);

    // Ensure code subtask gets the code model.
    const codeCall = runSubtaskMock.mock.calls.find((c) => c[0].includes('-code'));
    expect(codeCall?.[1].modelId).toBe('kimi-k2.7-code:cloud');

    // Ensure plan prompt uses coordinator model.
    const planCall = runSubtaskMock.mock.calls.find((c) => c[0].includes('-plan'));
    expect(planCall?.[1].modelId).toBe(coordinatorModel);
  });

  it('stops queued subtasks from starting', async () => {
    runSubtaskMock.mockImplementation(async (taskId: string) => {
      if (taskId.includes('-plan')) {
        return makeTask(
          taskId,
          JSON.stringify({
            summary: 'Plan',
            subtasks: [
              { id: 'a', title: 'A', description: 'A', assignedModel: 'fast', fileEdits: false, dependsOn: [] },
              { id: 'b', title: 'B', description: 'B', assignedModel: 'fast', fileEdits: false, dependsOn: [] },
              { id: 'c', title: 'C', description: 'C', assignedModel: 'fast', fileEdits: false, dependsOn: ['a', 'b'] },
            ],
          }),
        );
      }
      if (taskId.includes('-synthesis')) {
        return makeTask(
          taskId,
          JSON.stringify({
            synthesis: 'Stopped.',
            unfinished: [],
            needsMoreSubtasks: false,
            followUpSubtasks: [],
          }),
        );
      }
      // Simulate long enough work that stop() wins before first batch finishes.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return makeTask(taskId, 'done');
    });

    const orchestrator = new ProjectOrchestrator(opts);
    const runPromise = orchestrator.run({ goal: 'test stop', taskId: 'project-2' });

    // Stop while the independent batch is still running; dependent subtask should be cancelled.
    setTimeout(() => {
      orchestrator.stop();
    }, 30);

    await runPromise;
    const status = orchestrator.getStatus();
    expect(status?.stopped).toBe(true);
    expect(status?.subtasks.filter((s) => s.status === 'cancelled').length).toBeGreaterThanOrEqual(1);
  });

  it('preserves context handoff between subtasks', async () => {
    runSubtaskMock.mockImplementation(async (taskId: string) => {
      if (taskId.includes('-plan')) {
        return makeTask(
          taskId,
          JSON.stringify({
            summary: 'Plan',
            subtasks: [
              {
                id: 'research',
                title: 'Research',
                description: 'Research.',
                assignedModel: 'fast',
                fileEdits: false,
                dependsOn: [],
              },
              {
                id: 'code',
                title: 'Code',
                description: 'Code.',
                assignedModel: 'code',
                fileEdits: true,
                dependsOn: ['research'],
              },
            ],
          }),
        );
      }
      if (taskId.includes('-synthesis')) {
        return makeTask(
          taskId,
          JSON.stringify({
            synthesis: 'Research then code.',
            unfinished: [],
            needsMoreSubtasks: false,
            followUpSubtasks: [],
          }),
        );
      }
      return makeTask(taskId, `changed file src/${taskId.split('-').pop()}.ts`);
    });

    const orchestrator = new ProjectOrchestrator(opts);
    await orchestrator.run({ goal: 'context handoff test', taskId: 'project-3' });

    const codeCall = runSubtaskMock.mock.calls.find((c) => c[0].includes('-code'));
    expect(codeCall?.[1].prompt).toContain('Project goal:');
    expect(codeCall?.[1].prompt).toContain('Research');
    expect(codeCall?.[1].prompt).toContain('src/research.ts');
  });
});
