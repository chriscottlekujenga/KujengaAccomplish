import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Round-trip persistence test for `Task.workingDirectory` introduced by
 * migration v032 (`tasks.working_directory`).
 *
 * A resumed session must be able to recover the original task's working
 * directory, so the value has to survive saveTask → getTask and — critically
 * for resume turns — a re-save of the loaded record.
 *
 * Requires the better-sqlite3 native module. Skipped on ABI mismatch.
 */

describe('Task.workingDirectory round-trip (v032)', () => {
  let testDir: string;
  let dbPath: string;
  let databaseModule: typeof import('../../../src/storage/database.js') | null = null;
  let repoModule: typeof import('../../../src/storage/repositories/taskHistory.js') | null = null;

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
      `task-workdir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it('returns the saved workingDirectory via getTask', () => {
    if (!databaseModule || !repoModule) return;
    databaseModule.initializeDatabase({ databasePath: dbPath });

    repoModule.saveTask({
      id: 'task-workdir-1',
      prompt: 'do the thing',
      status: 'running',
      createdAt: new Date().toISOString(),
      messages: [],
      workingDirectory: '/home/dev/projects/alpha',
    });

    const loaded = repoModule.getTask('task-workdir-1');
    expect(loaded).toBeDefined();
    expect(loaded!.workingDirectory).toBe('/home/dev/projects/alpha');
  });

  it('leaves workingDirectory undefined when not provided', () => {
    if (!databaseModule || !repoModule) return;
    databaseModule.initializeDatabase({ databasePath: dbPath });

    repoModule.saveTask({
      id: 'task-workdir-none',
      prompt: 'no cwd given',
      status: 'completed',
      createdAt: new Date().toISOString(),
      messages: [],
    });

    const loaded = repoModule.getTask('task-workdir-none');
    expect(loaded).toBeDefined();
    expect(loaded!.workingDirectory).toBeUndefined();
  });

  it('persists via updateTaskWorkingDirectory', () => {
    if (!databaseModule || !repoModule) return;
    databaseModule.initializeDatabase({ databasePath: dbPath });

    repoModule.saveTask({
      id: 'task-workdir-2',
      prompt: 'late cwd',
      status: 'running',
      createdAt: new Date().toISOString(),
      messages: [],
    });

    repoModule.updateTaskWorkingDirectory('task-workdir-2', '/home/dev/projects/beta');

    const loaded = repoModule.getTask('task-workdir-2');
    expect(loaded!.workingDirectory).toBe('/home/dev/projects/beta');
  });

  it('preserves workingDirectory when the loaded task is re-saved (resume turn)', () => {
    if (!databaseModule || !repoModule) return;
    databaseModule.initializeDatabase({ databasePath: dbPath });

    repoModule.saveTask({
      id: 'task-workdir-3',
      prompt: 'resumable',
      status: 'completed',
      createdAt: new Date().toISOString(),
      messages: [],
      workingDirectory: '/home/dev/projects/gamma',
    });

    const loaded = repoModule.getTask('task-workdir-3');
    expect(loaded).toBeDefined();

    // Resume-turn scenario: TaskService loads the StoredTask and re-saves it
    // (message batch / status transitions go through saveTask). The
    // working directory must survive that round-trip or the resumed session
    // loses the original cwd.
    repoModule.saveTask(loaded!);

    const reloaded = repoModule.getTask('task-workdir-3');
    expect(reloaded!.workingDirectory).toBe('/home/dev/projects/gamma');
  });
});
