/**
 * Unit tests for the pending-request restore + response-error handling
 * (M6-A T3). Pins the restart/reconnect restoration matrix and the D5
 * replay-discipline error states, following the store-slice + transport-
 * mock pattern of the other store unit suites.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('undici', () => ({
  ProxyAgent: class ProxyAgent {},
  Agent: class Agent {},
  fetch: vi.fn(),
  setGlobalDispatcher: vi.fn(),
  getGlobalDispatcher: vi.fn(),
}));

import type { Task, PermissionRequest, TaskStatus } from '@accomplish_ai/agent-core/common';
import { ASSISTANCE_QUESTION_HEADER } from '@accomplish_ai/agent-core/common';
import { createTaskPermissionActions } from '@/stores/task-permission-actions';
import { createTaskUpdateActions } from '@/stores/task-update-actions';
import type { TaskState } from '@/stores/taskStore';

vi.mock('@/lib/accomplish', () => ({
  getAccomplish: () => accomplishMock,
}));

const accomplishMock = {
  logEvent: vi.fn().mockResolvedValue(undefined),
  respondToPermission: vi.fn().mockResolvedValue(undefined),
};

type MinimalState = Partial<TaskState> & { _taskStateToken: number };

function buildHarness(initial: MinimalState = {}) {
  let state: Partial<TaskState> & { _taskStateToken: number } = {
    _taskStateToken: 1,
    permissionRequests: {},
    restoredRequestIds: {},
    permissionRequestErrors: {},
    tasks: [],
    currentTask: null,
    isLoading: false,
    ...initial,
  };
  const set = (partial: Partial<TaskState> | ((s: TaskState) => Partial<TaskState>)) => {
    const next =
      typeof partial === 'function'
        ? (partial as (s: TaskState) => Partial<TaskState>)(state as TaskState)
        : partial;
    state = { ...state, ...next };
  };
  const get = () => state as TaskState;
  return {
    permission: createTaskPermissionActions(set as never, get),
    updates: createTaskUpdateActions(set as never, get),
    getState: get,
  };
}

function buildTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    prompt: 'Find the answer',
    status: 'waiting_for_user',
    messages: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function assistanceRecordTask(
  overrides: { status?: TaskStatus; requestId?: string; kind?: 'question' | 'permission' } = {},
): Task {
  return buildTask({
    id: 'task-1',
    status: overrides.status ?? 'waiting_for_user',
    pendingRequest: {
      kind: overrides.kind ?? 'question',
      requestId: overrides.requestId ?? 'questionreq_assist',
      question: 'A CAPTCHA blocks https://example.com/login',
      header: ASSISTANCE_QUESTION_HEADER,
      options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
      multiSelect: false,
      createdAt: new Date().toISOString(),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accomplishMock.respondToPermission.mockReset();
  accomplishMock.respondToPermission.mockResolvedValue(undefined);
});

describe('restorePendingRequestFromTask', () => {
  it('seeds an answerable assistance card from a waiting_for_user record (restart scenario)', () => {
    const { permission, getState } = buildHarness();
    permission.restorePendingRequestFromTask(assistanceRecordTask());

    const state = getState();
    const card = state.permissionRequests?.['task-1'];
    expect(card).toBeTruthy();
    expect(card?.type).toBe('question');
    expect(card?.id).toBe('questionreq_assist');
    expect(card?.header).toBe(ASSISTANCE_QUESTION_HEADER);
    expect(card?.options).toHaveLength(2);
    expect(state.restoredRequestIds?.['task-1']).toBe(true);
  });

  it('seeds clarification question records parked at waiting_permission', () => {
    const { permission, getState } = buildHarness();
    const task = buildTask({
      id: 'task-1',
      status: 'waiting_permission',
      pendingRequest: {
        kind: 'question',
        requestId: 'questionreq_clarify',
        question: 'Which format do you want?',
        header: 'Please clarify',
        options: [{ label: 'CSV' }],
        createdAt: new Date().toISOString(),
      },
    });
    permission.restorePendingRequestFromTask(task);

    const card = getState().permissionRequests?.['task-1'];
    expect(card?.id).toBe('questionreq_clarify');
    expect(card?.header).toBe('Please clarify');
  });

  it('never replays permission-kind records (no Allow/Deny surface for them)', () => {
    const { permission, getState } = buildHarness();
    const task = buildTask({
      id: 'task-1',
      status: 'waiting_permission',
      pendingRequest: {
        kind: 'permission',
        requestId: 'filereq_1',
        createdAt: new Date().toISOString(),
      },
    });
    permission.restorePendingRequestFromTask(task);

    expect(getState().permissionRequests?.['task-1']).toBeUndefined();
  });

  it('skips records for non-waiting statuses (rows whose ask is already resolved)', () => {
    const { permission, getState } = buildHarness();
    for (const status of ['running', 'resuming', 'completed', 'failed'] as TaskStatus[]) {
      permission.restorePendingRequestFromTask(assistanceRecordTask({ status }));
    }
    expect(getState().permissionRequests ?? {}).toEqual({});
  });

  it('skips tasks with no persisted record (pre-M6 rows)', () => {
    const { permission, getState } = buildHarness();
    permission.restorePendingRequestFromTask(buildTask({ id: 'task-1' }));
    expect(getState().permissionRequests ?? {}).toEqual({});
  });

  it('a live notify wins over the restored card and drops the restored marker', () => {
    const { permission, getState } = buildHarness();
    permission.restorePendingRequestFromTask(assistanceRecordTask());

    const live: PermissionRequest = {
      id: 'questionreq_LIVE',
      taskId: 'task-1',
      type: 'question',
      question: 'Real live ask',
      createdAt: new Date().toISOString(),
    };
    permission.setPermissionRequest(live);

    const state = getState();
    expect(state.permissionRequests?.['task-1']?.id).toBe('questionreq_LIVE');
    expect(state.restoredRequestIds?.['task-1']).toBeUndefined();
  });

  it('does not overwrite an existing (live) card with the persisted record', () => {
    const { permission, getState } = buildHarness();
    const live: PermissionRequest = {
      id: 'questionreq_LIVE',
      taskId: 'task-1',
      type: 'question',
      question: 'Real live ask',
      createdAt: new Date().toISOString(),
    };
    permission.setPermissionRequest(live);
    permission.restorePendingRequestFromTask(assistanceRecordTask());

    expect(getState().permissionRequests?.['task-1']?.id).toBe('questionreq_LIVE');
  });

  it('clears a stale rejection error when the card is restored fresh (page-reload analog)', async () => {
    const { permission, getState } = buildHarness();
    permission.restorePendingRequestFromTask(assistanceRecordTask());
    accomplishMock.respondToPermission.mockRejectedValueOnce(
      new Error('permission.respond: stale requestId rejected'),
    );
    await permission.respondToPermission({
      requestId: 'questionreq_assist',
      taskId: 'task-1',
      decision: 'allow',
    });
    expect(getState().permissionRequestErrors?.['task-1']).toContain('stale requestId');

    // Simulate the fresh store after a page reload: the in-memory card is
    // gone, the same persisted record re-seeds on open.
    permission.clearPermissionRequest('task-1');
    permission.restorePendingRequestFromTask(assistanceRecordTask());
    expect(getState().permissionRequestErrors?.['task-1']).toBeUndefined();
    expect(getState().permissionRequests?.['task-1']?.id).toBe('questionreq_assist');
  });
});

describe('respondToPermission — success path (existing behavior preserved)', () => {
  it('clears the card, restored marker and error on a successful reply', async () => {
    const { permission, getState } = buildHarness();
    permission.restorePendingRequestFromTask(assistanceRecordTask());
    await permission.respondToPermission({
      requestId: 'questionreq_assist',
      taskId: 'task-1',
      decision: 'allow',
    });

    const state = getState();
    expect(state.permissionRequests?.['task-1']).toBeUndefined();
    expect(state.restoredRequestIds?.['task-1']).toBeUndefined();
    expect(state.permissionRequestErrors?.['task-1']).toBeUndefined();
  });

  it('keeps the card when a newer request (different id) replaced the responded one', async () => {
    const { permission, getState } = buildHarness();
    permission.setPermissionRequest({
      id: 'questionreq_NEW',
      taskId: 'task-1',
      type: 'question',
      question: 'Newer ask',
      createdAt: new Date().toISOString(),
    });
    await permission.respondToPermission({
      requestId: 'questionreq_OLD',
      taskId: 'task-1',
      decision: 'allow',
    });

    expect(getState().permissionRequests?.['task-1']?.id).toBe('questionreq_NEW');
  });
});

describe('respondToPermission — daemon guardrail rejections (D5 error states)', () => {
  it('records the rejection and keeps the card (no decision is replayed)', async () => {
    const { permission, getState } = buildHarness();
    permission.restorePendingRequestFromTask(assistanceRecordTask());
    accomplishMock.respondToPermission.mockRejectedValueOnce(
      new Error(
        'permission.respond: the pending request for task task-1 expired with its previous session (status failed) and is never replayed. Use the existing Resume affordance to continue the task.',
      ),
    );
    // The action captures the error instead of propagating an unhandled rejection.
    await permission.respondToPermission({
      requestId: 'questionreq_assist',
      taskId: 'task-1',
      decision: 'allow',
    });

    const state = getState();
    expect(state.permissionRequestErrors?.['task-1']).toContain(
      'expired with its previous session',
    );
    // The card stays so the UI can explain what happened.
    expect(state.permissionRequests?.['task-1']).toBeTruthy();
  });

  it('does not record an error when the responded card was replaced by a newer one', async () => {
    const { permission, getState } = buildHarness();
    permission.setPermissionRequest({
      id: 'questionreq_NEW',
      taskId: 'task-1',
      type: 'question',
      question: 'Newer ask',
      createdAt: new Date().toISOString(),
    });
    accomplishMock.respondToPermission.mockRejectedValueOnce(new Error('stale'));
    await permission.respondToPermission({
      requestId: 'questionreq_OLD',
      taskId: 'task-1',
      decision: 'allow',
    });

    const state = getState();
    expect(state.permissionRequestErrors ?? {}).toEqual({});
    expect(state.permissionRequests?.['task-1']).toBeTruthy();
  });
});

describe('updateTaskStatus releases the parked card on resume transitions', () => {
  it("clears card, marker and error when the task resumes ('resuming' / 'running')", () => {
    const { permission, updates, getState } = buildHarness();
    permission.restorePendingRequestFromTask(assistanceRecordTask());
    for (const status of ['resuming', 'running'] as TaskStatus[]) {
      updates.updateTaskStatus('task-1', status);
      const state = getState();
      expect(state.permissionRequests?.['task-1']).toBeUndefined();
      expect(state.restoredRequestIds?.['task-1']).toBeUndefined();
      expect(state.permissionRequestErrors?.['task-1']).toBeUndefined();
    }
  });

  it('keeps the card while the task is still waiting', () => {
    const { permission, updates, getState } = buildHarness();
    permission.restorePendingRequestFromTask(assistanceRecordTask());
    updates.updateTaskStatus('task-1', 'waiting_for_user');
    updates.updateTaskStatus('task-1', 'waiting_permission');

    expect(getState().permissionRequests?.['task-1']).toBeTruthy();
  });
});
