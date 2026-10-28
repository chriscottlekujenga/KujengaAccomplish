import { describe, it, expect } from 'vitest';
import {
  ASSISTANCE_QUESTION_HEADER,
  ASSISTANCE_DECLINE_REASON,
  ASSISTANCE_CONTINUATION_ANSWER_CAP,
  PENDING_REQUEST_QUESTION_CAP,
  createPendingRequestRecord,
  formatAssistanceAnswer,
  buildAssistanceContinuationPrompt,
} from '../../../src/common/task-assistance.js';
import type { PermissionOption, PermissionRequest } from '../../../src/common/types/permission.js';
import type { PendingRequestRecord } from '../../../src/common/types/task.js';

function buildQuestionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'questionreq_123',
    taskId: 'tsk_1',
    type: 'question',
    question: 'A CAPTCHA is blocking https://example.com/form',
    header: ASSISTANCE_QUESTION_HEADER,
    options: [
      { label: "I'll complete it — please wait" },
      { label: 'Skip this verification' },
    ] satisfies PermissionOption[],
    multiSelect: false,
    createdAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('createPendingRequestRecord (M6-A D4)', () => {
  it('maps a question request to a question-kind record with card context', () => {
    const record = createPendingRequestRecord(buildQuestionRequest());
    expect(record).toEqual<PendingRequestRecord>({
      kind: 'question',
      requestId: 'questionreq_123',
      question: 'A CAPTCHA is blocking https://example.com/form',
      header: ASSISTANCE_QUESTION_HEADER,
      options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
      multiSelect: false,
      createdAt: '2026-10-23T00:00:00.000Z',
    });
  });

  it('collapses tool/file permission requests to permission-kind without question fields', () => {
    const fileRequest = buildQuestionRequest({
      id: 'filereq_abc',
      type: 'file',
      fileOperation: 'create',
      filePath: '/tmp/secret-env.txt',
      contentPreview: 'api_key=sk-genuinelysecretstring123456',
    } as Partial<PermissionRequest>);
    const record = createPendingRequestRecord(fileRequest);
    expect(record.kind).toBe('permission');
    expect(record.requestId).toBe('filereq_abc');
    expect(record.question).toBeUndefined();
    expect(record.header).toBeUndefined();
    expect(record.options).toBeUndefined();
  });

  it('redacts credential-shaped question text BEFORE it reaches the record (§6.4)', () => {
    const record = createPendingRequestRecord(
      buildQuestionRequest({
        question:
          'The form at https://example.com rejects my login. It echoes token Bearer sk-abcdefghijklmnopqrstuvwx back as an error',
      }),
    );
    expect(record.question).toBeDefined();
    expect(record.question).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(record.question).toContain('[REDACTED]');
  });

  it('hard-caps the question text at the 2000-char persistence cap and drops tool input', () => {
    const record = createPendingRequestRecord(
      buildQuestionRequest({
        question: 'x'.repeat(10_000),
      }),
    );
    expect(record.question).toHaveLength(PENDING_REQUEST_QUESTION_CAP);
  });

  it('keeps the recorded createdAt (or falls back to now for degenerate input)', () => {
    const withDate = createPendingRequestRecord(buildQuestionRequest());
    expect(withDate.createdAt).toBe('2026-10-23T00:00:00.000Z');
    const withoutDate = createPendingRequestRecord(
      buildQuestionRequest({ createdAt: undefined as unknown as string }),
    );
    expect(withoutDate.createdAt).toBeTruthy();
  });
});

