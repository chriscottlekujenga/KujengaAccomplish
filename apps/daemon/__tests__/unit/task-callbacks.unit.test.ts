import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type {
  PermissionRequest,
  StorageAPI,
  TaskManagerAPI,
  TaskSource,
} from '@accomplish_ai/agent-core';
import { ASSISTANCE_QUESTION_HEADER } from '@accomplish_ai/agent-core';
import { createTaskCallbacks } from '../../src/task-callbacks.js';

/**
 * REGRESSIONS for the permission-dispatch guards added to `task-callbacks.ts`
 * in Phase 2 of the SDK cutover port, plus the follow-up no-bridge guard
 * landed in commit 70de1844 (Max review #4 / plan decision #10).
 *
 * The `onPermissionRequest` callback must route in four distinct ways:
 *   1. `source === 'whatsapp'` AND bridge attached (listenerCount > 1)
 *      → emit 'permission' so `wireTaskBridge` can auto-deny.
 *   2. `source === 'whatsapp'` AND bridge NOT attached (listenerCount ≤ 1)
 *      → auto-deny immediately (prevents task hang when WhatsApp is
 *      configured by source but the runtime bridge is not attached).
 *   3. `!'whatsapp'` AND no interactive UI attached → auto-deny.
 *      (Phase 3 M1: the probe is now `hasInteractiveClients` — legacy
 *      socket clients OR fresh gateway-reported browser counts — never the
 *      gateway's own persistent socket.)
 *   4. `!'whatsapp'` AND interactive UI attached → emit.
 */

function buildFixture(options: {
  source: TaskSource;
  hasInteractiveClients: boolean;
  liveSessionId?: string | null;
}) {
  const emitter = new EventEmitter();
  // Mirror the daemon's real wiring: task-event-forwarding attaches ONE
  // listener on 'permission' to forward to RPC. That baseline listener is
  // what makes `listenerCount <= 1` the right "no bridge" threshold.
  const rpcForwardListener = vi.fn();
  emitter.on('permission', rpcForwardListener);
  const statusChangeSpy = vi.fn();
  emitter.on('statusChange', statusChangeSpy);

  const sendPermissionResponse = vi.fn(async () => {});

  const storage = {
    addTaskMessage: vi.fn(),
    updateTaskStatus: vi.fn(),
    updateTaskSummary: vi.fn(),
    updateTaskSessionId: vi.fn(),
    updateTaskPendingRequest: vi.fn(),
    clearTodosForTask: vi.fn(),
    saveTodosForTask: vi.fn(),
    getTasks: vi.fn(() => []),
    getTask: vi.fn(() => null),
  } as unknown as StorageAPI;

  const taskManager = {
    getSessionId: vi.fn(() => options.liveSessionId ?? null),
  } as unknown as TaskManagerAPI;

  const callbacks = createTaskCallbacks('tsk_abc', emitter, storage, taskManager, {
    // Phase 3 M1: the probe is now interactive presence (legacy clients OR
    // gateway-reported browser counts), not raw socket connectivity.
    presence: { hasInteractiveClients: () => options.hasInteractiveClients },
    getTaskSource: () => options.source,
    sendPermissionResponse,
  });

  return {
    callbacks,
    emitter,
    rpcForwardListener,
    sendPermissionResponse,
    storage,
    statusChangeSpy,
  };
}

const fakeRequest: PermissionRequest = {
  id: 'filereq_xyz',
  taskId: 'tsk_abc',
  type: 'file',
  fileOperation: 'create',
  filePath: '/tmp/any.txt',
  timestamp: new Date().toISOString(),
};

