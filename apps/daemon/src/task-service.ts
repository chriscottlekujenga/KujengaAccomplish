import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTaskManager,
  createTaskId,
  createMessageId,
  validateTaskConfig,
  getModelDisplayName,
  ASSISTANCE_DECLINE_REASON,
  buildAssistanceContinuationPrompt,
  formatAssistanceAnswer,
  detectCredentialRequest,
  assertCredentialSafeAnswer,
  type TaskManagerAPI,
  type TaskCallbacks,
  type TaskConfig,
  type Task,
  type TaskResult,
  type TaskMessage,
  type TaskStatus,
  type StorageAPI,
  type PermissionResponse,
  type TaskSource,
  type FileAttachmentInfo,
  type StoredTask,
} from '@accomplish_ai/agent-core';
import {
  type TaskConfigBuilderOptions,
  isCliAvailable,
  onBeforeStart,
  createOnBeforeTaskStart,
  createTaskCallbacks,
  runTaskSummaryGeneration,
} from './task-config-builder.js';
import { OpenCodeServerManager } from './opencode/server-manager.js';

import { type TaskServiceEvents, type TaskServiceOptions } from './task-service-events.js';
import { log } from './logger.js';

export type { TaskServiceEvents, TaskServiceOptions };

export class TaskService extends EventEmitter {
  private taskManager: TaskManagerAPI;
  private storage: StorageAPI;
  private opts: TaskConfigBuilderOptions;
  private interactivePresenceProbe: { hasInteractiveClients(): boolean };
  private serverManager: OpenCodeServerManager;
  /**
   * Dedicated default execution workspace for tasks that do not carry a
   * user-picked folder. Using the home directory here made `opencode serve`
   * run its turn-start git snapshot against the entire home tree (~97% CPU,
   * task hang). Resolved once per TaskService so warm runtime reuse (≤60s)
   * and resume turns see a stable cwd.
   */
  private defaultWorkingDirectory: string;

  /**
   * Per-task origin map. Populated at task start, read by the source-based
   * no-UI auto-deny policy in `task-callbacks.ts` (Phase 2 of the SDK cutover
   * port) and cleared when the task is removed from activeTasks. Not intended
   * for RPC exposure; strictly internal to the daemon.
   */
  private taskSources = new Map<string, TaskSource>();

