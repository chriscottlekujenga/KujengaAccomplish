import type { PermissionRequest, PermissionResponse, Task } from '@accomplish_ai/agent-core/common';
import { getAccomplish } from '../lib/accomplish';
import {
  isWaitingForHumanStatus,
  pendingRequestToPermissionRequest,
} from '../lib/assistance-requests';
import type { TaskState } from './taskStore';
import { hasTaskStateToken } from './task-state-helpers';

type SetFn = (partial: Partial<TaskState> | ((state: TaskState) => Partial<TaskState>)) => void;
type GetFn = () => TaskState;

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
      const record = task.pendingRequest;
      if (!record || !isWaitingForHumanStatus(task.status)) {
        return;
      }
      const restored = pendingRequestToPermissionRequest(record, task.id);
      if (!restored) {
        return;
      }
      set((state) => {
        if (state.permissionRequests[task.id]) {
          return state;
        }
        const { [task.id]: _, ...restErrors } = state.permissionRequestErrors ?? {};
        return {
          permissionRequests: { ...state.permissionRequests, [task.id]: restored },
          restoredRequestIds: { ...(state.restoredRequestIds ?? {}), [task.id]: true },
          permissionRequestErrors: restErrors,
        };
      });
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
        context: { ...response },
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
