/**
 * Event type declarations for TaskService.
 * Extracted from task-service.ts to keep files under 200 lines.
 */
import type { TaskMessage, TaskStatus, AccomplishRuntime } from '@accomplish_ai/agent-core';

export interface TaskServiceEvents {
  progress: [data: { taskId: string; stage: string; message?: string }];
  message: [data: { taskId: string; messages: TaskMessage[] }];
  complete: [data: { taskId: string }];
  error: [data: { taskId: string; error: string }];
  permission: [data: unknown];
  statusChange: [data: { taskId: string; status: TaskStatus }];
  summary: [data: { taskId: string; summary: string }];
}

export interface TaskServiceOptions {
  userDataPath: string;
  mcpToolsPath: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  accomplishRuntime?: AccomplishRuntime;
  /**
   * Optional interactive-presence probe used by the no-UI auto-deny policy in
   * `task-callbacks.ts`. Renamed in Phase 3 M1 from `rpcConnectivityProbe` —
   * the daemon now supplies `rpc.hasInteractiveClients()` (legacy socket
   * clients OR gateway-reported fresh browser-UI counts), never the raw
   * connected-socket count. When omitted (tests, tooling), the task
   * callbacks treat the UI as always connected, so auto-deny only triggers
   * via explicit bridges like WhatsApp.
   */
  interactivePresenceProbe?: { hasInteractiveClients(): boolean };
  /**
   * Optional proxy tagger. Wired by the daemon when an optional runtime
   * module is available at startup. The adapter calls it on task start
   * (with taskId) and teardown (with undefined). Undefined in pure OSS
   * builds — no-op.
   */
  setProxyTaskId?: (taskId: string | undefined) => void;
}
