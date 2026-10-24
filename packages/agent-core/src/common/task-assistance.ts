/**
 * Shared assistance-question marker + pending-request persistence helpers
 * (Phase 3 M6-A D1/D2/D4/D5).
 *
 * The config-generator (system-prompt instruction), the OpenCodeAdapter
 * (assistance-kind tagging) and the daemon (`waiting_for_user` routing)
 * MUST import this same constant: the daemon routes a `question`
 * PermissionRequest to `waiting_for_user` iff its `header` string-equals
 * this exact value, so any drift silently degrades assistance routing.
 * Browser-safe by design — UI consumers import the helpers via the `common`
 * barrel.
 */
import { redact } from '../utils/redact.js';
import type { PermissionOption, PermissionRequest } from './types/permission.js';
import type { PendingRequestRecord } from './types/task.js';

export const ASSISTANCE_QUESTION_HEADER = 'Human assistance required';

/**
 * M6-A D3 — the explicit reason recorded when a human DOES NOT answer an
 * assistance question (live Cancel or a no-answer reply after restart). The
 * task ends `failed` with this exact reason instead of a dishonest success.
 * Shared by the OpenCodeAdapter (live cancel path) and the daemon
 * (reply-after-restart path) so the two decline surfaces agree verbatim.
 */
export const ASSISTANCE_DECLINE_REASON = 'Human assistance declined — verification not completed';

/**
 * M6-A §6.4 hard caps. The question text is length-capped BOTH when
 * persisted (v033 `pending_request` column) and when re-delivered inside the
 * reply-after-restart continuation prompt (D5). The embedded human answer is
 * capped separately and never persisted — it only flows back into the SAME
 * already-authorized opencode session.
 */
export const PENDING_REQUEST_QUESTION_CAP = 2000;
export const PENDING_REQUEST_FIELD_CAP = 2000;
export const ASSISTANCE_CONTINUATION_ANSWER_CAP = 4000;
export const PENDING_REQUEST_HEADER_CAP = 200;

function capText(text: string, cap: number): string {
  return text.slice(0, cap);
}

/**
 * Build the persistable pending-request record from a `PermissionRequest`
 * that a task was parked on (M6-A D4). Deterministic and defense-in-depth:
 *
 *   - `kind` collapses `tool`/`file` → `'permission'`, `question` → `'question'`.
 *   - EVERY text surface runs through the universal redactor BEFORE the cap
 *     (§6.4: never persist credential-shaped strings), so a question that
 *     quotes secret material from a page is scrubbed on the way to disk.
 *   - Length caps keep the column bounded regardless of model verbosity.
 *   - tool input, file paths and previews are deliberately DROPPED — the
 *     record is card-context only, never a permission-approval replay.
 *     Permission replies after restart are never replayed (D5).
 */
export function createPendingRequestRecord(request: PermissionRequest): PendingRequestRecord {
  const kind: PendingRequestRecord['kind'] =
    request.type === 'question' ? 'question' : 'permission';
  const record: PendingRequestRecord = {
    kind,
    requestId: request.id,
    createdAt: request.createdAt || new Date().toISOString(),
  };
  if (kind === 'question') {
    if (request.question) {
      record.question = capText(redact(request.question), PENDING_REQUEST_QUESTION_CAP);
    }
    if (request.header) {
      record.header = capText(redact(request.header), PENDING_REQUEST_HEADER_CAP);
    }
    if (request.options && request.options.length > 0) {
      const options: PermissionOption[] = [];
      for (const option of request.options) {
        options.push({
          label: capText(redact(option.label ?? ''), PENDING_REQUEST_FIELD_CAP),
          ...(option.description
            ? { description: capText(redact(option.description), PENDING_REQUEST_FIELD_CAP) }
            : {}),
        });
      }
      record.options = options;
      if (request.multiSelect !== undefined) {
        record.multiSelect = request.multiSelect;
      }
    }
  }
  return record;
}

/**
 * Deterministically compose the human's reply payload into ONE answer string
 * (M6-A requirement: multiple-question answers must never be silently
 * discarded). Order is fixed: selected options in payload order first, then
 * the free text — labelled so the agent can tell the two apart. Returns
 * `null` when nothing was actually answered (a decline) so callers can apply
 * the D3 honest-decline mapping instead of resuming with an empty reply.
 */
export function formatAssistanceAnswer(input: {
  selectedOptions?: string[];
  customText?: string;
}): string | null {
  const options = (input.selectedOptions ?? [])
    .map((option) => option.trim())
    .filter((option) => option.length > 0)
    .map((option) => `- ${capText(option, PENDING_REQUEST_FIELD_CAP)}`);
  const custom = input.customText?.trim().length
    ? capText(input.customText, PENDING_REQUEST_FIELD_CAP)
    : undefined;
  const parts: string[] = [];
  if (options.length > 0) {
    parts.push(`Chosen option(s):\n${options.join('\n')}`);
  }
  if (custom) {
    parts.push(`Human note: ${custom}`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Build the capped continuation prompt for the reply-after-restart auto-resume
 * (M6-A D5). Delivered question text ≤ PENDING_REQUEST_QUESTION_CAP chars and
 * the embedded answer ≤ ASSISTANCE_CONTINUATION_ANSWER_CAP chars — hard
 * slices, deliberately marker-free so the cap is byte-exactly testable.
 */
export function buildAssistanceContinuationPrompt(input: {
  question?: string;
  answer: string;
}): string {
  const lines = ['The human replied to your assistance request.'];
  const question = input.question
    ? capText(redact(input.question), PENDING_REQUEST_QUESTION_CAP)
    : undefined;
  const answer = capText(redact(input.answer), ASSISTANCE_CONTINUATION_ANSWER_CAP);
  if (question) {
    lines.push(`You had asked: ${question}`);
  }
  lines.push(`The human replied: ${answer}`);
  lines.push(
    'Continue the task exactly where it left off, acting only on what the human confirmed.',
  );
  return lines.join('\n');
}
