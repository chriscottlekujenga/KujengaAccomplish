import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration: Migration = {
  version: 25,
  up: (db: Database) => {
    // Multi-model project mode: persist the cloud model assigned to each
    // subtask todo so the task panel can display it.
    db.exec('ALTER TABLE task_todos ADD COLUMN model TEXT');
  },
};