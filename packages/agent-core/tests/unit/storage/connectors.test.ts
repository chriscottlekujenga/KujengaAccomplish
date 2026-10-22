/** @vitest-environment node */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { McpConnector } from '../../../src/common/types/connector.js';

/**
 * Regression for the live-RPC verification defect: `connectors.upsert` with a
 * timestampless connector payload hit the raw SQLite
 * `NOT NULL constraint failed: connectors.created_at` error. The upsert
 * contract tolerates omitted timestamps — the repository must default them
 * server-side. Insert defaults BOTH columns; the ON CONFLICT update path must
 * keep preserving the original created_at.
 */
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makeConnector(overrides: Partial<McpConnector> = {}): McpConnector {
  // Cast is deliberate: omitting createdAt/updatedAt is the exact payload
  // shape this regression pins (typed callers always supply them today).
  return {
    id: 'mcp-verif-zz',
    name: 'verif-connector',
    url: 'http://127.0.0.1:9999/mcp',
    status: 'disconnected',
    isEnabled: true,
    ...overrides,
  } as McpConnector;
}

describe('Connectors repository upsert timestamp tolerance', () => {
  let testDir: string;
  let dbPath: string;
  let databaseModule: typeof import('../../../src/storage/database.js') | null = null;
  let connectorsModule: typeof import('../../../src/storage/repositories/connectors.js') | null =
    null;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    if (process.env.SKIP_SQLITE_TESTS) {
      console.warn('Skipping connectors tests: better-sqlite3 native module not available');
      return;
    }
    try {
      // Probe instantiation — import alone succeeds even on ABI mismatch;
      // the error only surfaces when new Database() is called.
      const BetterSqlite3 = await import('better-sqlite3');
      const probe = new (
        BetterSqlite3 as unknown as { default: new (p: string) => { close(): void } }
      ).default(':memory:');
      probe.close();
      databaseModule = await import('../../../src/storage/database.js');
      connectorsModule = await import('../../../src/storage/repositories/connectors.js');
    } catch (_err) {
      console.warn('Skipping connectors tests: better-sqlite3 native module not available');
      console.warn('To fix: pnpm install --force');
    }
  });

  afterAll(() => {
    consoleLogSpy.mockRestore();
  });

  beforeEach(() => {
    if (!databaseModule || !connectorsModule) {
      return;
    }
    testDir = path.join(
      os.tmpdir(),
      `connector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'test.db');
    databaseModule.initializeDatabase({ databasePath: dbPath });
  });

  afterEach(() => {
    if (databaseModule) {
      databaseModule.resetDatabaseInstance();
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('upsert without createdAt/updatedAt defaults both server-side and persists the row', () => {
    if (!connectorsModule) {
      return;
    }

    connectorsModule.upsertConnector(makeConnector());

    const rows = connectorsModule.getAllConnectors();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe('mcp-verif-zz');
    expect(row.name).toBe('verif-connector');
    expect(row.url).toBe('http://127.0.0.1:9999/mcp');
    expect(row.status).toBe('disconnected');
    expect(row.isEnabled).toBe(true);
    expect(row.createdAt).toEqual(expect.stringMatching(ISO_SHAPE));
    expect(row.updatedAt).toEqual(expect.stringMatching(ISO_SHAPE));
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(row.updatedAt))).toBe(false);
  });

  it('update path preserves the original created_at from the first insert', () => {
    if (!connectorsModule) {
      return;
    }

    connectorsModule.upsertConnector(makeConnector());
    const original = connectorsModule.getAllConnectors()[0];

    // Existing callers always supply timestamps — this payload carries fresh
    // client-side values that must NOT clobber the original created_at.
    connectorsModule.upsertConnector(
      makeConnector({
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2030-06-15T12:00:00.000Z',
      }),
    );

    const rows = connectorsModule.getAllConnectors();
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe(original.createdAt);
    expect(rows[0].updatedAt).toBe('2030-06-15T12:00:00.000Z');
    expect(rows[0].name).toBe('verif-connector');
    expect(rows[0].url).toBe('http://127.0.0.1:9999/mcp');
    expect(rows[0].status).toBe('disconnected');
    expect(rows[0].isEnabled).toBe(true);
  });

  it('a payload supplying only updatedAt still defaults created_at (and vice versa)', () => {
    if (!connectorsModule) {
      return;
    }

    connectorsModule.upsertConnector(makeConnector({ updatedAt: '2030-01-01T00:00:00.000Z' }));

    const rows = connectorsModule.getAllConnectors();
    expect(rows).toHaveLength(1);
    expect(rows[0].updatedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(rows[0].createdAt).toEqual(expect.stringMatching(ISO_SHAPE));
  });
});
