import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Repairs databases created by builds where the Hugging Face migration was
 * recorded without adding its provider-settings column.
 */
export const migration: Migration = {
  version: 26,
  up: (db: Database) => {
    const columns = db.prepare('PRAGMA table_info(app_settings)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'huggingface_local_config')) {
      db.exec('ALTER TABLE app_settings ADD COLUMN huggingface_local_config TEXT');
    }
  },
};
