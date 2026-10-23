/**
 * Task callback factory for TaskService.
 * Extracted from task-config-builder.ts to keep that file under 200 lines.
 *
 * NO electron imports — this runs as plain Node.js.
 */
import type { EventEmitter } from 'node:events';
import {
  mapResultToStatus,
  type TaskCallbacks,
  type TaskMessage,
  type TaskResult,
  type TaskStatus,
  type PermissionRequest,
  type PermissionResponse,
  type TaskSource,
  type StorageAPI,
  type TaskManagerAPI,
  type TodoItem,
  type BrowserFramePayload,
} from '@accomplish_ai/agent-core';

/**
 * Minimal RPC-server surface the interactive-presence auto-deny policy
 * depends on. We inject the probe rather than a full `DaemonRpcServer`
 * reference to keep the callback factory decoupled from the RPC server's
 * concrete class.
 *
 * Renamed in Phase 3 M1 (PHASE_3_IMPLEMENTATION_PLAN §5.2): the old
 * `hasConnectedClients` probe counted the gateway's persistent socket as a
 * UI, so permissions never auto-denied while the host ran. The daemon now
 * reports `hasInteractiveClients()` — connected legacy clients (trusted
 * shell) OR gateway-reported fresh browser-UI counts.
 */
export interface InteractivePresenceProbe {
  hasInteractiveClients(): boolean;
}

/**
 * Dependencies the callback factory needs beyond the original four. Added in
 * Phase 2 of the SDK cutover port to replace the deleted `PermissionService`'s
 * no-UI auto-deny safeguard.
 */
export interface TaskCallbackExtras {
  /** Interactive-presence probe — see `InteractivePresenceProbe`. */
  presence: InteractivePresenceProbe;
  /** Resolve the originating surface (`'ui' | 'whatsapp' | 'scheduler'`) for a task. */
  getTaskSource: (taskId: string) => TaskSource;
  /**
   * Deliver a permission/question response back to the adapter (used by the
   * auto-deny path). Typically a bound `taskService.sendResponse`.
   */
  sendPermissionResponse: (taskId: string, response: PermissionResponse) => Promise<void>;
}

export function createTaskCallbacks(
  taskId: string,
  emitter: EventEmitter,
  storage: StorageAPI,
  taskManager: TaskManagerAPI,
  extras: TaskCallbackExtras,
): TaskCallbacks {
  return {
    onBatchedMessages: (messages: TaskMessage[]) => {
      emitter.emit('message', { taskId, messages });
      for (const msg of messages) {
        storage.addTaskMessage(taskId, msg);
      }
    },
    onProgress: (progress) => {
      emitter.emit('progress', { taskId, ...progress });
    },
    onPermissionRequest: (request: PermissionRequest) => {
      // Source-based dispatch, introduced in Phase 2 of the SDK cutover port
      // to replace the `PermissionService`-era "no UI connected → auto-deny"
      // safeguard (previously implemented inside the permission HTTP handlers).
      //
      //   'whatsapp' + bridge attached: emit; wireTaskBridge auto-denies.
      //   'whatsapp' + no bridge: auto-deny HERE (plan decision #10 guard).
      //   !UI + !whatsapp: auto-deny — no caller will respond.
      //   otherwise (UI source): emit the request to the UI via RPC.
      const source = extras.getTaskSource(taskId);
      const autoDeny = (): void => {
        extras
          .sendPermissionResponse(taskId, {
            taskId,
            requestId: request.id,
            decision: 'deny',
          })
          .catch(() => {
            // Swallow — auto-deny failures are logged at the sendResponse layer.
          });
      };
      // M4: a request emitted to a human-facing surface parks the task in
      // 'waiting_permission' — the turn is blocked on a HUMAN reply, so the
      // boot-time crash sweep (recoverStaleTasks — 'running' only) must not
      // record it as a stale orphan: a waiting task keeps its resumable
      // sessionId + cwd and is recovered via resumeSession. The auto-deny
      // branches below deliberately skip this: the deny is immediate, no
      // human ever waits, and the task stays 'running' throughout.
      const markWaitingOnHuman = (): void => {
        storage.updateTaskStatus(taskId, 'waiting_permission');
        emitter.emit('statusChange', { taskId, status: 'waiting_permission' });
      };

      if (source === 'whatsapp') {
        // Plan decision #10: if `source === 'whatsapp'` but no WhatsApp
        // bridge is actually subscribed to the 'permission' event (e.g.,
        // WhatsApp integration disabled at runtime), emitting into the
        // void leaves the adapter's `pendingRequest` unresolved and the
        // task hangs forever. Probe listener count — if nothing beyond
        // the daemon's own RPC-notify forwarder is listening, treat as
        // no-UI and auto-deny.
        const listenerCount = emitter.listenerCount('permission');
        if (listenerCount <= 1) {
          autoDeny();
          return;
        }
        markWaitingOnHuman();
        emitter.emit('permission', request);
        return;
      }

      if (!extras.presence.hasInteractiveClients()) {
        autoDeny();
        return;
      }

      markWaitingOnHuman();
      emitter.emit('permission', request);
    },
    onComplete: (result: TaskResult) => {
      emitter.emit('complete', { taskId, result });
      const taskStatus = mapResultToStatus(result);
      storage.updateTaskStatus(taskId, taskStatus, new Date().toISOString());
      const sessionId = result.sessionId || taskManager.getSessionId(taskId);
      if (sessionId) {
        storage.updateTaskSessionId(taskId, sessionId);
      }
      if (result.status === 'success') {
        storage.clearTodosForTask(taskId);
      }
    },
    onError: (error: Error) => {
      emitter.emit('error', { taskId, error: error.message });
      storage.updateTaskStatus(taskId, 'failed', new Date().toISOString());
    },
    onStatusChange: (status: TaskStatus) => {
      emitter.emit('statusChange', { taskId, status });
      storage.updateTaskStatus(taskId, status, new Date().toISOString());
    },
    onTodoUpdate: (todos: TodoItem[]) => {
      // Persist AND emit. Prior to this fix the callback only persisted,
      // so TaskManager forwarded the adapter's `todo:update` into the
      // daemon but the daemon never re-notified the desktop. Desktop's
      // `daemon-bootstrap` already listens for `todo.update` RPC
      // notifications (see apps/desktop/src/main/daemon-bootstrap.ts:217)
      // → TodoSidebar went dark on real SDK runs.
      storage.saveTodosForTask(taskId, todos);
      emitter.emit('todo:update', { taskId, todos });
    },
    onAuthError: (error: { providerId: string; message: string }) => {
      // Connector auth-required marker observed in tool output. Desktop
      // preload subscribes to `auth:error` IPC (see
      // apps/desktop/src/preload/index.ts:481). Was missing entirely from
      // the daemon callback factory — auth-expired toasts silently dropped
      // on real SDK runs.
      emitter.emit('auth:error', { taskId, ...error });
    },
    onBrowserFrame: (data: BrowserFramePayload) => {
      // Browser preview frames (ENG-695 / PR #414). Desktop preload
      // subscribes to `browser:frame` (see
      // apps/desktop/src/preload/index.ts:494). Was missing entirely
      // from the daemon callback factory — dev-browser-mcp preview went
      // dark on real SDK runs even though the plan (decision #7)
      // explicitly calls out preserving this path.
      emitter.emit('browser:frame', { taskId, ...data });
    },
  };
}
