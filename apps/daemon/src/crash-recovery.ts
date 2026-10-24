/**
 * Boot-time crash-recovery sweep. Extracted verbatim from daemon `main()`
 * (Phase 3 M4 A5) so the semantics have their own regression tests.
 */
import type { TaskStorageAPI } from '@accomplish_ai/agent-core';
import { log } from './logger.js';

/**
 * Marks tasks that were mid-turn (`running`) when the previous process died
 * as `failed`.
 *
 * Deliberate semantics — WHY waiting tasks survive: a task parked in
 * `waiting_permission` / `waiting_for_user` / `resuming` was blocked on a
 * HUMAN, not on the process. Its persisted sessionId + working directory
 * make it fully resumable via `session.resume`, so treating it as a stale
 * orphan (or overwriting it with a terminal status) would destroy a
 * perfectly recoverable turn. Terminal statuses need no recovery.
 */
export function recoverStaleTasks(storage: TaskStorageAPI): void {
  for (const task of storage.getTasks()) {
    if (task.status === 'running') {
      log.warn(`[Daemon] Crash recovery: marking stale task ${task.id} as failed`);
      storage.updateTaskStatus(task.id, 'failed', new Date().toISOString());
      // M6-A T2 (D4): the flip is terminal — clear any persisted pending
      // request with it. Waiting rows are deliberately untouched (they keep
      // both their status AND their pending record so the restart restore
      // stays byte-identical), and only those are ever resumed.
      storage.updateTaskPendingRequest(task.id, null);
    }
  }
}
