/**
 * Unit tests for the `connectors.upsert` RPC route timestamp-tolerance fix
 * (Phase 3 M2 live-RPC verification regression).
 *
 * Live verification through the real gateway reproduced a raw SQLite
 * `NOT NULL constraint failed: connectors.created_at` when an authorized
 * socket client sent a connector-shaped payload without createdAt/updatedAt.
 * The daemon owns the data store, so the tolerance belongs at the storage
 * choke point (agent-core repository) — NOT client-side (the desktop
 * `connectors:add` handler and the web shim both already build timestamps,
 * but any other authorized client must not corrupt the daemon).
 *
 * These tests drive `registerRpcMethods` with a REAL `ConnectorService` over
 * a REAL agent-core SQLite database in a per-test tmp dir, so the exact
 * live-verification payload runs through route → ConnectorService →
 * StorageAPI.upsertConnector → SQL. If the repository's server-side
 * timestamp defaulting regresses, the constraint error throws here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerRpcMethods, type RouteServices } from '../../src/daemon-routes.js';
import { ConnectorService } from '../../src/connector-service.js';
import { createStorage, type StorageAPI } from '@accomplish_ai/agent-core';
import type { SecretsService } from '../../src/secrets-service.js';
import type { SettingsService } from '../../src/settings-service.js';

type RpcHandler = (params: unknown, clientId?: string) => Promise<unknown>;

/**
 * EXACT payload from the live-RPC verification run (T0..T5 follow-up):
 * `connectors.upsert {"connector":{"id":"mcp-verif-zz","name":"verif-connector",
 * "url":"http://127.0.0.1:9999/mcp","status":"disconnected","isEnabled":true}}`
 * — no createdAt/updatedAt.
 */
const TIMESTAMPLESS_PARAMS = {
  connector: {
    id: 'mcp-verif-zz',
    name: 'verif-connector',
    url: 'http://127.0.0.1:9999/mcp',
    status: 'disconnected',
    isEnabled: true,
  },
};

const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let sqliteAvailable = true;
try {
  const BetterSqlite3 = (await import('better-sqlite3')).default as unknown as {
    new (p: string): { close(): void };
  };
  new BetterSqlite3(':memory:').close();
} catch {
  sqliteAvailable = false;
}

describe('connectors.upsert RPC route (M2 timestamp-tolerance regression)', () => {
  let registered: Map<string, RpcHandler>;
  let storage: StorageAPI;
  let testDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleLogSpy.mockRestore();
  });

  beforeEach(() => {
    if (!sqliteAvailable) {
      return;
    }
    testDir = path.join(
      os.tmpdir(),
      `daemon-connector-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    storage = createStorage({
      databasePath: path.join(testDir, 'accomplish-test.db'),
      runMigrations: true,
      userDataPath: testDir,
      secureStorageFileName: 'secure-storage-test.json',
    });
    storage.initialize();

    const registeredMap = new Map<string, RpcHandler>();
    const services = {
      rpc: {
        registerMethod: vi.fn((method: string, handler: RpcHandler) => {
          registeredMap.set(method, handler);
        }),
        notify: vi.fn(),
        setClientType: vi.fn(),
        setUiPresence: vi.fn(),
      },
      taskService: {},
      healthService: {},
      storageService: { getStorage: () => storage },
      schedulerService: {},
      accomplishRuntime: { onUsageUpdate: vi.fn() },
      whatsappService: {},
      openAiOauthManager: {},
      secretsService: {} as unknown as SecretsService,
      settingsService: { on: vi.fn() } as unknown as SettingsService,
      workspaceService: { on: vi.fn() },
      connectorService: new ConnectorService(storage),
      legacyImportService: {},
      googleAccountService: { on: vi.fn() },
      skillsService: { on: vi.fn() },
      devBrowserService: {},
    } as unknown as RouteServices;
    registerRpcMethods(services);
    registered = registeredMap;
  });

  afterEach(() => {
    if (!sqliteAvailable) {
      return;
    }
    storage.close();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('registers connectors.upsert and connectors.list', () => {
    if (!sqliteAvailable) {
      return;
    }
    expect(registered.has('connectors.upsert')).toBe(true);
    expect(registered.has('connectors.list')).toBe(true);
  });

  it('accepts the exact live-verification timestampless payload without a NOT NULL error', async () => {
    if (!sqliteAvailable) {
      return;
    }
    const handler = registered.get('connectors.upsert');
    expect(handler).toBeDefined();
    // Pre-fix this rejected with: NOT NULL constraint failed: connectors.created_at
    await expect(handler?.(TIMESTAMPLESS_PARAMS)).resolves.toBeUndefined();
  });

  it('connectors.list sees the row with server-defaulted ISO timestamps', async () => {
    if (!sqliteAvailable) {
      return;
    }
    await registered.get('connectors.upsert')?.(TIMESTAMPLESS_PARAMS);

    const listHandler = registered.get('connectors.list');
    const rows = (await listHandler?.(undefined)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'mcp-verif-zz',
      name: 'verif-connector',
      url: 'http://127.0.0.1:9999/mcp',
      status: 'disconnected',
      isEnabled: true,
    });
    expect(rows[0].createdAt).toEqual(expect.stringMatching(ISO_SHAPE));
    expect(rows[0].updatedAt).toEqual(expect.stringMatching(ISO_SHAPE));
  });

  it('a timestampless re-upsert takes the update path and keeps a single row', async () => {
    if (!sqliteAvailable) {
      return;
    }
    const upsertHandler = registered.get('connectors.upsert');
    await upsertHandler?.(TIMESTAMPLESS_PARAMS);
    const first = (await registered.get('connectors.list')?.(undefined)) as Array<{
      createdAt: string;
    }>;

    await upsertHandler?.(TIMESTAMPLESS_PARAMS);
    const rows = (await registered.get('connectors.list')?.(undefined)) as Array<{
      createdAt: string;
      updatedAt: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toBe(first[0].createdAt);
    expect(rows[0].updatedAt).toEqual(expect.stringMatching(ISO_SHAPE));
  });
});
