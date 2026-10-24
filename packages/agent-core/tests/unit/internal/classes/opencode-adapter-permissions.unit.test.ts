import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeAdapter } from '../../../../src/internal/classes/OpenCodeAdapter.js';
import { ASSISTANCE_QUESTION_HEADER } from '../../../../src/common/task-assistance.js';
import type { PermissionRequest } from '../../../../src/common/types/permission.js';

describe('OpenCodeAdapter permission request mapping', () => {
  function constructAdapter(): OpenCodeAdapter {
    return new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_permission_mapping',
    );
  }

  it('maps bash permission events to a readable tool name and command details', () => {
    const adapter = constructAdapter();
    const requests: PermissionRequest[] = [];
    adapter.on('permission-request', (request) => requests.push(request));

    (
      adapter as unknown as {
        currentTaskId: string;
        handlePermissionAsked: (request: unknown) => void;
      }
    ).currentTaskId = 'tsk_permission_mapping';

    (
      adapter as unknown as {
        handlePermissionAsked: (request: unknown) => void;
      }
    ).handlePermissionAsked({
      id: 'sdk_perm_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['printf "hello" > ~/Desktop/kuku.txt'],
      metadata: {},
      always: [],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      taskId: 'tsk_permission_mapping',
      type: 'tool',
      toolName: 'Bash',
      toolInput: {
        command: 'printf "hello" > ~/Desktop/kuku.txt',
        permission: 'bash',
      },
    });
  });
});

/**
 * M6-A D3 (Phase 3): questions whose header string-equals the shared
 * ASSISTANCE_QUESTION_HEADER are human-verification assistance asks and get
 * honest end-of-turn semantics — a Cancel (deny, no answer) must end the
 * task `failed` with the explicit decline reason instead of the
 * clarification-cancel `success`. An ANSWERED assistance question continues
 * the live turn: sendResponse must emit NO 'complete' of its own.
 */