describe('createTaskCallbacks — onPermissionRequest dispatch', () => {
  it("source='ui', UI connected → emits 'permission' (does NOT auto-deny)", () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: true });
    // Attach a listener so listenerCount > 1 would also pass a whatsapp
    // check (shouldn't matter here; asserting the UI path is emit-only).
    const bridgeListener = vi.fn();
    f.emitter.on('permission', bridgeListener);

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.rpcForwardListener).toHaveBeenCalledWith(fakeRequest);
    expect(bridgeListener).toHaveBeenCalledWith(fakeRequest);
    expect(f.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it("source='ui', no UI connected → auto-denies (does NOT emit bridge-side)", () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.sendPermissionResponse).toHaveBeenCalledWith('tsk_abc', {
      taskId: 'tsk_abc',
      requestId: 'filereq_xyz',
      decision: 'deny',
    });
    // Baseline RPC forwarder is still attached but since the handler chose
    // the auto-deny branch, it should NOT have been invoked with this
    // request.
    expect(f.rpcForwardListener).not.toHaveBeenCalled();
  });

  it("source='whatsapp', bridge attached (listenerCount > 1) → emits 'permission'", () => {
    const f = buildFixture({ source: 'whatsapp', hasInteractiveClients: false });
    const bridgeListener = vi.fn();
    f.emitter.on('permission', bridgeListener);

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(bridgeListener).toHaveBeenCalledWith(fakeRequest);
    // Auto-deny path must NOT run — the bridge will deny via
    // taskService.sendResponse from wireTaskBridge.
    expect(f.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it("source='whatsapp', bridge NOT attached → auto-denies here (plan decision #10)", () => {
    // Only the baseline RPC forwarder is attached. listenerCount === 1.
    const f = buildFixture({ source: 'whatsapp', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.sendPermissionResponse).toHaveBeenCalledWith('tsk_abc', {
      taskId: 'tsk_abc',
      requestId: 'filereq_xyz',
      decision: 'deny',
    });
  });

  it("source='scheduler', no UI connected → auto-denies", () => {
    const f = buildFixture({ source: 'scheduler', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.sendPermissionResponse).toHaveBeenCalledWith('tsk_abc', {
      taskId: 'tsk_abc',
      requestId: 'filereq_xyz',
      decision: 'deny',
    });
  });

  it("source='scheduler', UI connected → emits 'permission' (user can still approve)", () => {
    const f = buildFixture({ source: 'scheduler', hasInteractiveClients: true });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.rpcForwardListener).toHaveBeenCalledWith(fakeRequest);
    expect(f.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it('auto-deny within a few milliseconds (<=100ms budget for scheduled tasks)', async () => {
    // Plan: "Phase 5 regression test — scheduled task with no UI auto-denies
    // within 100 ms". Measuring wall-clock on the callback itself is a
    // proxy for that requirement — the real 100ms budget is the end-to-end
    // path (startTask → onPermissionRequest → sendResponse) but the
    // callback's dispatch is the only piece we can unit-test without a
    // full daemon stack.
    const f = buildFixture({ source: 'scheduler', hasInteractiveClients: false });

    const started = Date.now();
    f.callbacks.onPermissionRequest?.(fakeRequest);
    const elapsed = Date.now() - started;

    expect(f.sendPermissionResponse).toHaveBeenCalled();
    expect(elapsed).toBeLessThan(50);
  });
});

/**
 * Phase 3 M4 (docs/PHASE_3_M4_PLAN.md §B1): a permission request emitted to
 * a human-facing surface (WhatsApp bridge OR interactive UI) parks the task
 * in `waiting_permission` — persisted via storage AND announced through
 * `statusChange` so the WS `task.statusChange` notification reaches the UI.
 * Auto-deny branches must NEVER touch the status: the deny is immediate, no
 * human waits, and the task stays `running`.
 */
describe('createTaskCallbacks — waiting_permission parking (M4)', () => {
  it("source='ui', UI connected → persists waiting_permission + emits statusChange", () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: true });
    const bridgeListener = vi.fn();
    f.emitter.on('permission', bridgeListener);

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(bridgeListener).toHaveBeenCalledWith(fakeRequest);
    expect(f.storage.updateTaskStatus).toHaveBeenCalledWith('tsk_abc', 'waiting_permission');
    expect(f.statusChangeSpy).toHaveBeenCalledWith({
      taskId: 'tsk_abc',
      status: 'waiting_permission',
    });
  });

  it("source='whatsapp', bridge attached → parks in waiting_permission too (bridge reply restores running)", () => {
    const f = buildFixture({ source: 'whatsapp', hasInteractiveClients: false });
    const bridgeListener = vi.fn();
    f.emitter.on('permission', bridgeListener);

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(bridgeListener).toHaveBeenCalledWith(fakeRequest);
    expect(f.storage.updateTaskStatus).toHaveBeenCalledWith('tsk_abc', 'waiting_permission');
    expect(f.statusChangeSpy).toHaveBeenCalledWith({
      taskId: 'tsk_abc',
      status: 'waiting_permission',
    });
  });

  it("source='whatsapp', bridge NOT attached → auto-deny does NOT touch the status", () => {
    const f = buildFixture({ source: 'whatsapp', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.sendPermissionResponse).toHaveBeenCalled();
    expect(f.storage.updateTaskStatus).not.toHaveBeenCalled();
    expect(f.statusChangeSpy).not.toHaveBeenCalled();
  });

  it("source='ui', no UI connected → auto-deny does NOT touch the status", () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.sendPermissionResponse).toHaveBeenCalled();
    expect(f.storage.updateTaskStatus).not.toHaveBeenCalled();
    expect(f.statusChangeSpy).not.toHaveBeenCalled();
  });

  it("source='scheduler', UI connected → emits AND parks in waiting_permission", () => {
    const f = buildFixture({ source: 'scheduler', hasInteractiveClients: true });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.rpcForwardListener).toHaveBeenCalledWith(fakeRequest);
    expect(f.storage.updateTaskStatus).toHaveBeenCalledWith('tsk_abc', 'waiting_permission');
    expect(f.statusChangeSpy).toHaveBeenCalledWith({
      taskId: 'tsk_abc',
      status: 'waiting_permission',
    });
  });

  it("source='scheduler', no UI → auto-deny does NOT touch the status", () => {
    const f = buildFixture({ source: 'scheduler', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(fakeRequest);

    expect(f.sendPermissionResponse).toHaveBeenCalled();
    expect(f.storage.updateTaskStatus).not.toHaveBeenCalled();
    expect(f.statusChangeSpy).not.toHaveBeenCalled();
  });
});

/**
 * M6-A D2 (Phase 3): a question whose header string-equals the shared
 * ASSISTANCE_QUESTION_HEADER is a human-verification assistance ask → the
 * reserved `waiting_for_user` status. Clarifying questions keep the M4
 * `waiting_permission` semantics byte-identically. Auto-deny branches never
 * touch the status for EITHER kind — under the no-UI the request is denied
 * immediately and, for assistance-kind, the ADAPTER's honest-decline mapping
 * (M6-A D3) records the task as failed with the explicit reason (out of this
 * file's scope).
 *
 * Injection-safety framing: header equality drives ONLY this status label —
 * no authorization decision, nothing is granted.
 */
describe('createTaskCallbacks — M6-A assistance-question routing (waiting_for_user)', () => {
  function buildQuestionRequest(header: string): PermissionRequest {
    return {
      id: 'questionreq_xyz',
      taskId: 'tsk_abc',
      type: 'question',
      question: 'A CAPTCHA is blocking https://example.com/form',
      header,
      createdAt: new Date().toISOString(),
    };
  }

  const clarificationQuestion = buildQuestionRequest('A quick question');
  const assistanceQuestion = buildQuestionRequest(ASSISTANCE_QUESTION_HEADER);

  it("assistance-header question + interactive UI → parks in 'waiting_for_user' AND emits the request", () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: true });
    const bridgeListener = vi.fn();
    f.emitter.on('permission', bridgeListener);

    f.callbacks.onPermissionRequest?.(assistanceQuestion);

    expect(f.rpcForwardListener).toHaveBeenCalledWith(assistanceQuestion);
    expect(bridgeListener).toHaveBeenCalledWith(assistanceQuestion);
    expect(f.storage.updateTaskStatus).toHaveBeenCalledWith('tsk_abc', 'waiting_for_user');
    expect(f.statusChangeSpy).toHaveBeenCalledWith({
      taskId: 'tsk_abc',
      status: 'waiting_for_user',
    });
    expect(f.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it('clarification question → parks in waiting_permission exactly as before (unchanged)', () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: true });

    f.callbacks.onPermissionRequest?.(clarificationQuestion);

    expect(f.rpcForwardListener).toHaveBeenCalledWith(clarificationQuestion);
    expect(f.storage.updateTaskStatus).toHaveBeenCalledWith('tsk_abc', 'waiting_permission');
    expect(f.statusChangeSpy).toHaveBeenCalledWith({
      taskId: 'tsk_abc',
      status: 'waiting_permission',
    });
  });

  it('whatsapp + bridge attached: assistance question parks in waiting_for_user too', () => {
    const f = buildFixture({ source: 'whatsapp', hasInteractiveClients: false });
    const bridgeListener = vi.fn();
    f.emitter.on('permission', bridgeListener);

    f.callbacks.onPermissionRequest?.(assistanceQuestion);

    expect(bridgeListener).toHaveBeenCalledWith(assistanceQuestion);
    expect(f.storage.updateTaskStatus).toHaveBeenCalledWith('tsk_abc', 'waiting_for_user');
    expect(f.statusChangeSpy).toHaveBeenCalledWith({
      taskId: 'tsk_abc',
      status: 'waiting_for_user',
    });
  });

  it('auto-deny unchanged for assistance questions: deny sent, NO waiting status', () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(assistanceQuestion);

    expect(f.sendPermissionResponse).toHaveBeenCalledWith('tsk_abc', {
      taskId: 'tsk_abc',
      requestId: 'questionreq_xyz',
      decision: 'deny',
    });
    expect(f.storage.updateTaskStatus).not.toHaveBeenCalled();
    expect(f.statusChangeSpy).not.toHaveBeenCalled();
    expect(f.rpcForwardListener).not.toHaveBeenCalled();
  });

  it('auto-deny unchanged for clarification questions: deny sent, NO waiting status', () => {
    const f = buildFixture({ source: 'ui', hasInteractiveClients: false });

    f.callbacks.onPermissionRequest?.(clarificationQuestion);

    expect(f.sendPermissionResponse).toHaveBeenCalledWith('tsk_abc', {
      taskId: 'tsk_abc',
      requestId: 'questionreq_xyz',
      decision: 'deny',
    });
    expect(f.storage.updateTaskStatus).not.toHaveBeenCalled();
    expect(f.statusChangeSpy).not.toHaveBeenCalled();
  });

  /**
   * M6-A T2 (D4): whenever a task actually parks on a human, the pending
   * request is ALSO persisted (`tasks.pending_request`, migration v033) so a
   * daemon restart can restore the card and auto-resume assistance questions.
   * Auto-deny branches resolve immediately — they persist NOTHING.
   */
  describe('createTaskCallbacks — pending-request persistence on park (M6-A T2)', () => {
    function buildQuestionRequest(header: string): PermissionRequest {
      return {
        id: 'questionreq_persist',
        taskId: 'tsk_abc',
        type: 'question',
        question: 'A CAPTCHA is blocking https://example.com/form',
        header,
        options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
        multiSelect: false,
        createdAt: '2026-10-23T00:00:00.000Z',
      };
    }

    const assistanceQuestion = buildQuestionRequest(ASSISTANCE_QUESTION_HEADER);
    const clarificationQuestion = buildQuestionRequest('A quick question');
    const fileRequest: PermissionRequest = {
      id: 'filereq_persist',
      taskId: 'tsk_abc',
      type: 'file',
      fileOperation: 'create',
      filePath: '/tmp/any.txt',
      createdAt: '2026-10-23T00:00:00.000Z',
    };

    it('assistance question parked in waiting_for_user → persisted as question-kind record', () => {
      const f = buildFixture({ source: 'ui', hasInteractiveClients: true });

      f.callbacks.onPermissionRequest?.(assistanceQuestion);

      expect(f.storage.updateTaskPendingRequest).toHaveBeenCalledTimes(1);
      const [taskId, record] = (f.storage.updateTaskPendingRequest as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(taskId).toBe('tsk_abc');
      expect(record).toMatchObject({
        kind: 'question',
        requestId: 'questionreq_persist',
        header: ASSISTANCE_QUESTION_HEADER,
        question: 'A CAPTCHA is blocking https://example.com/form',
        createdAt: '2026-10-23T00:00:00.000Z',
      });
    });

    it('clarification question parked in waiting_permission → persisted too (card restore, never auto-resumed)', () => {
      const f = buildFixture({ source: 'ui', hasInteractiveClients: true });

      f.callbacks.onPermissionRequest?.(clarificationQuestion);

      const record = (f.storage.updateTaskPendingRequest as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      expect(record).toMatchObject({ kind: 'question', requestId: 'questionreq_persist' });
    });

    it('tool/file permission parked in waiting_permission → persisted as permission-kind record', () => {
      const f = buildFixture({ source: 'ui', hasInteractiveClients: true });

      f.callbacks.onPermissionRequest?.(fileRequest);

      const record = (f.storage.updateTaskPendingRequest as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      expect(record).toMatchObject({ kind: 'permission', requestId: 'filereq_persist' });
    });

    it('auto-deny branches NEVER persist a pending request (assistance or permission)', () => {
      const f = buildFixture({ source: 'ui', hasInteractiveClients: false });
      f.callbacks.onPermissionRequest?.(assistanceQuestion);
      expect(f.storage.updateTaskPendingRequest).not.toHaveBeenCalled();

      const f2 = buildFixture({ source: 'whatsapp', hasInteractiveClients: false });
      f2.callbacks.onPermissionRequest?.(fileRequest);
      expect(f2.storage.updateTaskPendingRequest).not.toHaveBeenCalled();

      const f3 = buildFixture({ source: 'scheduler', hasInteractiveClients: false });
      f3.callbacks.onPermissionRequest?.(assistanceQuestion);
      expect(f3.storage.updateTaskPendingRequest).not.toHaveBeenCalled();
    });
  });

  /**
   * M6-A T6 (D5 enablement): the parked row must carry the LIVE adapter
   * session id — a reply after a daemon restart claims the row and resumes
   * the ORIGINAL persisted session. Until T6 the session id reached the DB
   * only at onComplete, so a real restart while parked left the row without
   * a resumable session (live gap surfaced by the 36-assistance-restart E2E).
   */
  describe('createTaskCallbacks — live session persisted on park (M6-A T6)', () => {
    const assistanceQuestion: PermissionRequest = {
      id: 'questionreq_park_session',
      taskId: 'tsk_abc',
      type: 'question',
      question: 'A CAPTCHA is blocking https://example.com/form',
      header: ASSISTANCE_QUESTION_HEADER,
      createdAt: '2026-10-24T00:00:00.000Z',
    };
    const fileRequest: PermissionRequest = {
      id: 'filereq_park_session',
      taskId: 'tsk_abc',
      type: 'file',
      fileOperation: 'create',
      filePath: '/tmp/any.txt',
      createdAt: '2026-10-24T00:00:00.000Z',
    };

    it('assistance park persists the live adapter session id (restart-resumable row)', () => {
      const f = buildFixture({
        source: 'ui',
        hasInteractiveClients: true,
        liveSessionId: 'sess_live_123',
      });

      f.callbacks.onPermissionRequest?.(assistanceQuestion);

      expect(f.storage.updateTaskSessionId).toHaveBeenCalledTimes(1);
      expect(f.storage.updateTaskSessionId).toHaveBeenCalledWith('tsk_abc', 'sess_live_123');
    });

    it('waiting_permission park persists the live session id too (M4 waiting rows)', () => {
      const f = buildFixture({
        source: 'ui',
        hasInteractiveClients: true,
        liveSessionId: 'sess_live_123',
      });

      f.callbacks.onPermissionRequest?.(fileRequest);

      expect(f.storage.updateTaskSessionId).toHaveBeenCalledWith('tsk_abc', 'sess_live_123');
      expect(f.storage.updateTaskStatus).toHaveBeenCalledWith('tsk_abc', 'waiting_permission');
    });

    it('no live session yet → no session write (pre-session park stays null-safe)', () => {
      const f = buildFixture({ source: 'ui', hasInteractiveClients: true });

      f.callbacks.onPermissionRequest?.(fileRequest);

      expect(f.storage.updateTaskSessionId).not.toHaveBeenCalled();
    });

    it('auto-deny never touches the session id (no human waits, task stays running)', () => {
      const f = buildFixture({
        source: 'ui',
        hasInteractiveClients: false,
        liveSessionId: 'sess_live_123',
      });

      f.callbacks.onPermissionRequest?.(assistanceQuestion);

      expect(f.storage.updateTaskSessionId).not.toHaveBeenCalled();
    });
  });
});
