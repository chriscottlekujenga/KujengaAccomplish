import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * v033 — Persist the pending permission/question request (M6-A D4).
 *
 * A task parked on a human (`waiting_permission` / `waiting_for_user`)
 * kept its pending question only in adapter memory, so a daemon restart
 * destroyed the card and `permission.respond` answered a dead request.
 * Add a nullable `tasks.pending_request` JSON column; waiting rows keep
 * theirs, terminal/cancelled rows never gain one. Rows written before this
 * migration keep NULL.
 *
 * SQLite has no `ADD COLUMN IF EXISTS`; gate on PRAGMA table_info to stay
 * idempotent — same rationale as v031/v032.
 */
export const migration: Migration = {
  version: 33,
  up: (db: Database) => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'pending_request')) {
      db.exec('ALTER TABLE tasks ADD COLUMN pending_request TEXT DEFAULT NULL');
    }
  },
};