describe('OpenCodeAdapter assistance-question tagging + honest decline (M6-A D3)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function constructAdapter(taskId: string): OpenCodeAdapter {
    return new OpenCodeAdapter({ platform: 'darwin', isPackaged: false, tempPath: '/tmp' }, taskId);
  }

  interface FakeQuestionClient {
    client: unknown;
    reply: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
  }

  function buildFakeQuestionClient(): FakeQuestionClient {
    const reply = vi.fn(async () => {});
    const reject = vi.fn(async () => {});
    return { client: { question: { reply, reject } }, reply, reject };
  }

  function seedPendingQuestion(
    adapter: OpenCodeAdapter,
    client: unknown,
    sdkRequestId: string,
    assistance: boolean,
  ): { pendingRequest: { assistance?: boolean } | null } {
    const priv = adapter as unknown as { pendingRequest: Record<string, unknown> | null };
    priv.pendingRequest = {
      kind: 'question',
      requestId: sdkRequestId.replace('sdk_q_', 'questionreq_'),
      sdkRequestId,
      sessionId: 'ses_seed',
      ...(assistance ? { assistance: true } : {}),
    };
    (adapter as unknown as { client: unknown }).client = client;
    return priv as unknown as { pendingRequest: { assistance?: boolean } | null };
  }

  it('tags a question carrying the assistance header as assistance-kind', () => {
    const adapter = constructAdapter('tsk_assist_tag');
    const requests: PermissionRequest[] = [];
    adapter.on('permission-request', (request) => requests.push(request));

    (
      adapter as unknown as {
        currentTaskId: string;
        handleQuestionAsked: (request: unknown) => void;
      }
    ).currentTaskId = 'tsk_assist_tag';

    (
      adapter as unknown as {
        handleQuestionAsked: (request: unknown) => void;
      }
    ).handleQuestionAsked({
      id: 'sdk_q_assist',
      sessionID: 'ses_1',
      questions: [
        {
          question: 'A CAPTCHA is blocking https://example.com/form',
          header: ASSISTANCE_QUESTION_HEADER,
          options: [
            { label: "I'll complete it — please wait" },
            { label: 'Skip this verification' },
          ],
          multiple: false,
        },
      ],
    });

    const priv = adapter as unknown as { pendingRequest: { assistance?: boolean } | null };
    expect(priv.pendingRequest).not.toBeNull();
    expect(priv.pendingRequest?.assistance).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      taskId: 'tsk_assist_tag',
      type: 'question',
      header: ASSISTANCE_QUESTION_HEADER,
    });
  });

  it('tags a clarification question as NOT assistance-kind', () => {
    const adapter = constructAdapter('tsk_clarify_tag');

    (
      adapter as unknown as {
        currentTaskId: string;
        handleQuestionAsked: (request: unknown) => void;
      }
    ).currentTaskId = 'tsk_clarify_tag';

    (
      adapter as unknown as {
        handleQuestionAsked: (request: unknown) => void;
      }
    ).handleQuestionAsked({
      id: 'sdk_q_clarify',
      sessionID: 'ses_2',
      questions: [
        {
          question: 'Which format do you want?',
          header: 'A quick question',
          options: [{ label: 'Markdown' }, { label: 'Plain text' }],
          multiple: false,
        },
      ],
    });

    const priv = adapter as unknown as { pendingRequest: { assistance?: boolean } | null };
    expect(priv.pendingRequest).not.toBeNull();
    expect(priv.pendingRequest?.assistance).toBe(false);
  });

  it('assistance question + deny with no answers → complete status "error" with the decline reason', async () => {
    const adapter = constructAdapter('tsk_assist_deny');
    const fake = buildFakeQuestionClient();
    seedPendingQuestion(adapter, fake.client, 'sdk_q_assist_deny', true);

    const completeEvents: Array<{ status: string; error?: string }> = [];
    adapter.on('complete', (result) => completeEvents.push(result));

    await adapter.sendResponse({
      requestId: 'questionreq_assist_deny',
      taskId: 'tsk_assist_deny',
      decision: 'deny',
    });

    expect(fake.reject).toHaveBeenCalledWith(
      { requestID: 'sdk_q_assist_deny' },
      expect.objectContaining({ throwOnError: true }),
    );
    expect(fake.reply).not.toHaveBeenCalled();
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].status).toBe('error');
    expect(completeEvents[0].error).toContain('Human assistance declined');
  });

  it('clarification question + deny with no answers → complete status "success" byte-identical', async () => {
    const adapter = constructAdapter('tsk_clarify_deny');
    const fake = buildFakeQuestionClient();
    seedPendingQuestion(adapter, fake.client, 'sdk_q_clarify_deny', false);

    const completeEvents: Array<{ status: string; error?: string }> = [];
    adapter.on('complete', (result) => completeEvents.push(result));

    await adapter.sendResponse({
      requestId: 'questionreq_clarify_deny',
      taskId: 'tsk_clarify_deny',
      decision: 'deny',
    });

    expect(fake.reject).toHaveBeenCalled();
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]).toEqual({ status: 'success', sessionId: undefined });
    expect(completeEvents[0].error).toBeUndefined();
  });

  it('assistance question answered via selectedOptions/customText → no "complete" emission (turn continues)', async () => {
    const adapter = constructAdapter('tsk_assist_answered');
    const fake = buildFakeQuestionClient();
    const priv = seedPendingQuestion(adapter, fake.client, 'sdk_q_assist_answered', true);

    const completeEvents: Array<{ status: string; error?: string }> = [];
    adapter.on('complete', (result) => completeEvents.push(result));

    await adapter.sendResponse({
      requestId: 'questionreq_assist_answered',
      taskId: 'tsk_assist_answered',
      decision: 'allow',
      selectedOptions: ["I'll complete it — please wait"],
      customText: 'I will solve it now, it is my banking portal',
    });

    expect(fake.reply).toHaveBeenCalledWith(
      {
        requestID: 'sdk_q_assist_answered',
        answers: [
          ["I'll complete it — please wait"],
          ['I will solve it now, it is my banking portal'],
        ],
      },
      expect.objectContaining({ throwOnError: true }),
    );
    expect(fake.reject).not.toHaveBeenCalled();
    expect(completeEvents).toHaveLength(0);
    expect(priv.pendingRequest).toBeNull();
  });
});
