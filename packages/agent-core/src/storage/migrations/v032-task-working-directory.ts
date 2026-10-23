import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * v032 — Persist the task working directory.
 *
 * `TaskConfig.workingDirectory` was accepted at task start but never stored,
 * so a resumed session could not recover the original task's cwd. Add a
 * nullable `tasks.working_directory` column; rows written before this
 * migration keep NULL (no recorded cwd).
 *
 * SQLite has no `ADD COLUMN IF EXISTS`; gate on PRAGMA table_info to stay
 * idempotent — handles schemas where the column already exists (e.g. a DB
 * restored from elsewhere, or a repeated run). Same rationale as v031.
 */
export const migration: Migration = {
  version: 32,
  up: (db: Database) => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'working_directory')) {
      db.exec('ALTER TABLE tasks ADD COLUMN working_directory TEXT DEFAULT NULL');
    }
  },
};
