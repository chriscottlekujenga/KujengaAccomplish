/**
 * Regression tests for the M4 crash-recovery sweep (docs/PHASE_3_M4_PLAN.md
 * §A5): on daemon boot only stale `running` tasks are marked `failed`.
 * Tasks parked on a human (`waiting_permission` / `waiting_for_user`) and
 * the transient `resuming` status survive a restart — they keep their
 * resumable sessionId and are recovered via session.resume, so the sweep
 * must leave them (and all terminal statuses) byte-identical.
 *
 * Seeds a REAL StorageService (agent-core createStorage + migrations on a
 * temp-dir SQLite file). Follows the agent-core storage-test convention:
 * probe better-sqlite3 first and skip the suite when the native module is
 * unavailable (SKIP_SQLITE_TESTS or ABI mismatch).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createStorage,
  type StorageAPI,
  type StoredTask,
  type TaskStatus,
} from '@accomplish_ai/agent-core';
import { recoverStaleTasks } from '../../src/crash-recovery.js';

const FIXED_CREATED_AT = '2026-10-23T00:00:00.000Z';

describe('recoverStaleTasks — boot crash sweep marks ONLY stale running tasks failed', () => {
  let testDir: string;
  let dbPath: string;
  let storage: StorageAPI | null = null;
  let sqliteAvailable = false;

  beforeAll(async () => {
    if (process.env.SKIP_SQLITE_TESTS) {
      return;
    }
    try {
      const BetterSqlite3 = await import('better-sqlite3');
      const probe = new (
        BetterSqlite3 as unknown as { default: new (p: string) => { close(): void } }
      ).default(':memory:');
      probe.close();
      sqliteAvailable = true;
    } catch (_err) {
      sqliteAvailable = false;
    }
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    testDir = path.join(
      os.tmpdir(),
      `crash-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    if (storage) {
      storage.close();
      storage = null;
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function initializeStorage(): StorageAPI {
    const store = createStorage({
      databasePath: dbPath,
      runMigrations: true,
      userDataPath: path.join(testDir, 'secure'),
    });
    store.initialize();
    storage = store;
    return store;
  }

  function seedTask(
    store: StorageAPI,
    id: string,
    status: TaskStatus,
    extra?: Partial<StoredTask>,
  ): void {
    store.saveTask({ id, prompt: id, status, createdAt: FIXED_CREATED_AT, messages: [], ...extra });
  }

  it('running → failed; waiting/terminal statuses are byte-identical (no new timestamps)', () => {
    if (!sqliteAvailable) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    const store = initializeStorage();

    const cases: Array<{ id: string; status: TaskStatus }> = [
      { id: 'tsk_orphan_running', status: 'running' },
      { id: 'tsk_wait_permission', status: 'waiting_permission' },
      { id: 'tsk_wait_user', status: 'waiting_for_user' },
      { id: 'tsk_resuming', status: 'resuming' },
      { id: 'tsk_completed', status: 'completed' },
      { id: 'tsk_failed', status: 'failed' },
      { id: 'tsk_cancelled', status: 'cancelled' },
      { id: 'tsk_interrupted', status: 'interrupted' },
      { id: 'tsk_queued', status: 'queued' },
      { id: 'tsk_pending', status: 'pending' },
    ];
    // Give the completed task a pre-existing terminal timestamp so we can
    // prove the sweep does not touch surviving rows at all.
    for (const { id, status } of cases) {
      seedTask(store, id, status, status === 'completed' ? { completedAt: FIXED_CREATED_AT } : {});
    }

    const before = new Map<string, string>(store.getTasks().map((t) => [t.id, JSON.stringify(t)]));

    recoverStaleTasks(store);

    const afterRows = store.getTasks();
    const staleRunning = afterRows.find((t) => t.id === 'tsk_orphan_running');
    expect(staleRunning?.status).toBe('failed');
    // The flip carries a fresh completion timestamp (extracted behavior:
    // updateTaskStatus called with `new Date().toISOString()`).
    expect(staleRunning?.completedAt).toBeTruthy();
    expect(staleRunning?.completedAt).not.toBe(FIXED_CREATED_AT);

    for (const { id } of cases.slice(1)) {
      const row = afterRows.find((t) => t.id === id);
      expect(row).toBeDefined();
      // Byte-identical: status unchanged AND no new timestamps.
      expect(JSON.stringify(row)).toBe(before.get(id));
    }
  });

  it('leaves a running task with a preserved resumable shape only when NOT running', () => {
    if (!sqliteAvailable) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    const store = initializeStorage();
    // A waiting task that survived the crash: sessionId + cwd intact.
    seedTask(store, 'tsk_survivor', 'waiting_permission', {
      sessionId: 'sess_survive_1',
      workingDirectory: '/home/chris/project',
    });

    recoverStaleTasks(store);

    const survivor = store.getTask('tsk_survivor');
    expect(survivor?.status).toBe('waiting_permission');
    expect(survivor?.sessionId).toBe('sess_survive_1');
    expect(survivor?.workingDirectory).toBe('/home/chris/project');
    expect(survivor?.completedAt).toBeUndefined();
  });

  // M6-A T2 (D4): a crash-to-failed flip is terminal — the stale running
  // task's persisted pending request is cleared with it, so no later reply
  // can resurrect a dead ask. Waiting rows KEEP their pending record (those
  // hold resumable assistance questions).
  it('clears the persisted pending request on the running→failed flip; waiting rows keep theirs', () => {
    if (!sqliteAvailable) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    const store = initializeStorage();
    const pendingRecord = {
      kind: 'question',
      requestId: 'questionreq_crash',
      question: 'gate question',
      createdAt: FIXED_CREATED_AT,
    } as const;

    seedTask(store, 'tsk_crash_run', 'running', { sessionId: 'sess_run' });
    seedTask(store, 'tsk_crash_waiting', 'waiting_for_user', {
      sessionId: 'sess_wait',
      workingDirectory: '/home/chris/project',
    });
    store.updateTaskPendingRequest('tsk_crash_run', pendingRecord);
    store.updateTaskPendingRequest('tsk_crash_waiting', pendingRecord);

    recoverStaleTasks(store);

    expect(store.getTask('tsk_crash_run')?.status).toBe('failed');
    expect(store.getTaskPendingRequest('tsk_crash_run')).toBeNull();
    expect(store.getTask('tsk_crash_waiting')?.status).toBe('waiting_for_user');
    expect(store.getTaskPendingRequest('tsk_crash_waiting')).toEqual(pendingRecord);
  });
});
