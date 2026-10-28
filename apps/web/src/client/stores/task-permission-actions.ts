import type {
  PendingRequestRecord,
  PermissionRequest,
  PermissionResponse,
  Task,
  TaskStatus,
} from '@accomplish_ai/agent-core/common';
import { getAccomplish } from '../lib/accomplish';
import {
  isWaitingForHumanStatus,
  pendingRequestToPermissionRequest,
} from '../lib/assistance-requests';
import type { TaskState } from './taskStore';
import { hasTaskStateToken } from './task-state-helpers';

type SetFn = (partial: Partial<TaskState> | ((state: TaskState) => Partial<TaskState>)) => void;
type GetFn = () => TaskState;

/**
 * Shared card-seeding core (T3 restore + T4 route re-read). Only a
 * question-kind record with a requestId can seed an answerable card; a live
 * `permission.request` notify always wins over the persisted/remote record.
 */
function seedPendingRequestCard(
  taskId: string,
  status: TaskStatus,
  record: PendingRequestRecord | undefined | null,
  set: SetFn,
): void {
  if (!record || !isWaitingForHumanStatus(status)) {
    return;
  }
  const restored = pendingRequestToPermissionRequest(record, taskId);
  if (!restored) {
    return;
  }
  set((state) => {
    // M6-A T6: a live card with the SAME requestId is the pre-restart ask —
    // the adapter died with the daemon, so the persisted record rebuild is
    // the authoritative card and it must carry the restored marker (the
    // daemon:reconnected restore path hits exactly this on a page that kept
    // the card open across the restart). A DIFFERENT id is a genuinely newer
    // live ask — it wins unchanged (T3 replay discipline preserved).
    const existing = state.permissionRequests[taskId];
    if (existing && existing.id !== restored.id) {
      return state;
    }
    const { [taskId]: _, ...restErrors } = state.permissionRequestErrors ?? {};
    return {
      permissionRequests: { ...state.permissionRequests, [taskId]: restored },
      restoredRequestIds: { ...(state.restoredRequestIds ?? {}), [taskId]: true },
      permissionRequestErrors: restErrors,
    };
  });
}

/** Permission request/response slice of the task store. */
export function createTaskPermissionActions(set: SetFn, get: GetFn) {
  return {
    setPermissionRequest: (request: PermissionRequest) => {
      set((state) => {
        const { [request.taskId]: _, ...restRestored } = state.restoredRequestIds ?? {};
        return {
          permissionRequests: { ...state.permissionRequests, [request.taskId]: request },
          restoredRequestIds: restRestored,
        };
      });
    },

    clearPermissionRequest: (taskId: string) => {
      set((state) => {
        const { [taskId]: _, ...rest } = state.permissionRequests;
        const { [taskId]: __, ...restRestored } = state.restoredRequestIds ?? {};
        const { [taskId]: ___, ...restErrors } = state.permissionRequestErrors ?? {};
        return {
          permissionRequests: rest,
          restoredRequestIds: restRestored,
          permissionRequestErrors: restErrors,
        };
      });
    },

    /**
     * M6-A T3: restore an unanswered question card from the persisted
     * `pendingRequest` record after a page reload, gateway reconnect or
     * daemon restart. One-shot read per task open — the record rides the
     * already-allowlisted `task.get` payload, so no new RPC fan-out. A live
     * `permission.request` notify always wins over the restored card.
     */
    restorePendingRequestFromTask: (task: Task) => {
      seedPendingRequestCard(task.id, task.status, task.pendingRequest, set);
    },

    /**
     * M6-A T4 (§6.9): the assistance card re-reads on `task.statusChange`
     * only — the one-shot consumer of the dedicated `task.getPendingRequest`
     * route. Called from the execution page's statusChange subscription when
     * the task parks at a waiting status and no card is displayed (a lost
     * notify, or an ask that raced the task open). The re-read is guarded:
     * the seed re-checks the CURRENT (post-await) store status so a task
     * that resolved while the read was in flight never gets a stale card,
     * a live notify always wins, and the Electron surface (method absent)
     * gracefully does nothing.
     */
    refetchPendingRequest: async (taskId: string) => {
      const accomplish = getAccomplish();
      if (typeof accomplish.getPendingRequest !== 'function') {
        return;
      }
      const taskStateToken = get()._taskStateToken;
      let record: PendingRequestRecord | null = null;
      try {
        record = await accomplish.getPendingRequest(taskId);
      } catch (err) {
        // A failed restore read must never break the execution page: the
        // card stays absent, the next statusChange (or task open) retries.
        void accomplish.logEvent({
          level: 'warn',
          message: 'Pending-request refetch failed',
          context: { taskId, error: String(err) },
        });
        return;
      }
      if (!record || !hasTaskStateToken(get(), taskStateToken)) {
        return;
      }
      const freshStatus =
        get().tasks.find((t) => t.id === taskId)?.status ??
        (get().currentTask?.id === taskId ? get().currentTask?.status : undefined);
      seedPendingRequestCard(taskId, freshStatus as TaskStatus, record, set);
    },

    clearPermissionRequestError: (taskId: string) => {
      set((state) => {
        const { [taskId]: _, ...restErrors } = state.permissionRequestErrors ?? {};
        return { permissionRequestErrors: restErrors };
      });
    },

    respondToPermission: async (response: PermissionResponse) => {
      const accomplish = getAccomplish();
      const taskStateToken = get()._taskStateToken;
      // Save the requestId before the await to detect if a newer request arrived
      const requestId = response.requestId;
      void accomplish.logEvent({
        level: 'info',
        message: 'UI permission response',
        // SEC-1: NEVER log the answer text itself (customText / selected
        // options) — both desktop and gateway log pipelines are retention
        // surfaces. Only sizes and the decision, never content.
        context: {
          requestId: response.requestId,
          taskId: response.taskId,
          decision: response.decision,
          selectedOptionCount: response.selectedOptions?.length ?? 0,
          customTextLength: response.customText?.length ?? 0,
        },
      });
      try {
        await accomplish.respondToPermission(response);
      } catch (err) {
        // M6-A D5: a reply that reached a task with no live pending (daemon
        // restarted, stale requestId, already resumed) is a daemon-side
        // guardrail rejection. The card explains it instead of vanishing or
        // replaying a decision — the record stays parked daemon-side.
        const message = err instanceof Error ? err.message : String(err);
        if (!hasTaskStateToken(get(), taskStateToken)) {
          return;
        }
        set((state) => {
          const existingRequest = state.permissionRequests[response.taskId];
          if (!existingRequest || existingRequest.id !== requestId) {
            return state;
          }
          return {
            permissionRequestErrors: {
              ...(state.permissionRequestErrors ?? {}),
              [response.taskId]: message,
            },
          };
        });
        return;
      }
      if (!hasTaskStateToken(get(), taskStateToken)) {
        return;
      }
      set((state) => {
        const existingRequest = state.permissionRequests[response.taskId];
        // Only clear if the stored request still matches the one we responded to
        if (!existingRequest || existingRequest.id !== requestId) {
          return state;
        }
        const { [response.taskId]: _, ...rest } = state.permissionRequests;
        const { [response.taskId]: __, ...restRestored } = state.restoredRequestIds ?? {};
        const { [response.taskId]: ___, ...restErrors } = state.permissionRequestErrors ?? {};
        return {
          permissionRequests: rest,
          restoredRequestIds: restRestored,
          permissionRequestErrors: restErrors,
        };
      });
    },
  };
}
