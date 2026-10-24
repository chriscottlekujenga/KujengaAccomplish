import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ASSISTANCE_QUESTION_HEADER,
  createPendingRequestRecord,
  type PendingRequestRecord,
  type Task,
} from '../../../src/index.js';

/**
 * Round-trip + single-flight tests for `tasks.pending_request` (M6-A T2/D4/D5).
 *
 * The persisted record must:
 *   - survive saveTask → getTask round-trips and a daemon RESTART (db
 *     close/reopen), because the reply-after-restart auto-resume reads it,
 *   - be preserved by generic saveTask calls that don't carry the field,
 *   - be claimable exactly ONCE via claimPendingRequestForResume (the stored
 *     status is the single-flight lock): stale requestIds, wrong statuses and
 *     permission-kind records are all rejected.
 *
 * Requires the better-sqlite3 native module. Skipped on ABI mismatch.
 */

describe('tasks.pending_request lifecycle (v033, M6-A T2)', () => {
  let testDir: string;
  let dbPath: string;
  let databaseModule: typeof import('../../../src/storage/database.js') | null = null;
  let repoModule: typeof import('../../../src/storage/repositories/taskHistory.js') | null = null;

  function buildAssistanceQuestion(
    requestId: string,
    createdAt = '2026-10-23T00:00:00.000Z',
  ): PendingRequestRecord {
    return createPendingRequestRecord({
      id: requestId,
      taskId: 'irrelevant',
      type: 'question',
      question: 'A CAPTCHA is blocking https://example.com/form',
      header: ASSISTANCE_QUESTION_HEADER,
      options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
      multiSelect: false,
      createdAt,
    });
  }

  function seedTask(taskId: string, overrides: Partial<Task> = {}): void {
    repoModule!.saveTask({
      id: taskId,
      prompt: 'task body',
      status: 'running',
      createdAt: '2026-10-23T00:00:00.000Z',
      messages: [],
      ...overrides,
    });
  }

  beforeAll(async () => {
    if (process.env.SKIP_SQLITE_TESTS) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    try {
      const BetterSqlite3 = await import('better-sqlite3');
      const probe = new (
        BetterSqlite3 as unknown as { default: new (p: string) => { close(): void } }
      ).default(':memory:');
      probe.close();
      databaseModule = await import('../../../src/storage/database.js');
      repoModule = await import('../../../src/storage/repositories/taskHistory.js');
    } catch (_err) {
      console.warn('Skipping: better-sqlite3 native module not available');
    }
  });

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `pending-request-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'test.db');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (databaseModule) databaseModule.resetDatabaseInstance();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function init(): void {
    if (!databaseModule || !repoModule) return;
    databaseModule.initializeDatabase({ databasePath: dbPath });
  }

  it('persists the record on park via updateTaskPendingRequest and reads it back (round-trip)', () => {
    if (!databaseModule || !repoModule) return;
    init();

    seedTask('tsk_park_1', { status: 'waiting_for_user', sessionId: 'ses_1' });
    const record = buildAssistanceQuestion('questionreq_roundtrip');
    repoModule.updateTaskPendingRequest('tsk_park_1', record);

    const loaded = repoModule.getTask('tsk_park_1');
    expect(loaded?.status).toBe('waiting_for_user');
    expect(loaded?.pendingRequest).toEqual(record);
    expect(repoModule.getTaskPendingRequest('tsk_park_1')).toEqual(record);
  });

  it('SURVIVES a db close/reopen (daemon-restart recovery at the storage layer)', () => {
    if (!databaseModule || !repoModule) return;
    init();

    seedTask('tsk_restart_1', {
      status: 'waiting_for_user',
      sessionId: 'ses_restart',
      workingDirectory: '/home/chris/project',
    });
    repoModule.updateTaskPendingRequest(
      'tsk_restart_1',
      buildAssistanceQuestion('questionreq_restart'),
    );

    // Simulate the daemon restart: close the handle, reopen the SAME file.
    databaseModule.resetDatabaseInstance();
    databaseModule.initializeDatabase({ databasePath: dbPath });

    const restored = repoModule.getTask('tsk_restart_1');
    expect(restored?.status).toBe('waiting_for_user');
    expect(restored?.sessionId).toBe('ses_restart');
    expect(restored?.workingDirectory).toBe('/home/chris/project');
    expect(restored?.pendingRequest?.kind).toBe('question');
    expect(restored?.pendingRequest?.requestId).toBe('questionreq_restart');
    expect(restored?.pendingRequest?.question).toBe(
      'A CAPTCHA is blocking https://example.com/form',
    );
  });

  it('generic saveTask (no pendingRequest field) PRESERVES the stored record', () => {
    if (!databaseModule || !repoModule) return;
    init();

    seedTask('tsk_preserve_1', { status: 'waiting_for_user', sessionId: 'ses_2' });
    const record = buildAssistanceQuestion('questionreq_preserve');
    repoModule.updateTaskPendingRequest('tsk_preserve_1', record);

    repoModule.saveTask({
      id: 'tsk_preserve_1',
      prompt: 'same task, generic re-save',
      status: 'waiting_for_user',
      createdAt: '2026-10-23T00:00:00.000Z',
      messages: [],
      sessionId: 'ses_2',
    });

    expect(repoModule.getTaskPendingRequest('tsk_preserve_1')).toEqual(record);
  });

  it('explicit null clears the record; a new record replaces the old one', () => {
    if (!databaseModule || !repoModule) return;
    init();

    seedTask('tsk_replace_1', { status: 'waiting_for_user', sessionId: 'ses_3' });
    repoModule.updateTaskPendingRequest(
      'tsk_replace_1',
      buildAssistanceQuestion('questionreq_old'),
    );
    repoModule.updateTaskPendingRequest(
      'tsk_replace_1',
      buildAssistanceQuestion('questionreq_new'),
    );
    expect(repoModule.getTaskPendingRequest('tsk_replace_1')?.requestId).toBe('questionreq_new');

    repoModule.updateTaskPendingRequest('tsk_replace_1', null);
    expect(repoModule.getTaskPendingRequest('tsk_replace_1')).toBeNull();
  });

  it('skips writes for unknown rows (no parking before the task row exists)', () => {
    if (!databaseModule || !repoModule) return;
    init();

    expect(() =>
      repoModule!.updateTaskPendingRequest(
        'tsk_never_created',
        buildAssistanceQuestion('questionreq_x'),
      ),
    ).not.toThrow();
    expect(repoModule.getTaskPendingRequest('tsk_never_created')).toBeNull();
  });

  it('corrupt pending_request JSON degrades to null instead of failing task reads', () => {
    if (!databaseModule || !repoModule) return;
    init();

    seedTask('tsk_corrupt_1', { status: 'waiting_for_user' });
    const db = databaseModule!.getDatabase();
    db.prepare('UPDATE tasks SET pending_request = ? WHERE id = ?').run(
      'not-json-at-all',
      'tsk_corrupt_1',
    );

    expect(repoModule.getTaskPendingRequest('tsk_corrupt_1')).toBeNull();
    expect(repoModule.getTask('tsk_corrupt_1')?.pendingRequest).toBeUndefined();
  });
});

describe('claimPendingRequestForResume single-flight (M6-A T2/D5)', () => {
  let testDir: string;
  let dbPath: string;
  let databaseModule: typeof import('../../../src/storage/database.js') | null = null;
  let repoModule: typeof import('../../../src/storage/repositories/taskHistory.js') | null = null;

  function buildRecord(requestId: string): PendingRequestRecord {
    return {
      kind: 'question',
      requestId,
      question: 'gate question',
      header: ASSISTANCE_QUESTION_HEADER,
      createdAt: '2026-10-23T00:00:00.000Z',
    };
  }

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
      databaseModule = await import('../../../src/storage/database.js');
      repoModule = await import('../../../src/storage/repositories/taskHistory.js');
    } catch (_err) {
      console.warn('Skipping: better-sqlite3 native module not available');
    }
  });

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `pending-claim-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'test.db');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (databaseModule) databaseModule.resetDatabaseInstance();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function initDb(): void {
    if (!databaseModule || !repoModule) return;
    databaseModule.initializeDatabase({ databasePath: dbPath });
  }

  it('claims a live waiting_for_user question exactly once', () => {
    if (!databaseModule || !repoModule) return;
    initDb();

    repoModule!.saveTask({
      id: 'tsk_claim_1',
      prompt: 'p',
      status: 'waiting_for_user',
      createdAt: '2026-10-23T00:00:00.000Z',
      messages: [],
      sessionId: 'ses_claim',
    });
    repoModule!.updateTaskPendingRequest('tsk_claim_1', buildRecord('questionreq_claim'));

    const claimed = repoModule!.claimPendingRequestForResume('tsk_claim_1', 'questionreq_claim');
    expect(claimed?.requestId).toBe('questionreq_claim');

    const row = repoModule!.getTask('tsk_claim_1');
    expect(row?.status).toBe('resuming');
    expect(row?.pendingRequest).toBeUndefined();

    // SECOND claim (duplicate reply) — nothing left to claim.
    expect(repoModule!.claimPendingRequestForResume('tsk_claim_1', 'questionreq_claim')).toBeNull();
    expect(repoModule!.claimPendingRequestForResume('tsk_claim_2_missing', 'any')).toBeNull();
    expect(repoModule!.getTask('tsk_claim_1')?.status).toBe('resuming');
  });

  it('rejects stale requestIds on a live row without touching it', () => {
    if (!databaseModule || !repoModule) return;
    initDb();

    repoModule!.saveTask({
      id: 'tsk_claim_stale',
      prompt: 'p',
      status: 'waiting_for_user',
      createdAt: '2026-10-23T00:00:00.000Z',
      messages: [],
    });
    repoModule!.updateTaskPendingRequest('tsk_claim_stale', buildRecord('questionreq_real'));

    expect(
      repoModule!.claimPendingRequestForResume('tsk_claim_stale', 'questionreq_stale'),
    ).toBeNull();
    expect(repoModule!.getTask('tsk_claim_stale')?.status).toBe('waiting_for_user');
    expect(repoModule!.getTaskPendingRequest('tsk_claim_stale')?.requestId).toBe(
      'questionreq_real',
    );
  });

  it('rejects wrong-status rows (waiting_permission, failed, completed) — never replayed', () => {
    if (!databaseModule || !repoModule) return;
    initDb();

    for (const [taskId, status] of [
      ['tsk_claim_perm', 'waiting_permission'],
      ['tsk_claim_failed', 'failed'],
      ['tsk_claim_done', 'completed'],
      ['tsk_claim_running', 'running'],
      ['tsk_claim_resuming', 'resuming'],
    ] as const) {
      repoModule!.saveTask({
        id: taskId,
        prompt: 'p',
        status,
        createdAt: '2026-10-23T00:00:00.000Z',
        messages: [],
      });
      repoModule!.updateTaskPendingRequest(taskId, buildRecord('questionreq_perm'));
      expect(repoModule!.claimPendingRequestForResume(taskId, 'questionreq_perm')).toBeNull();
      expect(repoModule!.getTask(taskId)?.status).toBe(status);
    }
  });
});
