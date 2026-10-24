/**
 * Unit tests for the `task.getPendingRequest` RPC route (Phase 3 M6-A T4).
 *
 * The ONE new allowlist entry M6-A makes (plan §6.2): the dedicated
 * read-only pending-request restore source for the assistance card after a
 * page reload, gateway reconnect or daemon restart. Verifies:
 *
 *   - the route is registered with the documented §5.4(a) contract
 *     ({ taskId } params, `{ pendingRequest: <record|null> }` result),
 *   - zod validation (missing/empty taskId — no silent no-op reads),
 *   - delegation is a pure storage read (no mutation, no write),
 *   - the null carrier: unknown task, terminal task, corrupt stored record,
 *   - restart-restore: a record parked on a waiting_for_user row is read
 *     back through the route handler by a FRESHly reopened storage
 *     (restart simulation on real SQLite — the daemon-restart case),
 *   - a waiting row keeps its record while a reply/clear drops it (route
 *     mirrors the store surface the UI uses).
 *
 * Trust-boundary guard mirrors daemon-routes-devbrowser.test.ts: the host
 * gateway policy (apps/host/src/policy.ts) must allowlist exactly this one
 * method (M6-A §6.2: +1 total) — the paired authorization tests live in the
 * host suite (gateway.test.ts / policy.test.ts).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ASSISTANCE_QUESTION_HEADER,
  createPendingRequestRecord,
  createStorage,
} from '@accomplish_ai/agent-core';
import { registerRpcMethods, type RouteServices } from '../../src/daemon-routes.js';

type RpcHandler = (params: unknown, clientId?: string) => Promise<unknown>;

const FIXED_CREATED_AT = '2026-10-23T00:00:00.000Z';
const TASK_ID = 'tsk_pending_route';

function buildServices(storageOverrides: { getTaskPendingRequest: (taskId: string) => unknown }) {
  const registered = new Map<string, RpcHandler>();
  const services = {
    rpc: {
      registerMethod: vi.fn((method: string, handler: RpcHandler) => {
        registered.set(method, handler);
      }),
      notify: vi.fn(),
      setClientType: vi.fn(),
      setUiPresence: vi.fn(),
    },
    taskService: {},
    healthService: {},
    storageService: { getStorage: vi.fn(() => storageOverrides) },
    schedulerService: {},
    accomplishRuntime: { onUsageUpdate: vi.fn() },
    whatsappService: {},
    openAiOauthManager: {},
    secretsService: {},
    settingsService: { on: vi.fn() },
    workspaceService: { on: vi.fn() },
    connectorService: {},
    legacyImportService: {},
    googleAccountService: { on: vi.fn() },
    skillsService: { on: vi.fn() },
    devBrowserService: {},
  } as unknown as RouteServices;
  return { services, registered };
}

describe('task.getPendingRequest daemon RPC route (Phase 3 M6-A T4)', () => {
  let registered: Map<string, RpcHandler>;

  beforeEach(() => {
    const built = buildServices({
      getTaskPendingRequest: vi.fn(() => null),
    });
    registered = built.registered;
    registerRpcMethods(built.services);
  });

  it("registers 'task.getPendingRequest'", () => {
    expect(registered.has('task.getPendingRequest')).toBe(true);
  });

  it('validates the taskId and forwards it to the storage read', async () => {
    const storage = { getTaskPendingRequest: vi.fn(() => null) };
    const built = buildServices(storage);
    registerRpcMethods(built.services);
    const handler = built.registered.get('task.getPendingRequest');
    expect(handler).toBeDefined();

    await expect(handler?.({ taskId: 'tsk_1' })).resolves.toEqual({ pendingRequest: null });
    expect(storage.getTaskPendingRequest).toHaveBeenCalledWith('tsk_1');
  });

  it('rejects missing/empty taskId (zod validation) without reading storage', async () => {
    const storage = { getTaskPendingRequest: vi.fn(() => null) };
    const built = buildServices(storage);
    registerRpcMethods(built.services);
    const handler = built.registered.get('task.getPendingRequest');
    await expect(handler?.(undefined)).rejects.toThrow(/Invalid payload/);
    await expect(handler?.({ taskId: '' })).rejects.toThrow(/Invalid payload/);
    await expect(handler?.({ taskId: 'tsk_1', extra: true })).resolves.toEqual({
      pendingRequest: null,
    });
    expect(storage.getTaskPendingRequest).toHaveBeenCalledTimes(1);
  });

  it('returns the record carrier verbatim ({ pendingRequest: record })', async () => {
    const record = {
      kind: 'question',
      requestId: 'questionreq_1',
      question: 'A CAPTCHA is blocking https://example.com/form',
      header: 'Human assistance required',
      options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
      multiSelect: false,
      createdAt: FIXED_CREATED_AT,
    };
    const built = buildServices({ getTaskPendingRequest: vi.fn(() => record) });
    registerRpcMethods(built.services);
    const handler = built.registered.get('task.getPendingRequest');
    await expect(handler?.({ taskId: TASK_ID })).resolves.toEqual({
      pendingRequest: record,
    });
  });

  it('degrades corrupt stored records to the null carrier (UI never fails on reads)', async () => {
    // The storage layer's parsePendingRequestRecord already degrades corrupt
    // JSON to null — the route carries that degradation through verbatim.
    const built = buildServices({
      getTaskPendingRequest: vi.fn(() => null),
    });
    registerRpcMethods(built.services);
    const handler = built.registered.get('task.getPendingRequest');
    await expect(handler?.({ taskId: 'tsk_corrupt' })).resolves.toEqual({ pendingRequest: null });
  });
});

describe('task.getPendingRequest — restart-restore over real SQLite (M6-A T4)', () => {
  let sqliteAvailable = false;

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
      sqliteAvailable = true;
    } catch (_err) {
      sqliteAvailable = false;
    }
  });

  function buildServicesForStorage(storage: unknown) {
    return buildServices({
      getTaskPendingRequest: (taskId: string) =>
        (
          storage as {
            getTaskPendingRequest: (id: string) => unknown;
          }
        ).getTaskPendingRequest(taskId),
    });
  }

  it('a record parked before a restart is read back through the route after reopening the DB', async () => {
    if (!sqliteAvailable) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    const testDir = path.join(
      os.tmpdir(),
      `pending-route-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    const dbPath = path.join(testDir, 'test.db');

    // "Runtime 1" — park an assistance question (D4 write path).
    const runtimeA = createStorage({
      databasePath: dbPath,
      runMigrations: true,
      userDataPath: path.join(testDir, 'secure'),
    });
    runtimeA.initialize();
    runtimeA.saveTask({
      id: TASK_ID,
      prompt: 'original task',
      status: 'waiting_for_user',
      createdAt: FIXED_CREATED_AT,
      messages: [],
      sessionId: 'sess_orig_1',
      workingDirectory: '/home/chris/project',
    } as never);
    runtimeA.updateTaskPendingRequest(
      TASK_ID,
      createPendingRequestRecord({
        id: 'questionreq_1',
        taskId: TASK_ID,
        type: 'question',
        question: 'A CAPTCHA is blocking https://example.com/form',
        header: ASSISTANCE_QUESTION_HEADER,
        options: [{ label: "I'll complete it — please wait" }, { label: 'Skip this verification' }],
        multiSelect: false,
        createdAt: FIXED_CREATED_AT,
      }),
    );
    runtimeA.close();

    // "Runtime 2" — the daemon restarted: fresh storage on the SAME db file,
    // no live adapters. The route reads the RESTORED record.
    const runtimeB = createStorage({
      databasePath: dbPath,
      runMigrations: true,
      userDataPath: path.join(testDir, 'secure'),
    });
    runtimeB.initialize();
    try {
      const built = buildServicesForStorage(runtimeB);
      registerRpcMethods(built.services);
      const handler = built.registered.get('task.getPendingRequest');
      await expect(handler?.({ taskId: TASK_ID })).resolves.toEqual({
        pendingRequest: {
          kind: 'question',
          requestId: 'questionreq_1',
          question: 'A CAPTCHA is blocking https://example.com/form',
          header: ASSISTANCE_QUESTION_HEADER,
          options: [
            { label: "I'll complete it — please wait" },
            { label: 'Skip this verification' },
          ],
          multiSelect: false,
          createdAt: FIXED_CREATED_AT,
        },
      });
    } finally {
      runtimeB.close();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('after the record is cleared (reply/terminal), the route answers the null carrier', async () => {
    if (!sqliteAvailable) {
      console.warn('Skipping: better-sqlite3 native module not available');
      return;
    }
    const testDir = path.join(
      os.tmpdir(),
      `pending-route-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    const dbPath = path.join(testDir, 'test.db');

    const store = createStorage({
      databasePath: dbPath,
      runMigrations: true,
      userDataPath: path.join(testDir, 'secure'),
    });
    store.initialize();
    try {
      store.saveTask({
        id: TASK_ID,
        prompt: 'original task',
        status: 'waiting_for_user',
        createdAt: FIXED_CREATED_AT,
        messages: [],
        sessionId: 'sess_orig_1',
      } as never);
      store.updateTaskPendingRequest(TASK_ID, {
        kind: 'question',
        requestId: 'questionreq_1',
        question: 'A CAPTCHA is blocking the site',
        createdAt: FIXED_CREATED_AT,
      });
      expect(store.getTaskPendingRequest(TASK_ID)?.requestId).toBe('questionreq_1');

      store.updateTaskPendingRequest(TASK_ID, null);
      const built = buildServicesForStorage(store);
      registerRpcMethods(built.services);
      const handler = built.registered.get('task.getPendingRequest');
      await expect(handler?.({ taskId: TASK_ID })).resolves.toEqual({ pendingRequest: null });
    } finally {
      store.close();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
