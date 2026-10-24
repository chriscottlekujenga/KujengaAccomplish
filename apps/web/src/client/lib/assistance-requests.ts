/**
 * Human-assistance request support for the Firefox gateway UI (M6-A T3).
 *
 * The persisted `pendingRequest` record (migration v033, written by the
 * daemon on every human-wait park) is the restore source for the task
 * interface: after a page reload, a gateway reconnect or a daemon restart
 * neither the UI's in-memory request map nor the adapter holds the parked
 * ask, so the card is rebuilt from the record.
 *
 * Replay discipline (plan D5 + §6): only question-kind records are seeded
 * into answerable cards. Permission-kind records deliberately drop tool
 * input / file paths (D4), so they can never be rendered as a safe
 * Allow/Deny surface after a restore — permission decisions are NEVER
 * replayed; the execution page explains this and offers the resume
 * affordance instead.
 */
import {
  ASSISTANCE_QUESTION_HEADER,
  type PendingRequestRecord,
  type PermissionRequest,
  type TaskStatus,
} from '@accomplish_ai/agent-core/common';

/**
 * Whether a request is a human-assistance ask (D2 structural equality on
 * the header) rather than a security-permission or clarifying ask.
 */
export function isAssistanceRequest(request: Pick<PermissionRequest, 'type' | 'header'>): boolean {
  return request.type === 'question' && request.header === ASSISTANCE_QUESTION_HEADER;
}

/** Task statuses that mean the task is parked on a human reply. */
export function isWaitingForHumanStatus(status: TaskStatus): boolean {
  return status === 'waiting_permission' || status === 'waiting_for_user';
}

/**
 * Build a card-shaped `PermissionRequest` from a persisted record. Returns
 * `null` when the record cannot seed a card (missing requestId, non-question
 * kind — those are surfaced as replay-explanations, not reply surfaces).
 */
export function pendingRequestToPermissionRequest(
  record: PendingRequestRecord,
  taskId: string,
): PermissionRequest | null {
  if (!record || record.kind !== 'question' || !record.requestId) {
    return null;
  }
  return {
    id: record.requestId,
    taskId,
    type: 'question',
    ...(record.question ? { question: record.question } : {}),
    ...(record.header ? { header: record.header } : {}),
    ...(record.options && record.options.length > 0 ? { options: record.options } : {}),
    ...(record.multiSelect !== undefined ? { multiSelect: record.multiSelect } : {}),
    createdAt: record.createdAt,
  };
}

/**
 * Human-readable "waiting N" age for the assistance card (D6 — additive,
 * derived from the request's persisted timestamp; no daemon clock, no timer
 * in the daemon loop). Returns `null` while under a minute.
 */
export function formatWaitAge(createdAt: string, now: Date = new Date()): string | null {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) {
    return null;
  }
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - createdMs) / 60000));
  if (totalMinutes < 1) {
    return null;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return `${minutes}m`;
  }
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
