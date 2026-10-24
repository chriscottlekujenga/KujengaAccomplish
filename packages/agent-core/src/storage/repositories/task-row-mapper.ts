import type {
  PendingRequestRecord,
  TaskMessage,
  TaskStatus,
  TaskAttachment,
} from '../../common/types/task.js';
import { getDatabase } from '../database.js';

export interface StoredTask {
  id: string;
  prompt: string;
  summary?: string;
  status: TaskStatus;
  messages: TaskMessage[];
  sessionId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  workspaceId?: string;
  /** Preserved across resume turns — see `Task.workingDirectory`. */
  workingDirectory?: string;
  /** M6-A D4: persisted pending permission/question request (see `PendingRequestRecord`). */
  pendingRequest?: PendingRequestRecord;
}

export interface TaskRow {
  id: string;
  prompt: string;
  summary: string | null;
  status: string;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  workspace_id: string | null;
  working_directory: string | null;
  pending_request: string | null;
}

/**
 * Defensive parse of the v033 `pending_request` JSON column (M6-A D4).
 * A corrupted record (truncated write, foreign schema) degrades to NULL —
 * the card simply doesn't restore — instead of failing every task read.
 */
export function parsePendingRequestRecord(json: string | null): PendingRequestRecord | null {
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as Partial<PendingRequestRecord>;
    const isKind = (value: unknown): value is PendingRequestRecord['kind'] =>
      value === 'permission' || value === 'question';
    if (
      isKind(parsed.kind) &&
      typeof parsed.requestId === 'string' &&
      parsed.requestId.length > 0
    ) {
      return parsed as PendingRequestRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export interface MessageRow {
  id: string;
  task_id: string;
  type: string;
  content: string;
  tool_name: string | null;
  tool_input: string | null;
  timestamp: string;
  sort_order: number;
  tool_status: string | null;
  model_id: string | null;
  provider_id: string | null;
}

export interface AttachmentRow {
  id: number;
  message_id: string;
  type: string;
  data: string;
  label: string | null;
}

export function getMessagesForTask(taskId: string): TaskMessage[] {
  const db = getDatabase();

  const messageRows = db
    .prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY sort_order ASC')
    .all(taskId) as MessageRow[];

  if (messageRows.length === 0) {
    return [];
  }

  // Fetch all attachments in a single query to avoid N+1
  const messageIds = messageRows.map((r) => r.id);
  const placeholders = messageIds.map(() => '?').join(',');
  const allAttachmentRows = db
    .prepare(`SELECT * FROM task_attachments WHERE message_id IN (${placeholders})`)
    .all(...messageIds) as AttachmentRow[];

  // Group attachments by message_id
  const attachmentsByMessageId = new Map<string, AttachmentRow[]>();
  for (const row of allAttachmentRows) {
    const existing = attachmentsByMessageId.get(row.message_id);
    if (existing) {
      existing.push(row);
    } else {
      attachmentsByMessageId.set(row.message_id, [row]);
    }
  }

  const messages: TaskMessage[] = [];

  for (const row of messageRows) {
    const attachmentRows = attachmentsByMessageId.get(row.id) ?? [];

    const attachments: TaskAttachment[] | undefined =
      attachmentRows.length > 0
        ? attachmentRows.map((a) => ({
            type: a.type as 'screenshot' | 'json',
            data: a.data,
            label: a.label || undefined,
          }))
        : undefined;

    let toolInput: unknown;
    if (row.tool_input) {
      try {
        toolInput = JSON.parse(row.tool_input);
      } catch {
        toolInput = row.tool_input;
      }
    }
    const toolStatus = row.tool_status as TaskMessage['toolStatus'] | null;
    messages.push({
      id: row.id,
      type: row.type as TaskMessage['type'],
      content: row.content,
      toolName: row.tool_name || undefined,
      toolStatus: toolStatus || undefined,
      toolInput,
      timestamp: row.timestamp,
      attachments,
      modelId: row.model_id || undefined,
      providerId: row.provider_id || undefined,
    });
  }

  return messages;
}

export function rowToTask(row: TaskRow): StoredTask {
  return {
    id: row.id,
    prompt: row.prompt,
    summary: row.summary || undefined,
    status: row.status as TaskStatus,
    sessionId: row.session_id || undefined,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    workspaceId: row.workspace_id || undefined,
    workingDirectory: row.working_directory || undefined,
    // Omitted entirely when the column is empty/unparseable so byte-identical
    // `JSON.stringify(row)` restart assertions stay possible.
    pendingRequest: parsePendingRequestRecord(row.pending_request) ?? undefined,
    messages: getMessagesForTask(row.id),
  };
}
