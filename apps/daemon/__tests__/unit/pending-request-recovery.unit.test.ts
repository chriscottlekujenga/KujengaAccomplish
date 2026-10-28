/**
 * M6-A T2 — pending-request persistence + reply-after-restart auto-resume
 * (docs/PHASE_3_M6_PLAN.md §3.1 D4/D5).
 *
 * Simulates the daemon-restart scenario end to end on a REAL SQLite storage
 * (temp dir, migrations to v033) with a FRESH TaskService per test (the
 * "restart": no live adapters exist anymore, only persisted rows):
 *
 * a task parked on an assistance question keeps its persisted pending
 * request, and a later `permission.respond` (no live adapter) goes through
 * the `respondToPersistedPendingRequest` guardrails:
 *
 *   - ONLY `waiting_for_user` assistance-question rows auto-resume (same
 *     sessionId + cwd, capped continuation prompt embedding the FULL answer),
 *   - the stored status is the single-flight lock — duplicate/concurrent
 *     replies fail loudly instead of resuming twice,
 *   - stale requestIds are rejected,
 *   - permission-kind rows are NEVER replayed (no fake allow/deny, D5),
 *   - a reply with no actual answer is an honest D3 decline → `failed`,
 *   - unknown tasks keep the pre-T2 parity message.
 *
 * `createTaskManager` is mocked (parity-suite pattern) so no `opencode serve`
 * runs; storage stays real, matching the crash-recovery suite conventions
 * (better-sqlite3 probe, skip on ABI mismatch).
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  PendingRequestRecord,
  PermissionResponse,
  StorageAPI,
  Task,
  TaskConfig,
} from '@accomplish_ai/agent-core';

type AgentCoreModule = typeof import('@accomplish_ai/agent-core');

/** Runtime values loaded in beforeAll — static runtime imports would run the
 * vi.mock factory at module-eval time, before the mock-state `let` bindings. */
let agentCore: AgentCoreModule;

let capturedTaskConfigs: Array<{ taskId: string; config: TaskConfig }> = [];
let taskManagerMock: {
  hasActiveTask: ReturnType<typeof vi.fn>;
  isTaskQueued: ReturnType<typeof vi.fn>;
  sendResponse: ReturnType<typeof vi.fn>;
  startTask: ReturnType<typeof vi.fn>;
};

vi.mock('@accomplish_ai/agent-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  taskManagerMock = {
    hasActiveTask: vi.fn(() => false),
    isTaskQueued: vi.fn(() => false),
    sendResponse: vi.fn(async () => {}),
    startTask: vi.fn((taskId: string, config: TaskConfig): Promise<Task> => {
      capturedTaskConfigs.push({ taskId, config });
      return Promise.resolve({
        id: taskId,
        prompt: config.prompt,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
      });
    }),
  };
  return {
    ...actual,
    createTaskManager: vi.fn(() => taskManagerMock),
  };
});

interface ServiceLike {
  respondToPersistedPendingRequest(taskId: string, response: PermissionResponse): Promise<void>;
  sendResponse(taskId: string, response: PermissionResponse): Promise<void>;
  hasActiveTask(taskId: string): boolean;
  on(event: string, listener: (data: unknown) => void): unknown;
  dispose(): void;
}

const { TaskService } = (await import('../../src/task-service.js')) as {
  TaskService: new (storage: StorageAPI, options: Record<string, unknown>) => ServiceLike;
};

const FIXED_CREATED_AT = '2026-10-23T00:00:00.000Z';
const TASK_ID = 'tsk_recovery';

function buildAssistancePending(requestId: string): PendingRequestRecord {
  return agentCore.createPendingRequestRecord({
    id: requestId,
    taskId: TASK_ID,
    type: 'question',
    question: 'A CAPTCHA is blocking https://example.com/form',
    header: agentCore.ASSISTANCE_QUESTION_HEADER,
    options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
    multiSelect: false,
    createdAt: FIXED_CREATED_AT,
  });
}

function buildPermissionPending(requestId: string): PendingRequestRecord {
  return { kind: 'permission', requestId, createdAt: FIXED_CREATED_AT };
}