  constructor(storage: StorageAPI, options: TaskServiceOptions) {
    super();
    this.storage = storage;
    this.opts = {
      ...options,
      isPackaged: options.isPackaged ?? false,
      resourcesPath: options.resourcesPath ?? '',
      appPath: options.appPath ?? '',
      accomplishRuntime: options.accomplishRuntime,
    };
    // Stable default execution workspace under the daemon's data dir.
    // Created eagerly (idempotent); a failure must not block construction —
    // user-picked folders still work and the runtime error would surface
    // at spawn time, so we only log and fall back to the uncreated path.
    this.defaultWorkingDirectory = path.join(this.opts.userDataPath, 'task-workspace');
    try {
      mkdirSync(this.defaultWorkingDirectory, { recursive: true });
    } catch (err) {
      log.warn(
        `[TaskService] Failed to create default task workspace at ${this.defaultWorkingDirectory}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Default probe: treat interactive UI as always connected. Tests +
    // tooling that construct TaskService without an RPC server get this
    // default — the no-UI auto-deny path is never triggered, which keeps
    // unit tests deterministic. The real daemon wires
    // `rpc.hasInteractiveClients` (Phase 3 M1 presence gate).
    this.interactivePresenceProbe = options.interactivePresenceProbe ?? {
      hasInteractiveClients: () => true,
    };

    // Drop the per-task source entry when the task finishes, whether via
    // success, error, or cancel. Listening to our own emitter (task-callbacks
    // emits into `this`) keeps the bookkeeping local without exposing the map.
    // M6-A T2 (D4): the same terminal listeners clear the persisted pending
    // request — a terminal outcome (or a cancel) must never leave a parked
    // question row on disk, so no later reply can resurrect a resolved ask.
    this.on('complete', (data: { taskId: string }) => {
      this.taskSources.delete(data.taskId);
      this.serverManager.scheduleTaskRuntimeCleanup(data.taskId);
      this.storage.updateTaskPendingRequest(data.taskId, null);
    });
    this.on('error', (data: { taskId: string }) => {
      this.taskSources.delete(data.taskId);
      this.serverManager.scheduleTaskRuntimeCleanup(data.taskId);
      this.storage.updateTaskPendingRequest(data.taskId, null);
    });
    // The cancel path originally had no terminal callback — `TaskManager.
    // cancelTask()` just aborts the adapter without emitting `complete` or
    // `error`, so the internal `taskSources` entry and the per-task
    // `opencode serve` runtime both leaked every time a user cancelled a
    // task. `stopTask` now emits `'statusChange'` with `status: 'cancelled'`
    // after it asks the TaskManager to abort, and this listener runs the
    // same cleanup the other two terminal paths run.
    this.on('statusChange', (data: { taskId: string; status: string }) => {
      if (data.status === 'cancelled') {
        this.taskSources.delete(data.taskId);
        this.serverManager.scheduleTaskRuntimeCleanup(data.taskId);
        this.storage.updateTaskPendingRequest(data.taskId, null);
      }
    });

    // Per-task `opencode serve` manager. Spawns one serve process per task,
    // cleans up on idle. The `getServerUrl` closure below is handed to the
    // SDK adapter so it can connect its `createOpencodeClient` to the right
    // runtime.
    this.serverManager = new OpenCodeServerManager({
      storage,
      userDataPath: this.opts.userDataPath,
      mcpToolsPath: this.opts.mcpToolsPath,
      isPackaged: this.opts.isPackaged,
      resourcesPath: this.opts.resourcesPath,
      appPath: this.opts.appPath,
      accomplishRuntime: this.opts.accomplishRuntime,
    });

    this.taskManager = createTaskManager({
      adapterOptions: {
        platform: process.platform,
        isPackaged: this.opts.isPackaged,
        tempPath: tmpdir(),
        // The SDK adapter no longer spawns a CLI per task — `opencode serve`
        // is started by `OpenCodeServerManager` (one per task) and the SDK
        // talks HTTP. `onBeforeStart` still runs to write the per-task
        // `opencode.json`, sync API keys to `auth.json`, and surface
        // `OPENCODE_CONFIG[_DIR]` so the spawned `opencode serve` picks them up.
        //
        // The adapter passes a per-task `ctx` with `taskId` + `workspaceId`;
        // we forward it unchanged. `resolveTaskConfig` inside `onBeforeStart`
        // consumes `ctx.workspaceId` for knowledge-note injection and uses
        // `ctx.taskId` to compute a per-task config filename.
        onBeforeStart: async (ctx) => {
          const result = await onBeforeStart(this.storage, this.opts, ctx);
          // Return the rich `OnBeforeStartResult` shape so the adapter
          // can inject `workspaceInstructions` as a compact `system`
          // block on every `session.prompt` call. Agent-level prompts
          // alone lose to provider-native instruction channels; see
          // `OpenCodeAdapter.buildWorkspaceInstructionRuntimeBlock`.
          return {
            env: result.env,
            ...(result.workspaceInstructions
              ? { workspaceInstructions: result.workspaceInstructions }
              : {}),
          };
        },
        // SDK-based adapter resolves its `opencode serve` URL here. The
        // optional `ctx` carries the same per-task context into the
        // server-manager's own `onBeforeStart` call so the spawned
        // `opencode serve` sees the workspace-scoped config.
        getServerUrl: async (taskId, ctx) => {
          await this.serverManager.ensureTaskRuntime(taskId, ctx);
          return this.serverManager.waitForServerUrl(taskId);
        },
        getModelDisplayName,
        // Optional proxy tagger — the adapter calls this on task start
        // (with taskId) and teardown (with undefined). Wired by the daemon
        // when the optional runtime package is present; undefined for
        // pure OSS builds (no-op).
        setProxyTaskId: options.setProxyTaskId,
      },
      defaultWorkingDirectory: this.defaultWorkingDirectory,
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
    systemPromptAppend?: string;
    /**
     * User-attached files forwarded from the desktop IPC layer. Must flow
     * into `TaskConfig.files` so OpenCode picks them up — the RPC schema
     * at `daemon.ts:86` + `validation.ts:22` already accepts this field,
     * and `validateTaskConfig` passes it through. Dropping it here means
     * every drag-and-drop / attachment a user submits is silently lost.
     */
    attachments?: FileAttachmentInfo[];
    /**
     * Originating surface. Drives the no-UI auto-deny safeguard for
     * permission/question prompts when the task runs headlessly. Defaults
     * to `'ui'` when not provided. WhatsApp bridge and scheduler callers
     * must set this explicitly.
     */
    source?: TaskSource;
    /**
     * Restrict the OpenCode agent to a subset of tool names. Forwarded
     * from the desktop IPC and accepted by both the RPC schema
     * (`TaskStartParams.allowedTools`) and the zod taskConfigSchema.
     * Dropping it here means the "advertised but silently ignored"
     * gap Codex P2 flagged.
     */
    allowedTools?: string[];
    /**
     * Machine-readable output schema the task should produce. Same
     * "daemon advertised but dropped" gap — RPC accepts it, config type
     * accepts it, `validateTaskConfig` passes it through; this builder
     * must forward it into `config.outputSchema`.
     */
    outputSchema?: object;
  }): Promise<Task> {
    const taskId = params.taskId || createTaskId();
    const config: TaskConfig = {
      prompt: params.prompt,
      taskId,
      modelId: params.modelId,
      sessionId: params.sessionId,
      // Firefox/desktop UIs omit workingDirectory for ordinary tasks. Inject
      // the daemon-owned default workspace here (instead of relying solely on
      // TaskManager's fallback) so the persisted config always carries an
      // explicit cwd; empty-string params collapse to the default too, which
      // mirrors TaskManager's `||` semantics.
      workingDirectory: params.workingDirectory || this.defaultWorkingDirectory,
      workspaceId: params.workspaceId,
      systemPromptAppend: params.systemPromptAppend,
      files: params.attachments,
      allowedTools: params.allowedTools,
      outputSchema: params.outputSchema,
      source: params.source,
    };
    const validatedConfig = validateTaskConfig(config);
    // Record task source for the no-UI auto-deny policy in task-callbacks.
    // Validation defaults unknown/missing values to undefined; treat as 'ui'.
    this.taskSources.set(taskId, validatedConfig.source ?? 'ui');
    const activeModel = this.storage.getActiveProviderModel();
    const selectedModel = activeModel || this.storage.getSelectedModel();
    if (selectedModel?.model && !validatedConfig.modelId) {
      validatedConfig.modelId = selectedModel.model;
      // Without `provider`, OpenCodeAdapter.buildModelParam returns null and
      // session.prompt omits `model` — opencode's model cascade is then empty
      // and the task hangs on local providers (e.g. ollama).
      validatedConfig.provider = selectedModel.provider;
    }

    const task = await this._runTask(taskId, validatedConfig);

    const initialUserMessage: TaskMessage = {
      id: createMessageId(),
      type: 'user',
      content: validatedConfig.prompt,
      timestamp: new Date().toISOString(),
    };
    task.messages = [initialUserMessage];
    this.storage.saveTask(task, params.workspaceId);
    // M4: persist the configured cwd on the task row (v032). saveTask stores
    // `task.workingDirectory || null` and the TaskManager-built task carries
    // no cwd, so without this the row stays NULL and a resume turn would not
    // be able to recover the original folder. Must run AFTER saveTask.
    if (validatedConfig.workingDirectory) {
      this.storage.updateTaskWorkingDirectory(taskId, validatedConfig.workingDirectory);
    }

    runTaskSummaryGeneration(taskId, validatedConfig.prompt, this.storage, (summary) => {
      this.emit('summary', { taskId, summary });
    });

    return task;
  }

  async stopTask(params: { taskId: string }): Promise<void> {
    const { taskId } = params;
    const completedAt = new Date().toISOString();
    // Emit `statusChange` with `'cancelled'` in BOTH branches so every
    // terminal listener runs the same cleanup chain that success/error
    // already trigger:
    //   - task-event-forwarding refreshes the health service active-task
    //     count and notifies desktop via `task.statusChange` RPC;
    //   - this class's own listener (registered in the constructor)
    //     deletes the `taskSources` entry and schedules the per-task
    //     `opencode serve` runtime for idle cleanup.
    // Before this change `stopTask` only touched storage, so cancelled
    // tasks leaked their runtime and their source entry until the daemon
    // was restarted.
    if (this.taskManager.isTaskQueued(taskId)) {
      this.taskManager.cancelQueuedTask(taskId);
      this.storage.updateTaskStatus(taskId, 'cancelled', completedAt);
      this.emit('statusChange', { taskId, status: 'cancelled', completedAt });
      return;
    }
    if (this.taskManager.hasActiveTask(taskId)) {
      await this.taskManager.cancelTask(taskId);
      this.storage.updateTaskStatus(taskId, 'cancelled', completedAt);
      this.emit('statusChange', { taskId, status: 'cancelled', completedAt });
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
    /** Same rationale as `startTask.attachments` — follow-up turns also
     * carry user-attached files and must forward them into TaskConfig.files. */
    attachments?: FileAttachmentInfo[];
    /**
     * Caller-supplied workspace for the resumed turn. When the caller
     * omits this but `existingTaskId` is present, we fall back to the
     * workspace the original task was saved under so workspace knowledge
     * notes keep flowing across resume turns.
     */
    workspaceId?: string;
    /**
     * Caller-supplied host cwd for the resumed turn (M4). When provided it
     * wins over — and is persisted as — the task's working directory (the
     * new turn establishes a new cwd). When omitted, the ORIGINAL task's
     * persisted cwd is reused so a lazily-respawned `opencode serve` runs
     * in the original workspace instead of the daemon cwd.
     */
    workingDirectory?: string;
  }): Promise<Task> {
    const { sessionId, prompt, existingTaskId, attachments } = params;
    const taskId = existingTaskId || createTaskId();

    let storedTask: StoredTask | undefined;
    if (existingTaskId) {
      storedTask = this.storage.getTask(existingTaskId);
      const userMessage: TaskMessage = {
        id: createMessageId(),
        type: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      };
      this.storage.addTaskMessage(existingTaskId, userMessage);

      // M4: a resume turn on a task parked for human assistance is a
      // recovery action, not a failure. Flip a waiting_* status to the
      // transient 'resuming' so the UI knows the turn restarted and the
      // boot-time crash sweep (recoverStaleTasks — 'running' only) can
      // never misclassify the task. Non-waiting statuses (e.g. a resumed
      // 'failed' task) are left untouched so the prior outcome stays
      // visible until the new turn resolves it.
      if (
        storedTask?.status === 'waiting_permission' ||
        storedTask?.status === 'waiting_for_user'
      ) {
        this.storage.updateTaskStatus(existingTaskId, 'resuming');
        this.emit('statusChange', { taskId: existingTaskId, status: 'resuming' });
      }
    }

    const activeModel = this.storage.getActiveProviderModel();
    const selectedModel = activeModel || this.storage.getSelectedModel();
    // Workspace resolution order:
    //   1. explicit `params.workspaceId` (caller knows best)
    //   2. the workspace the existing task was saved under (resume case)
    //   3. undefined (fresh session with no workspace context)
    let workspaceId = params.workspaceId;
    if (!workspaceId && existingTaskId) {
      workspaceId = storedTask?.workspaceId;
    }
    // Working-directory resolution order (M4):
    //   1. explicit `params.workingDirectory` (caller wins; persisted as the
    //      task's new cwd — this turn establishes it)
    //   2. the ORIGINAL task's persisted cwd: a resumed turn used to build
    //      its TaskConfig without any cwd, so a lazily-respawned
    //      `opencode serve` inherited the daemon cwd and user-picked folders
    //      were lost on every follow-up
    //   3. undefined → TaskManager default fallback (identical to pre-M4)
    let workingDirectory = params.workingDirectory;
    if (workingDirectory && existingTaskId) {
      this.storage.updateTaskWorkingDirectory(existingTaskId, workingDirectory);
    } else if (!workingDirectory) {
      workingDirectory = storedTask?.workingDirectory;
    }
    const task = await this._runTask(taskId, {
      prompt,
      sessionId,
      taskId,
      modelId: selectedModel?.model,
      provider: selectedModel?.provider,
      files: attachments,
      workspaceId,
      workingDirectory,
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
      {
        presence: this.interactivePresenceProbe,
        getTaskSource: (id) => this.getTaskSource(id),
        // Bind sendResponse for the auto-deny path. Callback-in-object form
        // sidesteps the circular "TaskService constructs callbacks that call
        // back into TaskService" problem — no `this` capture at setup time.
        sendPermissionResponse: async (id, response) => {
          await this.sendResponse(id, response);
        },
      },
    );
    return this.taskManager.startTask(taskId, config, callbacks);
  }

  listTasks(workspaceId?: string, includeUnassigned = false): Task[] {
    return this.storage.getTasks(workspaceId, includeUnassigned) as Task[];
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

  async sendResponse(taskId: string, response: PermissionResponse): Promise<void> {
    await this.taskManager.sendResponse(taskId, response);
    // M4: after a successful human reply the turn continues, so a task that
    // was parked at a waiting_* status goes back to 'running'. A terminal
    // status may have raced in while the reply was in flight — the guard
    // only flips waiting_* statuses, never completion/failure/cancellation.
    // M6-A T2 (D4): a live reply also resolved the persisted pending request,
    // if any — clear it so no later (dead-pending) reply can double-resume.
    this.storage.updateTaskPendingRequest(taskId, null);
    const storedStatus = this.storage.getTask(taskId)?.status;
    if (storedStatus === 'waiting_permission' || storedStatus === 'waiting_for_user') {
      this.storage.updateTaskStatus(taskId, 'running');
      this.emit('statusChange', { taskId, status: 'running' });
    }
  }

  /**
   * Reply-after-restart auto-resume (M6-A T2 / D5).
   *
   * Handles `permission.respond` for a task with NO live adapter (daemon
   * restarted while the human was deciding). Every precondition is checked
   * before anything is mutated; the stored status itself is the single-flight
   * lock (`claimPendingRequestForResume` flips waiting_for_user → resuming
   * atomically, so a duplicate/second reply loudly fails instead of
   * double-resuming):
   *
   *   - only `waiting_for_user` rows (assistance questions) auto-resume —
   *     permission-kind and clarification asks are NEVER replayed (no fake
   *     allow/deny; the stale reply is rejected, D5),
   *   - a stale requestId is rejected, even on a live-looking row,
   *   - a reply with no actual answer is honest D3 decline: the task is
   *     marked `failed` with the explicit reason, never "success",
   *   - a valid answer resumes the SAME persisted sessionId + cwd with a
   *     capped continuation prompt; row cleared at spawn.
   *
   * Errors are thrown with stable messages; the RPC layer surfaces them and
   * T3's restored card maps them onto "expired / already-resuming" copy.
   */
  async respondToPersistedPendingRequest(
    taskId: string,
    response: PermissionResponse,
  ): Promise<void> {
    // Live tasks are owned by the live path — a caller routing here must
    // have checked `hasActiveTask` first (mirrors the pre-T2 route guard).
    if (this.taskManager.hasActiveTask(taskId) || this.taskManager.isTaskQueued(taskId)) {
      throw new Error(
        `permission.respond: no active task with id=${taskId}. The task may have completed, been cancelled, or never existed.`,
      );
    }
    const storedTask = this.storage.getTask(taskId);
    if (!storedTask) {
      // Exact pre-T2 parity message — pinned by daemon parity tests.
      throw new Error(
        `permission.respond: no active task with id=${taskId}. The task may have completed, been cancelled, or never existed.`,
      );
    }
    if (storedTask.status === 'resuming') {
      throw new Error(
        `permission.respond: task ${taskId} already had its pending request resumed — single-flight precondition (a second reply may not restart the resumption).`,
      );
    }
    if (storedTask.status !== 'waiting_for_user') {
      // D5: permission-kind (and clarification) rows are never replayed —
      // surface the expiry and offer the existing manual Resume affordance.
      throw new Error(
        `permission.respond: the pending request for task ${taskId} expired with its previous session (status ${storedTask.status}) and is never replayed. Use the existing Resume affordance to continue the task.`,
      );
    }
    const pending = this.storage.getTaskPendingRequest(taskId);
    if (!pending) {
      throw new Error(
        `permission.respond: task ${taskId} is waiting_for_user but carries no persisted pending request (pre-M6 request) — the card cannot be re-resumed safely.`,
      );
    }
    if (pending.kind !== 'question') {
      // Belt-and-braces: waiting_for_user rows are assistance questions by
      // construction (T1 routing); reject anything else without replaying.
      throw new Error(
        `permission.respond: pending request ${pending.requestId} for task ${taskId} is not a question — expired requests of this kind are never replayed.`,
      );
    }
    if (pending.requestId !== response.requestId) {
      throw new Error(
        `permission.respond: stale requestId ${response.requestId} for task ${taskId} (persisted pending request is ${pending.requestId}) — rejected.`,
      );
    }
    if (!storedTask.sessionId) {
      throw new Error(
        `permission.respond: task ${taskId} has no persisted session to resume — refusing to claim the pending request (it stays parked).`,
      );
    }

    const answer = formatAssistanceAnswer(response);
    if (answer === null) {
      // D3 honesty, restart flavor: a decline (deny/allow with no answer) on
      // an assistance question must NOT resume the turn with an empty reply.
      // Same explicit-failure mapping as the live cancel path.
      const completedAt = new Date().toISOString();
      this.storage.updateTaskPendingRequest(taskId, null);
      this.storage.updateTaskStatus(taskId, 'failed', completedAt);
      this.emit('statusChange', { taskId, status: 'failed', completedAt });
      const declineResult: TaskResult = { status: 'error', error: ASSISTANCE_DECLINE_REASON };
      this.emit('complete', { taskId, result: declineResult });
      log.info(
        `[TaskService] Assistance request ${pending.requestId} declined after restart; task ${taskId} marked failed`,
      );
      return;
    }

    // SEC-1: block secret-shaped answers BEFORE the single-flight claim so a
    // refused reply leaves the persisted record parked (retryable) instead of
    // claimed. Detection re-runs on the STORED ask text — header-independent
    // (the canonical assistance header is not consulted).
    const credentialFlagged = detectCredentialRequest([
      { value: pending.question, kind: 'question' },
      { value: pending.header, kind: 'header' },
      ...(pending.options ?? []).flatMap((o) => [
        { value: o.label, kind: 'option_label' as const },
        { value: o.description, kind: 'option_description' as const },
      ]),
    ]).flagged;
    assertCredentialSafeAnswer(response.customText ?? '', credentialFlagged);

    // Atomic single-flight claim: flips the row to 'resuming' and clears the
    // persisted request in one statement. A losing (concurrent) reply finds
    // zero changes and throws instead of resuming twice.
    const claimed = this.storage.claimPendingRequestForResume(taskId, response.requestId);
    if (!claimed) {
      throw new Error(
        `permission.respond: task ${taskId}'s pending request could not be claimed for resume (already resumed, expired, or a stale requestId) — duplicate or concurrent replies are rejected.`,
      );
    }
    log.info(
      `[TaskService] Claimed persisted assistance request ${claimed.requestId} on task ${taskId} — resuming session ${storedTask.sessionId}`,
    );
    this.emit('statusChange', { taskId, status: 'resuming' });

    const prompt = buildAssistanceContinuationPrompt({
      question: claimed.question,
      answer,
    });
    await this.resumeSession({ sessionId: storedTask.sessionId, prompt, existingTaskId: taskId });
  }

  /**
   * Task origin lookup — used by `task-callbacks.ts` `onPermissionRequest` to
   * decide whether to emit a UI prompt, route through the WhatsApp bridge,
   * or immediately auto-deny when no UI client is connected and the task
   * was not started by WhatsApp or another auto-denying caller.
   */
  getTaskSource(taskId: string): TaskSource {
    return this.taskSources.get(taskId) ?? 'ui';
  }

  dispose(): void {
    this.serverManager.dispose();
    this.taskManager.dispose();
  }
}
