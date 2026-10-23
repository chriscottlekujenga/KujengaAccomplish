import { describe, it, expect, beforeAll, afterEach } from 'vitest';

/**
 * Migration v032: add nullable tasks.working_directory column.
 *
 * Preserves the original task's cwd across resume turns. Existing rows keep
 * NULL. Skipped gracefully if better-sqlite3 native bindings aren't available.
 */

type BetterSqlite3Module = typeof import('better-sqlite3');
type MigrationModule =
  typeof import('../../../../src/storage/migrations/v032-task-working-directory.js');

/** v031-era `tasks` shape (everything up to and including workspace_id). */
const V031_TASKS_TABLE = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    workspace_id TEXT
  )
`;

describe('migration v032: add tasks.working_directory column', () => {
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
        await import('../../../../src/storage/migrations/v032-task-working-directory.js');
    } catch (err) {
      if (process.env.REQUIRE_SQLITE_TESTS) {
        throw new Error(
          `REQUIRE_SQLITE_TESTS set but better-sqlite3 failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      console.warn('Skipping v032 migration tests: better-sqlite3 native module not available');
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

  it('declares version 32', () => {
    if (!migrationModule) return;
    expect(migrationModule.migration.version).toBe(32);
  });

  it('adds the working_directory column on a fresh tasks table', () => {
    if (!Database || !migrationModule) return;

    const db = openDb();
    db.exec(V031_TASKS_TABLE);

    migrationModule.migration.up(db);

    const cols = columnInfo(db);
    const workingDirectory = cols.find((c) => c.name === 'working_directory');
    expect(workingDirectory).toBeDefined();
    // Nullable TEXT column — resumed tasks must tolerate no recorded cwd.
    expect(workingDirectory!.notnull).toBe(0);
  });

  it('preserves existing rows and gains the column with NULL for old rows', () => {
    if (!Database || !migrationModule) return;

    const db = openDb();
    db.exec(V031_TASKS_TABLE);
    db.prepare(
      'INSERT INTO tasks (id, prompt, status, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)',
    ).run('tsk_old_1', 'pre-migration task', 'completed', '2026-01-01T00:00:00.000Z', 'ws_1');
    db.prepare(
      'INSERT INTO tasks (id, prompt, status, created_at, session_id) VALUES (?, ?, ?, ?, ?)',
    ).run('tsk_old_2', 'second pre-migration task', 'failed', '2026-01-02T00:00:00.000Z', 'ses_9');

    migrationModule.migration.up(db);

    const rows = db.prepare('SELECT * FROM tasks ORDER BY id').all() as Array<{
      id: string;
      prompt: string;
      status: string;
      workspace_id: string | null;
      session_id: string | null;
      working_directory: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('tsk_old_1');
    expect(rows[0].prompt).toBe('pre-migration task');
    expect(rows[0].status).toBe('completed');
    expect(rows[0].workspace_id).toBe('ws_1');
    expect(rows[0].working_directory).toBeNull();
    expect(rows[1]).toMatchObject({
      id: 'tsk_old_2',
      session_id: 'ses_9',
      working_directory: null,
    });
  });

  it('is a no-op when the column already exists (idempotent)', () => {
    if (!Database || !migrationModule) return;

    const db = openDb();
    db.exec(
      `${V031_TASKS_TABLE}; ALTER TABLE tasks ADD COLUMN working_directory TEXT DEFAULT NULL`,
    );

    expect(() => migrationModule!.migration.up(db)).not.toThrow();

    // Exactly one working_directory column — the guarded path must not
    // re-add (a second ADD COLUMN would throw "duplicate column name").
    const cols = columnInfo(db);
    expect(cols.filter((c) => c.name === 'working_directory')).toHaveLength(1);
  });
});
