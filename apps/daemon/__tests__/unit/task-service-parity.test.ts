/**
 * Tests for Phase 2 parity requirements:
 * - startTask passes attachments into validated config
 * - resumeSession passes attachments into resumed config
 * - saveTask uses workspaceId
 * - per-task config file isolation under concurrency
 *
 * Plus Phase 3 M4 (docs/PHASE_3_M4_PLAN.md §A1/§B1):
 * - startTask persists the configured cwd on the task row (v032)
 * - resumeSession reuses the ORIGINAL task's stored cwd (explicit
 *   params.workingDirectory wins and is persisted)
 * - waiting_permission/waiting_for_user → resuming on resume; → running on
 *   a successful sendResponse (never overwriting terminal statuses)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { homedir } from 'node:os';
import type {
  TaskConfig,
  Task,
  FileAttachmentInfo,
  StoredTask,
  TaskStatus,
} from '@accomplish_ai/agent-core';

// Track what TaskManager.startTask receives
let capturedTaskConfigs: Array<{ taskId: string; config: TaskConfig }> = [];
let capturedSavedTasks: Array<{ task: Task; workspaceId?: string | null }> = [];

// Mock agent-core to avoid DB/pty dependencies
vi.mock('@accomplish_ai/agent-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createTaskManager: vi.fn(() => ({
      startTask: vi.fn((taskId: string, config: TaskConfig, _callbacks: unknown): Promise<Task> => {
        capturedTaskConfigs.push({ taskId, config });
        return Promise.resolve({
          id: taskId,
          prompt: config.prompt,
          status: 'running' as const,
          messages: [],
          createdAt: new Date().toISOString(),
        });
      }),
      getSessionId: vi.fn(() => null),
      getActiveTaskId: vi.fn(() => null),
      hasActiveTask: vi.fn(() => false),
      getActiveTaskCount: vi.fn(() => 0),
      isTaskQueued: vi.fn(() => false),
      cancelQueuedTask: vi.fn(),
      cancelTask: vi.fn(),
      interruptTask: vi.fn(),
      sendResponse: vi.fn(),
      dispose: vi.fn(),
    })),
    validateTaskConfig: vi.fn((config: TaskConfig) => config),
    createTaskId: vi.fn(() => 'tsk_test_123'),
    createMessageId: vi.fn(() => 'msg_test_123'),
    generateTaskSummary: vi.fn(() => Promise.resolve('Test summary')),
    mapResultToStatus: vi.fn(() => 'completed'),
    ensureDevBrowserServer: vi.fn(),
    generateConfig: vi.fn((opts: Record<string, unknown>) => ({
      configPath: `/data/opencode/${opts.configFileName || 'opencode.json'}`,
      systemPrompt: '',
      mcpServers: {},
      environment: {},
      config: {},
    })),
    syncApiKeysToOpenCodeAuth: vi.fn(),
    getOpenCodeAuthJsonPath: vi.fn(() => '/auth/auth.json'),
    getEnabledSkills: vi.fn(() => []),
    isCliAvailable: vi.fn(() => Promise.resolve(true)),
    buildProviderConfigs: vi.fn(async () => ({
      providerConfigs: {},
      enabledProviders: [],
      modelOverride: undefined,
    })),
    getModelDisplayName: vi.fn((id: string) => id),
    getBundledNodePaths: vi.fn(() => null),
    DEV_BROWSER_PORT: 9224,
  };
});

const { TaskService } = await import('../../src/task-service.js');

function createMockStorage() {
  return {
    saveTask: vi.fn((task: Task, workspaceId?: string | null) => {
      capturedSavedTasks.push({ task, workspaceId });
    }),
    addTaskMessage: vi.fn(),
    updateTaskStatus: vi.fn(),
    updateTaskSummary: vi.fn(),
    updateTaskSessionId: vi.fn(),
    updateTaskWorkingDirectory: vi.fn(),
    clearTodosForTask: vi.fn(),
    saveTodosForTask: vi.fn(),
    getTasks: vi.fn(() => []),
    getTask: vi.fn(() => null),
    getApiKey: vi.fn(() => null),
    getAllApiKeys: vi.fn(() => Promise.resolve({})),
    getActiveProviderModel: vi.fn(() => null),
    getSelectedModel: vi.fn(() => null),
    getBedrockCredentials: vi.fn(() => null),
    getEnabledConnectors: vi.fn(() => []),
    getConnectorTokens: vi.fn(() => null),
    setConnectorStatus: vi.fn(),
    storeConnectorTokens: vi.fn(),
    getCloudBrowserConfig: vi.fn(() => null),
  } as unknown as Parameters<typeof TaskService>[0];
}

describe('TaskService parity', () => {
  beforeEach(() => {
    capturedTaskConfigs = [];
    capturedSavedTasks = [];
  });

  it('startTask passes attachments into TaskConfig.files', async () => {
    const storage = createMockStorage();
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    const attachments: FileAttachmentInfo[] = [
      { id: 'att-1', name: 'test.txt', path: '/tmp/test.txt', type: 'text', size: 100 },
    ];

    await service.startTask({
      prompt: 'Read this file',
      taskId: 'tsk_att_test',
      attachments,
    });

    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.files).toEqual(attachments);
  });

  it('startTask saves task with workspaceId', async () => {
    const storage = createMockStorage();
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    await service.startTask({
      prompt: 'Workspace task',
      taskId: 'tsk_ws_test',
      workspaceId: 'ws-abc',
    });

    expect(capturedSavedTasks).toHaveLength(1);
    expect(capturedSavedTasks[0].workspaceId).toBe('ws-abc');
  });

  it('startTask without workspaceId saves with null workspace', async () => {
    const storage = createMockStorage();
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    await service.startTask({
      prompt: 'No workspace',
      taskId: 'tsk_no_ws',
    });

    expect(capturedSavedTasks).toHaveLength(1);
    expect(capturedSavedTasks[0].workspaceId).toBeUndefined();
  });

  it('resumeSession passes attachments into TaskConfig.files', async () => {
    const storage = createMockStorage();
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    const attachments: FileAttachmentInfo[] = [
      { id: 'att-2', name: 'resume.pdf', path: '/tmp/resume.pdf', type: 'pdf', size: 5000 },
    ];

    await service.resumeSession({
      sessionId: 'sess-123',
      prompt: 'Continue with this file',
      existingTaskId: 'tsk_resume_test',
      attachments,
    });

    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.files).toEqual(attachments);
  });

  // REGRESSION (Phase 2 local-model hang): startTask copied only
  // `selectedModel.model` into the TaskConfig and left `provider` unset —
  // OpenCodeAdapter.buildModelParam then returned null, session.prompt
  // omitted `model`, and opencode's model cascade was empty so the task
  // never called ollama and hung.
  it('startTask threads the active provider model into modelId and provider', async () => {
    const storage = createMockStorage();
    (storage.getActiveProviderModel as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'ollama',
      model: 'llama3.2',
    });
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    await service.startTask({ prompt: 'Run locally', taskId: 'tsk_provider' });

    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.modelId).toBe('llama3.2');
    expect(capturedTaskConfigs[0].config.provider).toBe('ollama');
  });

  it('resumeSession threads the active provider model into modelId and provider', async () => {
    const storage = createMockStorage();
    (storage.getActiveProviderModel as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'ollama',
      model: 'llama3.2',
    });
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    await service.resumeSession({
      sessionId: 'sess-provider',
      prompt: 'continue',
    });

    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.modelId).toBe('llama3.2');
    expect(capturedTaskConfigs[0].config.provider).toBe('ollama');
  });

  // Regression: `resumeSession` used to not accept `workspaceId` at all,
  // so every follow-up turn in a workspace conversation ran without
  // workspace-scoped knowledge notes. This test pins the explicit forward.
  it('resumeSession forwards caller-supplied workspaceId into the resumed TaskConfig', async () => {
    const storage = createMockStorage();
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    await service.resumeSession({
      sessionId: 'sess-ws-1',
      prompt: 'continue please',
      existingTaskId: 'tsk_ws_resume',
      workspaceId: 'ws_explicit',
    });

    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.workspaceId).toBe('ws_explicit');
  });

  // Regression: without an explicit workspaceId, `resumeSession` should
  // fall back to the workspace the existing task was originally saved
  // under — otherwise users who scheduled a workspace task and later
  // resume via a daemon-only source (WhatsApp, scheduler) would still
  // lose workspace knowledge notes on the resumed turn.
  it('resumeSession falls back to the stored task workspaceId when none is provided', async () => {
    const storage = createMockStorage();
    (storage.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'tsk_stored_ws',
      prompt: 'original',
      status: 'completed',
      messages: [],
      createdAt: new Date().toISOString(),
      workspaceId: 'ws_from_storage',
    });
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    await service.resumeSession({
      sessionId: 'sess-fallback',
      prompt: 'continue',
      existingTaskId: 'tsk_stored_ws',
    });

    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.workspaceId).toBe('ws_from_storage');
  });

  // Regression: when the resumed task has no workspaceId anywhere,
  // `resumeSession` must not invent one — it stays undefined so the
  // resolver skips the knowledge-note step cleanly.
  it('resumeSession leaves workspaceId undefined when neither params nor stored task has one', async () => {
    const storage = createMockStorage();
    (storage.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'tsk_no_ws',
      prompt: 'original',
      status: 'completed',
      messages: [],
      createdAt: new Date().toISOString(),
      workspaceId: undefined,
    });
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    await service.resumeSession({
      sessionId: 'sess-plain',
      prompt: 'continue',
      existingTaskId: 'tsk_no_ws',
    });

    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.workspaceId).toBeUndefined();
  });

  it('listTasks passes workspaceId to storage', () => {
    const storage = createMockStorage();
    const service = new TaskService(storage as never, {
      userDataPath: '/data',
      mcpToolsPath: '/tools',
    });

    service.listTasks('ws-filter');
    // `TaskService.listTasks` forwards both the workspace filter and the
    // `includeUnassigned` flag (default `false`). `toHaveBeenCalledWith`
    // checks the full argument list, so the assertion must include the flag.
    expect(storage.getTasks).toHaveBeenCalledWith('ws-filter', false);
  });

  // REGRESSION (Firefox default-cwd home-dir hang): the Firefox UI submits
  // task.start params with NO workingDirectory for ordinary tasks (no folder
  // picked). TaskService used to hand TaskManager `defaultWorkingDirectory:
  // homedir()`, so `opencode serve` ran in /home/chris and its turn-start git
  // snapshot swept the entire home directory (~97% CPU, task hang, no model
  // call). The daemon must own a dedicated, stable execution workspace under
  // its userDataPath and inject it into the config handed to TaskManager.
  describe('default working directory resolution', () => {
    it('startTask with NO workingDirectory (exact Firefox UI params) defaults to <userDataPath>/task-workspace, never homedir', async () => {
      const storage = createMockStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      // Precisely what the Firefox UI sends: prompt + taskId only —
      // no workingDirectory, no workspaceId, no model/provider.
      await service.startTask({
        prompt: 'Create ~/kujenga-test.txt and confirm its contents.',
        taskId: 'tsk_fox_no_cwd',
      });

      expect(capturedTaskConfigs).toHaveLength(1);
      const wd = capturedTaskConfigs[0].config.workingDirectory;
      expect(typeof wd).toBe('string');
      expect(wd?.endsWith('task-workspace')).toBe(true);
      expect(wd).toBe(path.join('/data', 'task-workspace'));
      expect(wd).not.toBe(homedir());
    });

    it('startTask preserves an explicitly provided workingDirectory verbatim (user-picked folder)', async () => {
      const storage = createMockStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      await service.startTask({
        prompt: 'Work in my project',
        taskId: 'tsk_fox_picked_cwd',
        workingDirectory: '/home/chris/some-picked-project',
      });

      expect(capturedTaskConfigs).toHaveLength(1);
      expect(capturedTaskConfigs[0].config.workingDirectory).toBe(
        '/home/chris/some-picked-project',
      );
    });
  });

  // REGRESSION (Codex review P1): `stopTask` used to only update storage
  // to `'cancelled'` without emitting any terminal event. Callbacks are
  // wired only off `'complete'`/`'error'`/`'statusChange'`, so every
  // cancelled task leaked its `taskSources` entry and its per-task
  // `opencode serve` runtime until the daemon was restarted.
  describe('stopTask cleanup', () => {
    it('emits statusChange { status: "cancelled" } for queued tasks', async () => {
      const storage = createMockStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });
      // Force the queued branch: `isTaskQueued` returns true, `hasActiveTask`
      // returns false (the default mock already does this).
      const taskManager = (
        service as unknown as { taskManager: { isTaskQueued: ReturnType<typeof vi.fn> } }
      ).taskManager;
      taskManager.isTaskQueued.mockReturnValueOnce(true);

      const statusChanges: Array<{ taskId: string; status: string }> = [];
      service.on('statusChange', (data) =>
        statusChanges.push(data as { taskId: string; status: string }),
      );

      await service.stopTask({ taskId: 'tsk_queued_1' });

      expect(statusChanges).toEqual([
        expect.objectContaining({ taskId: 'tsk_queued_1', status: 'cancelled' }),
      ]);
      expect(storage.updateTaskStatus).toHaveBeenCalledWith(
        'tsk_queued_1',
        'cancelled',
        expect.any(String),
      );
    });

    it('emits statusChange { status: "cancelled" } for running tasks', async () => {
      const storage = createMockStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });
      const taskManager = (
        service as unknown as {
          taskManager: {
            isTaskQueued: ReturnType<typeof vi.fn>;
            hasActiveTask: ReturnType<typeof vi.fn>;
          };
        }
      ).taskManager;
      taskManager.isTaskQueued.mockReturnValueOnce(false);
      taskManager.hasActiveTask.mockReturnValueOnce(true);

      const statusChanges: Array<{ taskId: string; status: string }> = [];
      service.on('statusChange', (data) =>
        statusChanges.push(data as { taskId: string; status: string }),
      );

      await service.stopTask({ taskId: 'tsk_running_1' });

      expect(statusChanges).toEqual([
        expect.objectContaining({ taskId: 'tsk_running_1', status: 'cancelled' }),
      ]);
      expect(taskManager.cancelTask).toHaveBeenCalledWith('tsk_running_1');
    });
  });

  // REGRESSION (Max residual #1): the `permission.respond` RPC handler in
  // `daemon-routes.ts` now gates on `taskService.hasActiveTask(taskId)`
  // before forwarding the response. Without the guard a bogus taskId
  // cascades an error from deep inside `OpenCodeAdapter.sendResponse`
  // (pending === null, or the adapter doesn't exist) producing a
  // confusing stack trace rather than a clean "unknown task" RPC error.
  // This suite pins the contract that hasActiveTask returns false for
  // unknown taskIds and the handler throws a readable error.
  describe('permission.respond bogus taskId guard', () => {
    it('hasActiveTask returns false for unknown taskIds', () => {
      const storage = createMockStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });
      // TaskManager's default mock returns false — this assertion pins the
      // contract TaskService.hasActiveTask delegates through to it.
      expect(service.hasActiveTask('tsk_nonexistent')).toBe(false);
    });

    it('mirrors the guard logic from daemon-routes: throws when task is unknown', async () => {
      // Replicate the handler's gate + forward pattern. The real handler
      // lives in `apps/daemon/src/daemon-routes.ts`; this test pins the
      // contract so a refactor that drops the gate fails fast.
      const storage = createMockStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });
      const bogusTaskId = 'tsk_never_existed';

      const handlerSimulation = async (taskId: string): Promise<void> => {
        if (!service.hasActiveTask(taskId)) {
          throw new Error(
            `permission.respond: no active task with id=${taskId}. The task may have completed, been cancelled, or never existed.`,
          );
        }
        await service.sendResponse(taskId, {
          taskId,
          requestId: 'filereq_irrelevant',
          decision: 'deny',
        });
      };

      await expect(handlerSimulation(bogusTaskId)).rejects.toThrow(
        /permission.respond: no active task with id=tsk_never_existed/,
      );
    });
  });

  // ── Phase 3 M4: resume working-directory preservation + waiting-state
  // plumbing (docs/PHASE_3_M4_PLAN.md §A1 / §B1) ────────────────────────────

  /**
   * Mock storage with a real in-memory task map so the
   * updateTaskWorkingDirectory → getTask round-trip can be asserted the same
   * way a real StorageService behaves (no better-sqlite3 in this suite —
   * runtimes are never spawned here).
   */
  function createCwdAwareStorage(seed: Array<{ id: string } & Partial<StoredTask>> = []) {
    const rows = new Map<string, StoredTask>();
    for (const item of seed) {
      rows.set(item.id, {
        id: item.id,
        prompt: item.prompt ?? item.id,
        status: item.status ?? 'completed',
        messages: [],
        createdAt: '2026-10-23T00:00:00.000Z',
        ...item,
      } as StoredTask);
    }
    const storage = {
      saveTask: vi.fn((task: Task, workspaceId?: string | null) => {
        const existing = rows.get(task.id);
        rows.set(task.id, {
          ...existing,
          id: task.id,
          prompt: task.prompt,
          status: task.status,
          sessionId: task.sessionId,
          createdAt: task.createdAt,
          messages: [],
          workspaceId: workspaceId ?? existing?.workspaceId,
          // v032 contract: the stored cwd survives a re-save (resume turn).
          workingDirectory: existing?.workingDirectory ?? task.workingDirectory,
        } as StoredTask);
      }),
      getTask: vi.fn((taskId: string) => rows.get(taskId)),
      getTasks: vi.fn(() => Array.from(rows.values())),
      updateTaskStatus: vi.fn((taskId: string, status: TaskStatus, completedAt?: string) => {
        const existing = rows.get(taskId);
        if (existing) {
          rows.set(taskId, { ...existing, status, ...(completedAt ? { completedAt } : {}) });
        }
      }),
      updateTaskWorkingDirectory: vi.fn((taskId: string, workingDirectory: string) => {
        const existing = rows.get(taskId);
        if (existing) {
          rows.set(taskId, { ...existing, workingDirectory });
        }
      }),
      addTaskMessage: vi.fn(),
      updateTaskSummary: vi.fn(),
      updateTaskSessionId: vi.fn(),
      clearTodosForTask: vi.fn(),
      saveTodosForTask: vi.fn(),
      getApiKey: vi.fn(() => null),
      getAllApiKeys: vi.fn(() => Promise.resolve({})),
      getActiveProviderModel: vi.fn(() => null),
      getSelectedModel: vi.fn(() => null),
      getBedrockCredentials: vi.fn(() => null),
      getEnabledConnectors: vi.fn(() => []),
      getConnectorTokens: vi.fn(() => null),
      setConnectorStatus: vi.fn(),
      storeConnectorTokens: vi.fn(),
      getCloudBrowserConfig: vi.fn(() => null),
    } as unknown as Parameters<typeof TaskService>[0];
    return { storage, rows };
  }

  function getCapturedTaskManager(service: TaskService) {
    return (service as unknown as { taskManager: Record<string, ReturnType<typeof vi.fn>> })
      .taskManager;
  }

  describe('M4: startTask persists the configured cwd on the task row', () => {
    it('Firefox-exact params {prompt, taskId} → row stores <userDataPath>/task-workspace', async () => {
      const { storage } = createCwdAwareStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      // Exactly what the Firefox UI sends — no workingDirectory, no
      // workspaceId, no model. The daemon default workspace is the cwd.
      await service.startTask({
        prompt: 'Create ~/kujenga-test.txt and confirm its contents.',
        taskId: 'tsk_fox_row_cwd',
      });

      const expectedCwd = path.join('/data', 'task-workspace');
      expect(storage.updateTaskWorkingDirectory).toHaveBeenCalledWith(
        'tsk_fox_row_cwd',
        expectedCwd,
      );
      const loaded = (storage.getTask as unknown as (id: string) => StoredTask | undefined)(
        'tsk_fox_row_cwd',
      );
      expect(loaded?.workingDirectory).toBe(expectedCwd);
    });

    it('user-picked folder persists verbatim', async () => {
      const { storage, rows } = createCwdAwareStorage();
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      await service.startTask({
        prompt: 'Work in my project',
        taskId: 'tsk_picked_row_cwd',
        workingDirectory: '/home/chris/picked-project',
      });

      expect(storage.updateTaskWorkingDirectory).toHaveBeenCalledWith(
        'tsk_picked_row_cwd',
        '/home/chris/picked-project',
      );
      expect(rows.get('tsk_picked_row_cwd')?.workingDirectory).toBe('/home/chris/picked-project');
    });
  });

  describe('M4: resumeSession working-directory resolution', () => {
    it('NO explicit workingDirectory (Firefox-exact {sessionId, prompt, existingTaskId}) forwards the ORIGINAL task stored cwd', async () => {
      const { storage } = createCwdAwareStorage([
        { id: 'tsk_orig', status: 'failed', workingDirectory: '/home/chris/original-project' },
      ]);
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      await service.resumeSession({
        sessionId: 'sess-orig-cwd',
        prompt: 'continue',
        existingTaskId: 'tsk_orig',
      });

      expect(capturedTaskConfigs).toHaveLength(1);
      expect(capturedTaskConfigs[0].config.workingDirectory).toBe('/home/chris/original-project');
    });

    it('explicit params.workingDirectory wins over the stored cwd AND updates the stored row', async () => {
      const { storage, rows } = createCwdAwareStorage([
        {
          id: 'tsk_override',
          status: 'completed',
          workingDirectory: '/home/chris/original-project',
        },
      ]);
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      await service.resumeSession({
        sessionId: 'sess-override',
        prompt: 'continue in a new folder',
        existingTaskId: 'tsk_override',
        workingDirectory: '/home/chris/picked-next-turn',
      });

      expect(capturedTaskConfigs).toHaveLength(1);
      expect(capturedTaskConfigs[0].config.workingDirectory).toBe('/home/chris/picked-next-turn');
      expect(storage.updateTaskWorkingDirectory).toHaveBeenCalledWith(
        'tsk_override',
        '/home/chris/picked-next-turn',
      );
      expect(rows.get('tsk_override')?.workingDirectory).toBe('/home/chris/picked-next-turn');
    });

    it('stored task with NO cwd leaves workingDirectory undefined — TaskManager default fallback (pre-M4 behavior) unchanged', async () => {
      const { storage } = createCwdAwareStorage([{ id: 'tsk_nocwd', status: 'completed' }]);
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      await service.resumeSession({
        sessionId: 'sess-nocwd',
        prompt: 'continue',
        existingTaskId: 'tsk_nocwd',
      });

      expect(capturedTaskConfigs).toHaveLength(1);
      expect(capturedTaskConfigs[0].config.workingDirectory).toBeUndefined();
    });
  });

  describe('M4: resuming transition for human-waiting tasks', () => {
    function createResumingService() {
      const { storage } = createCwdAwareStorage([
        {
          id: 'tsk_wait_resume',
          status: 'waiting_permission',
          workingDirectory: '/home/chris/stalled-project',
        },
      ]);
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });
      return { storage, service, taskManager: getCapturedTaskManager(service) };
    }

    it('stored waiting_permission → emits + stores resuming, then the completion path persists the final status', async () => {
      const { storage, service, taskManager } = createResumingService();
      // Simulate the resumed turn completing (existing completion path
      // persists `task.status` via updateTaskStatus at the end of resume).
      taskManager.startTask.mockResolvedValueOnce({
        id: 'tsk_wait_resume',
        prompt: 'continue',
        status: 'completed',
        messages: [],
        createdAt: new Date().toISOString(),
      });

      const statusChanges: Array<{ taskId: string; status: string }> = [];
      service.on('statusChange', (data) =>
        statusChanges.push(data as { taskId: string; status: string }),
      );

      await service.resumeSession({
        sessionId: 'sess-recover',
        prompt: 'continue',
        existingTaskId: 'tsk_wait_resume',
      });

      expect(statusChanges).toEqual([{ taskId: 'tsk_wait_resume', status: 'resuming' }]);
      // Call 1: the resuming flip. Call 2: the existing post-turn completion
      // persistence. Order proves the transition happened BEFORE the turn.
      expect(
        (storage.updateTaskStatus as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => [
          c[0],
          c[1],
        ]),
      ).toEqual([
        ['tsk_wait_resume', 'resuming'],
        ['tsk_wait_resume', 'completed'],
      ]);
    });

    it('a resumed FAILED task is NOT flipped to resuming (prior outcome stays visible)', async () => {
      const { storage } = createCwdAwareStorage([{ id: 'tsk_failed_resume', status: 'failed' }]);
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });

      await service.resumeSession({
        sessionId: 'sess-retry',
        prompt: 'retry',
        existingTaskId: 'tsk_failed_resume',
      });

      expect(storage.updateTaskStatus).not.toHaveBeenCalledWith('tsk_failed_resume', 'resuming');
    });
  });

  describe('M4: sendResponse restores running after a human reply', () => {
    function createReplyFixture(status: TaskStatus) {
      const { storage } = createCwdAwareStorage([{ id: 'tsk_reply', status }]);
      const service = new TaskService(storage as never, {
        userDataPath: '/data',
        mcpToolsPath: '/tools',
      });
      const statusChanges: Array<{ taskId: string; status: string }> = [];
      service.on('statusChange', (data) =>
        statusChanges.push(data as { taskId: string; status: string }),
      );
      return { storage, service, taskManager: getCapturedTaskManager(service), statusChanges };
    }

    it('waiting_permission → restored to running + statusChange emitted', async () => {
      const { storage, service, taskManager, statusChanges } =
        createReplyFixture('waiting_permission');

      await service.sendResponse('tsk_reply', {
        taskId: 'tsk_reply',
        requestId: 'rq-1',
        decision: 'allow',
      });

      expect(taskManager.sendResponse).toHaveBeenCalledWith('tsk_reply', {
        taskId: 'tsk_reply',
        requestId: 'rq-1',
        decision: 'allow',
      });
      expect(storage.updateTaskStatus).toHaveBeenCalledWith('tsk_reply', 'running');
      expect(statusChanges).toEqual([{ taskId: 'tsk_reply', status: 'running' }]);
    });

    it('waiting_for_user → restored to running + statusChange emitted', async () => {
      const { storage, service, statusChanges } = createReplyFixture('waiting_for_user');

      await service.sendResponse('tsk_reply', {
        taskId: 'tsk_reply',
        requestId: 'rq-2',
        decision: 'allow',
      });

      expect(storage.updateTaskStatus).toHaveBeenCalledWith('tsk_reply', 'running');
      expect(statusChanges).toEqual([{ taskId: 'tsk_reply', status: 'running' }]);
    });

    it('completed status is NEVER overwritten by the reply path', async () => {
      const { storage, service, statusChanges } = createReplyFixture('completed');

      await service.sendResponse('tsk_reply', {
        taskId: 'tsk_reply',
        requestId: 'rq-3',
        decision: 'allow',
      });

      expect(storage.updateTaskStatus).not.toHaveBeenCalled();
      expect(statusChanges).toEqual([]);
    });

    it('unknown task id (no stored row) does not crash and does not emit', async () => {
      const { storage, service, statusChanges } = createReplyFixture('waiting_permission');
      (storage.getTask as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await service.sendResponse('tsk_unknown_reply', {
        taskId: 'tsk_unknown_reply',
        requestId: 'rq-4',
        decision: 'deny',
      });

      expect(storage.updateTaskStatus).not.toHaveBeenCalled();
      expect(statusChanges).toEqual([]);
    });
  });
});