describe('formatAssistanceAnswer (M6-A multi-question determinism)', () => {
  it('combines selected options AND custom text without dropping answers', () => {
    const answer = formatAssistanceAnswer({
      selectedOptions: ["I'll complete it — please wait", 'Another option'],
      customText: 'Also: I cleared my cookies first',
    });
    expect(answer).toContain(
      "Chosen option(s):\n- I'll complete it — please wait\n- Another option",
    );
    expect(answer).toContain('Human note: Also: I cleared my cookies first');
  });

  it('preserves the deterministic option order from the payload', () => {
    const answer = formatAssistanceAnswer({
      selectedOptions: ['Skip this verification', 'Option B'],
    });
    expect(answer!.indexOf('Skip this verification')).toBeLessThan(answer!.indexOf('Option B'));
  });

  it('trims and drops blank selections but keeps real content', () => {
    const answer = formatAssistanceAnswer({
      selectedOptions: ['  ', 'Real option'],
      customText: '  ',
    });
    expect(answer).toBe('Chosen option(s):\n- Real option');
  });

  it('returns null when nothing was answered (decline) — never an empty resume', () => {
    expect(formatAssistanceAnswer({})).toBeNull();
    expect(formatAssistanceAnswer({ selectedOptions: [] })).toBeNull();
    expect(formatAssistanceAnswer({ selectedOptions: [''] })).toBeNull();
    expect(formatAssistanceAnswer({ customText: '   ' })).toBeNull();
    expect(formatAssistanceAnswer({ selectedOptions: [], customText: '' })).toBeNull();
  });

  it('shares the adapter decline reason verbatim (D3 cross-surface identity)', () => {
    expect(ASSISTANCE_DECLINE_REASON).toBe(
      'Human assistance declined — verification not completed',
    );
  });
});

describe('buildAssistanceContinuationPrompt (M6-A D5)', () => {
  it('embeds the question and the human reply with the required reply line', () => {
    const prompt = buildAssistanceContinuationPrompt({
      question: 'A CAPTCHA is blocking https://example.com/form',
      answer: "I'll complete it — please wait",
    });
    expect(prompt).toContain('The human replied to your assistance request.');
    expect(prompt).toContain('You had asked: A CAPTCHA is blocking https://example.com/form');
    expect(prompt).toContain("The human replied: I'll complete it — please wait");
    expect(prompt).toContain('Continue the task exactly where it left off');
  });

  it('caps the embedded question at 2000 chars', () => {
    const prompt = buildAssistanceContinuationPrompt({
      question: 'q'.repeat(5000),
      answer: 'ok',
    });
    expect(prompt).toContain(`You had asked: ${'q'.repeat(PENDING_REQUEST_QUESTION_CAP)}`);
    const questionLine = prompt.split('\n').find((line) => line.startsWith('You had asked: '))!;
    expect(questionLine.length).toBeLessThanOrEqual(
      'You had asked: '.length + PENDING_REQUEST_QUESTION_CAP,
    );
  });

  it('caps the embedded answer at 4000 chars', () => {
    const prompt = buildAssistanceContinuationPrompt({
      answer: 'a'.repeat(10_000),
    });
    expect(prompt).toContain(
      `The human replied: ${'a'.repeat(ASSISTANCE_CONTINUATION_ANSWER_CAP)}`,
    );
    expect(prompt).not.toContain('a'.repeat(ASSISTANCE_CONTINUATION_ANSWER_CAP + 1));
  });

  it('omits the question line entirely when the record carried none', () => {
    const prompt = buildAssistanceContinuationPrompt({ answer: 'Skip it' });
    expect(prompt).not.toContain('You had asked:');
    expect(prompt).toContain('The human replied: Skip it');
  });

  it('SEC-1: masks secret-shaped content in the answer when the question text is credential-flagged', () => {
    const prompt = buildAssistanceContinuationPrompt({
      question: 'Tell me the 6-digit code from the email',
      answer: 'the code is 482913',
    });
    const replyLine = prompt.split('\n').find((line) => line.startsWith('The human replied:'))!;
    expect(replyLine).not.toContain('482913');
    expect(replyLine).toContain('REDACTED');
  });

  it('SEC-1: applies the shared redactor even on an unflagged continuation', () => {
    const prompt = buildAssistanceContinuationPrompt({
      question: 'Which format do you want?',
      answer: 'run with key sk-abcdefghijklmnopqrstuvwxyz0123',
    });
    const replyLine = prompt.split('\n').find((line) => line.startsWith('The human replied:'))!;
    expect(replyLine).toContain('REDACTED');
    expect(replyLine).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
  });
});
