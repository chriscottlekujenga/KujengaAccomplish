import { describe, it, expect, beforeAll, afterEach } from 'vitest';

/**
 * Migration v033: add nullable tasks.pending_request column (M6-A D4).
 *
 * Persisted pending permission/question requests survive a daemon restart so
 * the UI can restore the question card and the daemon can auto-resume
 * assistance questions on a later reply. Existing rows keep NULL. Skipped
 * gracefully if better-sqlite3 native bindings aren't available.
 */

type BetterSqlite3Module = typeof import('better-sqlite3');
type MigrationModule =
  typeof import('../../../../src/storage/migrations/v033-task-pending-request.js');

/** v032-era `tasks` shape (everything up to and including working_directory). */
const V032_TASKS_TABLE = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    workspace_id TEXT,
    working_directory TEXT
  )
`;

describe('migration v033: add tasks.pending_request column', () => {
  let Database: BetterSqlite3Module | null = null;
  let migrationModule: MigrationModule | null = null;
  let dbInstances: InstanceType<Awaited<BetterSqlite3Module>['default']>[] = [];

  beforeAll(async () => {
    try {
      const BetterSqlite3 = (await import('better-sqlite3')) as BetterSqlite3Module;
      const tmpDb = new BetterSqlite3.default(':memory:');
      tmpDb.close();
      Database = BetterSqlite3;
      migrationModule =
        await import('../../../../src/storage/migrations/v033-task-pending-request.js');
    } catch (err) {
      if (process.env.REQUIRE_SQLITE_TESTS) {
        throw new Error(
          `REQUIRE_SQLITE_TESTS set but better-sqlite3 failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      console.warn('Skipping v033 migration tests: better-sqlite3 native module not available');
    }
  });

  afterEach(() => {
    for (const db of dbInstances) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    dbInstances = [];
  });

  function openDb() {
    if (!Database) {
      throw new Error('better-sqlite3 not available');
    }
    const db = new Database.default(':memory:');
    dbInstances.push(db);
    return db;
  }

  function columnInfo(db: ReturnType<typeof openDb>): Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }> {
    return db.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
  }

  it('declares version 33', () => {
    if (!migrationModule) return;
    expect(migrationModule.migration.version).toBe(33);
  });

  it('adds the nullable pending_request column on a fresh tasks table', () => {
    if (!Database || !migrationModule) return;

    const db = openDb();
    db.exec(V032_TASKS_TABLE);

    migrationModule.migration.up(db);

    const cols = columnInfo(db);
    const pendingRequest = cols.find((c) => c.name === 'pending_request');
    expect(pendingRequest).toBeDefined();
    // Nullable TEXT column — rows with no parked request keep NULL.
    expect(pendingRequest!.notnull).toBe(0);
  });

  it('preserves existing rows and gains the column with NULL for old rows', () => {
    if (!Database || !migrationModule) return;

    const db = openDb();
    db.exec(V032_TASKS_TABLE);
    db.prepare(
      'INSERT INTO tasks (id, prompt, status, created_at, session_id, working_directory) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'tsk_old_1',
      'pre-migration waiting task',
      'waiting_for_user',
      '2026-01-01T00:00:00.000Z',
      'ses_8',
      '/home/chris/project',
    );
    db.prepare('INSERT INTO tasks (id, prompt, status, created_at) VALUES (?, ?, ?, ?)').run(
      'tsk_old_2',
      'pre-migration done task',
      'completed',
      '2026-01-02T00:00:00.000Z',
    );

    migrationModule.migration.up(db);

    const rows = db.prepare('SELECT * FROM tasks ORDER BY id').all() as Array<{
      id: string;
      status: string;
      pending_request: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'tsk_old_1',
      status: 'waiting_for_user',
      pending_request: null,
    });
    expect(rows[1]).toMatchObject({ id: 'tsk_old_2', pending_request: null });
  });

  it('is a no-op when the column already exists (idempotent)', () => {
    if (!Database || !migrationModule) return;

    const db = openDb();
    db.exec(`${V032_TASKS_TABLE}; ALTER TABLE tasks ADD COLUMN pending_request TEXT DEFAULT NULL`);

    expect(() => migrationModule!.migration.up(db)).not.toThrow();

    const cols = columnInfo(db);
    expect(cols.filter((c) => c.name === 'pending_request')).toHaveLength(1);
  });
});
