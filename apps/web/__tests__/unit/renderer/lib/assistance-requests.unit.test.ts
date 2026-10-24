/**
 * Unit tests for the assistance-request helpers (M6-A T3).
 * Pins the structural assistance detection (D2), the persisted-record →
 * card reconstruction, and the D6 wait-age formatting.
 */
import { describe, it, expect } from 'vitest';
import {
  isAssistanceRequest,
  isWaitingForHumanStatus,
  pendingRequestToPermissionRequest,
  formatWaitAge,
} from '@/lib/assistance-requests';
import { ASSISTANCE_QUESTION_HEADER } from '@accomplish_ai/agent-core/common';
import type { PendingRequestRecord } from '@accomplish_ai/agent-core/common';

describe('isAssistanceRequest', () => {
  it('returns true only for questions carrying the exact assistance header', () => {
    expect(isAssistanceRequest({ type: 'question', header: ASSISTANCE_QUESTION_HEADER })).toBe(
      true,
    );
  });

  it('rejects clarifying questions with any other header', () => {
    expect(isAssistanceRequest({ type: 'question', header: 'Please clarify' })).toBe(false);
    expect(isAssistanceRequest({ type: 'question', header: undefined })).toBe(false);
  });

  it('rejects tool and file permission requests even with a matching header', () => {
    expect(isAssistanceRequest({ type: 'tool', header: ASSISTANCE_QUESTION_HEADER } as never)).toBe(
      false,
    );
    expect(isAssistanceRequest({ type: 'file', header: ASSISTANCE_QUESTION_HEADER } as never)).toBe(
      false,
    );
  });
});

describe('isWaitingForHumanStatus', () => {
  it('accepts both human-wait statuses', () => {
    expect(isWaitingForHumanStatus('waiting_permission')).toBe(true);
    expect(isWaitingForHumanStatus('waiting_for_user')).toBe(true);
  });

  it('rejects non-waiting statuses', () => {
    for (const status of [
      'pending',
      'queued',
      'running',
      'resuming',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      expect(isWaitingForHumanStatus(status)).toBe(false);
    }
  });
});

describe('pendingRequestToPermissionRequest', () => {
  const baseRecord: PendingRequestRecord = {
    kind: 'question',
    requestId: 'questionreq_assist',
    question: 'A CAPTCHA blocks https://example.com/login',
    header: ASSISTANCE_QUESTION_HEADER,
    options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
    multiSelect: false,
    createdAt: '2026-10-23T10:00:00.000Z',
  };

  it('rebuilds a card-shaped question request from a persisted record', () => {
    const result = pendingRequestToPermissionRequest(baseRecord, 'task-1');
    expect(result).toEqual({
      id: 'questionreq_assist',
      taskId: 'task-1',
      type: 'question',
      question: baseRecord.question,
      header: ASSISTANCE_QUESTION_HEADER,
      options: baseRecord.options,
      multiSelect: false,
      createdAt: baseRecord.createdAt,
    });
  });

  it('omits optional fields the record does not carry', () => {
    const result = pendingRequestToPermissionRequest(
      { kind: 'question', requestId: 'questionreq_2', createdAt: baseRecord.createdAt },
      'task-1',
    );
    expect(result).toEqual({
      id: 'questionreq_2',
      taskId: 'task-1',
      type: 'question',
      createdAt: baseRecord.createdAt,
    });
  });

  it('returns null for non-question kinds (permission decisions are never replayed)', () => {
    const permissionRecord: PendingRequestRecord = {
      kind: 'permission',
      requestId: 'filereq_1',
      createdAt: baseRecord.createdAt,
    };
    expect(pendingRequestToPermissionRequest(permissionRecord, 'task-1')).toBeNull();
  });

  it('returns null for records with a missing requestId', () => {
    const broken = { ...baseRecord, requestId: '' } as PendingRequestRecord;
    expect(pendingRequestToPermissionRequest(broken, 'task-1')).toBeNull();
    expect(pendingRequestToPermissionRequest(undefined as never, 'task-1')).toBeNull();
  });
});

describe('formatWaitAge', () => {
  const now = new Date('2026-10-23T12:00:00.000Z');

  const minutesAgo = (m: number): string => new Date(now.getTime() - m * 60000).toISOString();

  it('returns null under one minute (no noisy ages)', () => {
    expect(formatWaitAge(minutesAgo(0), now)).toBeNull();
    expect(formatWaitAge(minutesAgo(0.5), now)).toBeNull();
  });

  it('formats minutes below an hour', () => {
    expect(formatWaitAge(minutesAgo(1), now)).toBe('1m');
    expect(formatWaitAge(minutesAgo(59), now)).toBe('59m');
  });

  it('formats hours with minutes', () => {
    expect(formatWaitAge(minutesAgo(60), now)).toBe('1h');
    expect(formatWaitAge(minutesAgo(83), now)).toBe('1h 23m');
    expect(formatWaitAge(minutesAgo(24 * 60), now)).toBe('24h');
  });

  it('never yields a negative age and tolerates invalid input', () => {
    const future = new Date(now.getTime() + 30 * 60000).toISOString();
    expect(formatWaitAge(future, now)).toBeNull();
    expect(formatWaitAge('not-a-date', now)).toBeNull();
  });
});