/** SEC-1: an ask whose text matches credential-request language. */
function buildCredentialPending(requestId: string): PendingRequestRecord {
  return agentCore.createPendingRequestRecord({
    id: requestId,
    taskId: TASK_ID,
    type: 'question',
    question: 'I cannot continue without the 6-digit code from your SMS',
    header: 'Verify your identity',
    options: [{ label: 'Send the code' }, { label: 'Skip this verification' }],
    multiSelect: false,
    createdAt: FIXED_CREATED_AT,
  });
}

function makeResponse(overrides: Partial<PermissionResponse> = {}): PermissionResponse {
  return {
    taskId: TASK_ID,
    requestId: 'questionreq_pending_1',
    decision: 'allow',
    selectedOptions: ["I'll complete it — please wait"],
    ...overrides,
  };
}

describe('TaskService.respondToPersistedPendingRequest — reply-after-restart (M6-A T2/D5)', () => {
  let testDir: string;
  let storage: StorageAPI | null = null;
  let service: ServiceLike | null = null;
  let sqliteAvailable = false;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
  let statusChanges: Array<{ taskId: string; status: string }>;

  beforeAll(async () => {
    agentCore = await import('@accomplish_ai/agent-core');
    try {
      const BetterSqlite3 = (await import('better-sqlite3')) as unknown as {
        default: new (p: string) => { close(): void };
      };
      const probe = new BetterSqlite3.default(':memory:');
      probe.close();
      sqliteAvailable = true;
    } catch {
      sqliteAvailable = false;
    }
  });

  beforeEach(async () => {
    if (!sqliteAvailable) {
      return;
    }
    consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    capturedTaskConfigs = [];
    testDir = path.join(
      os.tmpdir(),
      `pending-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    storage = agentCore.createStorage({
      databasePath: path.join(testDir, 'test.db'),
      runMigrations: true,
      userDataPath: path.join(testDir, 'secure'),
    });
    storage.initialize();

    statusChanges = [];
    service = new TaskService(storage, { userDataPath: testDir, mcpToolsPath: testDir });
    service.on('statusChange', (data: unknown) =>
      statusChanges.push(data as { taskId: string; status: string }),
    );
  });

  afterEach(() => {
    for (const spy of consoleSpies) {
      spy.mockRestore();
    }
    storage?.close();
    storage = null;
    service = null;
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function park(
    status: 'waiting_for_user' | 'waiting_permission' | 'failed' | 'completed' | 'running',
    options: { requestId?: string; permissionKind?: boolean; sessionId?: string | null } = {},
  ): void {
    if (!storage) {
      return;
    }
    const sessionId = options.sessionId === null ? undefined : (options.sessionId ?? 'sess_orig_1');
    storage.saveTask({
      id: TASK_ID,
      prompt: 'original task',
      status,
      createdAt: FIXED_CREATED_AT,
      messages: [],
      ...(sessionId ? { sessionId } : {}),
      workingDirectory: '/home/chris/project',
    } as never);
    if (options.requestId) {
      const record = options.permissionKind
        ? buildPermissionPending(options.requestId)
        : buildAssistancePending(options.requestId);
      storage.updateTaskPendingRequest(TASK_ID, record);
    }
  }

  it('persists on park → RESTART → reply → auto-resumes the SAME session with the full answer', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    // The park-time write is on disk: a fresh read restores the record.
    expect(storage.getTask(TASK_ID)?.pendingRequest?.requestId).toBe('questionreq_pending_1');
    expect(storage.getTask(TASK_ID)?.pendingRequest?.kind).toBe('question');

    await service.respondToPersistedPendingRequest(TASK_ID, makeResponse());

    // Row cleared AT SPAWN (D4 lifecycle) and the turn resumed with the
    // SAME persisted sessionId + cwd.
    expect(storage.getTaskPendingRequest(TASK_ID)).toBeNull();
    expect(capturedTaskConfigs).toHaveLength(1);
    const { taskId, config } = capturedTaskConfigs[0];
    expect(taskId).toBe(TASK_ID);
    expect(config.sessionId).toBe('sess_orig_1');
    expect(config.workingDirectory).toBe('/home/chris/project');
    expect(config.prompt).toContain('The human replied to your assistance request.');
    expect(config.prompt).toContain(
      'You had asked: A CAPTCHA is blocking https://example.com/form',
    );
    expect(config.prompt).toContain(
      "The human replied: Chosen option(s):\n- I'll complete it — please wait",
    );
    // The continuation prompt became the persisted user message.
    const messages = storage.getTask(TASK_ID)?.messages ?? [];
    expect(
      messages.some(
        (m) => m.type === 'user' && m.content.includes("I'll complete it — please wait"),
      ),
    ).toBe(true);
    // The claim flipped the status to resuming (single-flight lock) and the
    // post-turn completion persisted the new running status.
    expect(statusChanges).toEqual([{ taskId: TASK_ID, status: 'resuming' }]);
    expect(storage.getTask(TASK_ID)?.status).toBe('running');
  });

  it('double reply after the resumed turn ends fails loudly WITHOUT a second resumption', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    await service.respondToPersistedPendingRequest(TASK_ID, makeResponse());
    expect(capturedTaskConfigs).toHaveLength(1);

    // The first resume made the task 'running' — the second reply lands in
    // the expired family and NEVER re-resumes the same request.
    await expect(service.respondToPersistedPendingRequest(TASK_ID, makeResponse())).rejects.toThrow(
      /never replayed|expired/,
    );
    expect(capturedTaskConfigs).toHaveLength(1);
  });

  it('CONCURRENT replies: exactly one resumption; the losing reply fails loudly', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });

    const results = await Promise.allSettled([
      service.respondToPersistedPendingRequest(TASK_ID, makeResponse()),
      service.respondToPersistedPendingRequest(TASK_ID, makeResponse()),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) =>
        r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.message).length > 0,
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A single resumption, and the winning continuation exists exactly once.
    expect(capturedTaskConfigs).toHaveLength(1);
    expect(
      storage.getTask(TASK_ID)?.status === 'running' ||
        storage.getTask(TASK_ID)?.status === 'resuming',
    ).toBe(true);
  });

  it('stale requestId is rejected and the row stays parked byte-identically', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    const before = storage.getTask(TASK_ID);

    await expect(
      service.respondToPersistedPendingRequest(
        TASK_ID,
        makeResponse({ requestId: 'questionreq_STALE' }),
      ),
    ).rejects.toThrow(/stale requestId/);

    expect(storage.getTask(TASK_ID)?.status).toBe('waiting_for_user');
    expect(JSON.stringify(storage.getTask(TASK_ID))).toBe(JSON.stringify(before));
    expect(capturedTaskConfigs).toHaveLength(0);
  });

  it('permission-kind row (waiting_permission) is NEVER replayed — no fake allow or deny (D5)', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_permission', {
      requestId: 'filereq_dead',
      permissionKind: true,
    });

    await expect(
      service.respondToPersistedPendingRequest(
        TASK_ID,
        makeResponse({ requestId: 'filereq_dead', decision: 'allow' }),
      ),
    ).rejects.toThrow(/expired with its previous session.*never replayed/s);
    await expect(
      service.respondToPersistedPendingRequest(
        TASK_ID,
        makeResponse({ requestId: 'filereq_dead', decision: 'deny' }),
      ),
    ).rejects.toThrow(/never replayed/);

    // Untouched: still waiting_permission with its persisted record — the
    // restored card explains the expiry and offers the manual Resume.
    expect(storage.getTask(TASK_ID)?.status).toBe('waiting_permission');
    expect(storage.getTaskPendingRequest(TASK_ID)?.requestId).toBe('filereq_dead');
    expect(capturedTaskConfigs).toHaveLength(0);
  });

  it('terminal-state races: failed/completed/cancelled/interrupted/running rows reject dead replies', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('failed', { requestId: 'questionreq_dead' });
    for (const terminal of [
      'completed',
      'cancelled',
      'interrupted',
      'failed',
      'running',
    ] as const) {
      storage.updateTaskStatus(TASK_ID, terminal);
      await expect(
        service.respondToPersistedPendingRequest(TASK_ID, makeResponse()),
      ).rejects.toThrow(/expired/);
      expect(storage.getTask(TASK_ID)?.status).toBe(terminal);
    }
    expect(capturedTaskConfigs).toHaveLength(0);
  });

  it('resuming-status row (reply racing an in-flight resumption) hits the single-flight guard', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    // Freeze a resumption mid-flight: the FIRST reply claims the row and the
    // manager keeps the turn in-flight until we resolve the deferred start.
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    let resolveStart!: (task: Task) => void;
    const inFlightTurn = new Promise<Task>((resolve) => {
      resolveStart = resolve;
    });
    taskManagerMock.startTask.mockImplementationOnce((taskId: string, config: TaskConfig) => {
      capturedTaskConfigs.push({ taskId, config });
      return inFlightTurn;
    });

    const first = service.respondToPersistedPendingRequest(TASK_ID, makeResponse());
    await vi.waitFor(() => expect(storage.getTask(TASK_ID)?.status).toBe('resuming'));

    // A SECOND reply while the first resumption is in flight → single-flight.
    await expect(service.respondToPersistedPendingRequest(TASK_ID, makeResponse())).rejects.toThrow(
      /single-flight/,
    );

    resolveStart({
      id: TASK_ID,
      prompt: 'continue',
      status: 'running',
      messages: [],
      createdAt: new Date().toISOString(),
    });
    await first;
    expect(storage.getTask(TASK_ID)?.status).toBe('running');
    expect(capturedTaskConfigs).toHaveLength(1);
  });

  it('a reply with NO answer is an honest D3 decline → failed with the explicit reason (never resumed)', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    const completions: Array<{ taskId: string; result: { status: string; error?: string } }> = [];
    service.on('complete', (data: unknown) =>
      completions.push(data as { taskId: string; result: { status: string; error?: string } }),
    );

    await service.respondToPersistedPendingRequest(
      TASK_ID,
      makeResponse({ decision: 'deny', selectedOptions: undefined, customText: undefined }),
    );

    // No continuation turn was spawned.
    expect(capturedTaskConfigs).toHaveLength(0);
    // Honest terminal state + row cleanup + final statusChange.
    expect(storage.getTask(TASK_ID)?.status).toBe('failed');
    expect(storage.getTask(TASK_ID)?.completedAt).toBeTruthy();
    expect(storage.getTaskPendingRequest(TASK_ID)).toBeNull();
    expect(completions).toHaveLength(1);
    expect(completions[0].result.status).toBe('error');
    expect(completions[0].result.error).toBe(agentCore.ASSISTANCE_DECLINE_REASON);
    expect(statusChanges[statusChanges.length - 1]).toMatchObject({ status: 'failed' });
  });

  it('unknown task keeps the pre-T2 parity message', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    await expect(
      service.respondToPersistedPendingRequest(
        'tsk_never_existed',
        makeResponse({ taskId: 'tsk_never_existed' }),
      ),
    ).rejects.toThrow(
      'permission.respond: no active task with id=tsk_never_existed. The task may have completed, been cancelled, or never existed.',
    );
  });

  it('waiting_for_user row with NO persisted record (pre-T2 row) rejects safely', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: undefined });

    await expect(service.respondToPersistedPendingRequest(TASK_ID, makeResponse())).rejects.toThrow(
      /carries no persisted pending request/,
    );
    expect(storage.getTask(TASK_ID)?.status).toBe('waiting_for_user');
    expect(capturedTaskConfigs).toHaveLength(0);
  });

  it('a parked task with no persisted sessionId refuses to claim (row stays parked)', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { sessionId: null, requestId: 'questionreq_nosess' });

    await expect(
      service.respondToPersistedPendingRequest(
        TASK_ID,
        makeResponse({ requestId: 'questionreq_nosess' }),
      ),
    ).rejects.toThrow(/no persisted session to resume/);
    expect(storage.getTask(TASK_ID)?.status).toBe('waiting_for_user');
    expect(storage.getTaskPendingRequest(TASK_ID)?.requestId).toBe('questionreq_nosess');
    expect(capturedTaskConfigs).toHaveLength(0);
  });

  it('SEC-1: a password-shaped answer is BLOCKED before the claim — the record stays parked', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    const before = storage.getTask(TASK_ID);

    await expect(
      service.respondToPersistedPendingRequest(
        TASK_ID,
        makeResponse({ selectedOptions: undefined, customText: 'password: hunter2secret' }),
      ),
    ).rejects.toThrowError(agentCore.CREDENTIAL_BLOCK_USER_MESSAGE);

    // Untouched: status, persisted record, and NO resumption turn. The user
    // can retry with a safe answer or cancel (D3 decline).
    expect(storage.getTask(TASK_ID)?.status).toBe('waiting_for_user');
    expect(JSON.stringify(storage.getTask(TASK_ID))).toBe(JSON.stringify(before));
    expect(storage.getTaskPendingRequest(TASK_ID)?.requestId).toBe('questionreq_pending_1');
    expect(capturedTaskConfigs).toHaveLength(0);
  });

  it('SEC-1: a bare MFA code reply to a credential-flagged ask is blocked; a manual-auth confirmation resumes', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    storage.saveTask({
      id: TASK_ID,
      prompt: 'original task',
      status: 'waiting_for_user',
      createdAt: FIXED_CREATED_AT,
      messages: [],
      sessionId: 'sess_orig_1',
      workingDirectory: '/home/chris/project',
    } as never);
    storage.updateTaskPendingRequest(TASK_ID, buildCredentialPending('questionreq_sec1'));

    // The ask itself was credential-flagged (header-independent detection) —
    // a bare digit code is blocked on the flagged surface.
    await expect(
      service.respondToPersistedPendingRequest(
        TASK_ID,
        makeResponse({
          requestId: 'questionreq_sec1',
          selectedOptions: undefined,
          customText: '482913',
        }),
      ),
    ).rejects.toThrowError(agentCore.CREDENTIAL_BLOCK_USER_MESSAGE);
    expect(storage.getTask(TASK_ID)?.status).toBe('waiting_for_user');
    expect(storage.getTaskPendingRequest(TASK_ID)?.requestId).toBe('questionreq_sec1');
    expect(capturedTaskConfigs).toHaveLength(0);

    // A manual-browser-auth confirmation is a SAFE answer: it resumes the
    // SAME session with the answer embedded (redacted-but-intact).
    await service.respondToPersistedPendingRequest(
      TASK_ID,
      makeResponse({
        requestId: 'questionreq_sec1',
        selectedOptions: ["I'll complete it — please wait"],
        customText: 'I logged in myself in the preview browser',
      }),
    );
    expect(capturedTaskConfigs).toHaveLength(1);
    expect(capturedTaskConfigs[0].config.sessionId).toBe('sess_orig_1');
    expect(capturedTaskConfigs[0].config.prompt).toContain(
      'I logged in myself in the preview browser',
    );
  });

  it('multi-question replies are lossless: BOTH selected options AND the free-text note reach the prompt', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });

    await service.respondToPersistedPendingRequest(
      TASK_ID,
      makeResponse({
        selectedOptions: ["I'll complete it — please wait", 'Prefer option two as fallback'],
        customText: 'I already reset the site cookies',
      }),
    );

    const prompt = capturedTaskConfigs[0].config.prompt;
    expect(prompt).toContain(
      "Chosen option(s):\n- I'll complete it — please wait\n- Prefer option two as fallback",
    );
    expect(prompt).toContain('Human note: I already reset the site cookies');
  });

  it('route-wiring contract: live task → sendResponse; dead task → recovery (mirrors daemon-routes)', async () => {
    if (!storage || !service) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    // LIVE branch: hasActiveTask true → plain sendResponse.
    taskManagerMock.hasActiveTask.mockReturnValue(true);
    const liveResponse = makeResponse();
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    await service.sendResponse(TASK_ID, liveResponse);
    expect(taskManagerMock.sendResponse).toHaveBeenCalledWith(TASK_ID, liveResponse);
    // The live reply also cleared the persisted record + restored running.
    expect(storage.getTaskPendingRequest(TASK_ID)).toBeNull();
    expect(storage.getTask(TASK_ID)?.status).toBe('running');
    expect(statusChanges).toEqual([{ taskId: TASK_ID, status: 'running' }]);

    // DEAD branch: hasActiveTask false → the recovery guardrails.
    taskManagerMock.hasActiveTask.mockReturnValue(false);
    park('waiting_for_user', { requestId: 'questionreq_pending_1' });
    await service.respondToPersistedPendingRequest(TASK_ID, makeResponse());
    expect(capturedTaskConfigs).toHaveLength(1);
  });
});
