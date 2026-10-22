/**
 * Phase 3 M1 (PHASE_3_IMPLEMENTATION_PLAN §5.2) — daemon-side permission
 * auto-deny gate against a REAL DaemonRpcServer with real socket clients.
 *
 * The pre-M1 probe (`hasConnectedClients`) counted the gateway's persistent
 * socket as an interactive UI, so permission requests never auto-denied
 * while the host process ran. The rewritten gate requires actual interactive
 * presence:
 *
 *   interactive = connected legacy client (Electron main, trusted shell)
 *              OR gateway-reported browser-UI count > 0, fresh (≤ STALE_MS)
 *
 * These tests wire `taskService`'s probe exactly the way apps/daemon/src/
 * index.ts does — `hasInteractiveClients: () => rpc.hasInteractiveClients()`.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  DaemonRpcServer,
  STALE_MS,
  createSocketTransport,
  DaemonClient,
  type PermissionRequest,
  type StorageAPI,
  type TaskManagerAPI,
  type TaskSource,
} from '@accomplish_ai/agent-core';
import { createTaskCallbacks } from '../../src/task-callbacks.js';
import { registerRpcMethods, type RouteServices } from '../../src/daemon-routes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: real RPC server with identity routes, real socket clients.
// ─────────────────────────────────────────────────────────────────────────────

interface PresenceStack {
  server: DaemonRpcServer;
  socketPath: string;
  cleanup(): Promise<void>;
}

const stacks: PresenceStack[] = [];
const clients: DaemonClient[] = [];

async function startPresenceServer(): Promise<PresenceStack> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'opencode/t1-daemon-gate-'));
  const socketPath = path.join(dataDir, 'daemon.sock');
  const server = new DaemonRpcServer({ socketPath });

  // Identity routes — copy of the daemon-routes.ts registration, bound to
  // the caller's socket connection via the handler's clientId argument.
  server.registerMethod('daemon.setClientType', (params, clientId) => {
    const { clientType } = params as { clientType: 'gateway' | 'legacy' };
    server.setClientType(clientId, clientType);
    return { ok: true };
  });
  server.registerMethod('daemon.setUiPresence', (params, clientId) => {
    const { count } = params as { count: number };
    server.setUiPresence(clientId, count);
    return { ok: true };
  });

  await server.start();
  const stack: PresenceStack = {
    server,
    socketPath,
    cleanup: async () => {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  stacks.push(stack);
  return stack;
}

async function connectClient(socketPath: string): Promise<DaemonClient> {
  const transport = await createSocketTransport({ socketPath, connectTimeout: 2000 });
  const client = new DaemonClient({ transport });
  await client.ping();
  clients.push(client);
  return client;
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met within timeout');
}

/**
 * Task-callback fixture wired exactly like the daemon wires TaskService's
 * presence probe (`hasInteractiveClients: () => rpc.hasInteractiveClients()`).
 * Returns the deny spy and the 'permission' event listener (standing in for
 * the task-event-forwarding RPC notify listener).
 */
function buildTaskFixture(
  server: DaemonRpcServer,
  source: TaskSource,
): {
  callbacks: ReturnType<typeof createTaskCallbacks>;
  permissionListener: ReturnType<typeof vi.fn>;
  deny: ReturnType<typeof vi.fn>;
} {
  const deny = vi.fn(async () => {});
  const emitter = new EventEmitter();
  const permissionListener = vi.fn();
  emitter.on('permission', permissionListener);
  const callbacks = createTaskCallbacks(
    'tsk_gate',
    emitter,
    {} as StorageAPI,
    {} as TaskManagerAPI,
    {
      presence: { hasInteractiveClients: () => server.hasInteractiveClients() },
      getTaskSource: () => source,
      sendPermissionResponse: deny,
    },
  );
  return { callbacks, permissionListener, deny };
}

const fakeRequest: PermissionRequest = {
  id: 'filereq_gate',
  taskId: 'tsk_gate',
  type: 'file',
  fileOperation: 'create',
  filePath: '/tmp/any.txt',
  timestamp: new Date().toISOString(),
};

afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.close();
  for (const s of stacks.splice(0)) await s.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Permission-gate scenarios (M1-1 acceptance matrix).
// ─────────────────────────────────────────────────────────────────────────────

describe('permission gate with a real gateway connection', () => {
  it('auto-denies when only a gateway is connected and reports count 0', async () => {
    const { server, socketPath } = await startPresenceServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 0 });

    const { callbacks, permissionListener, deny } = buildTaskFixture(server, 'ui');
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(deny).toHaveBeenCalledWith('tsk_gate', {
      taskId: 'tsk_gate',
      requestId: 'filereq_gate',
      decision: 'deny',
    });
    expect(permissionListener).not.toHaveBeenCalled();
  });

  it('delivers the prompt when the gateway reports count > 0', async () => {
    const { server, socketPath } = await startPresenceServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 2 });

    const { callbacks, permissionListener, deny } = buildTaskFixture(server, 'ui');
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(permissionListener).toHaveBeenCalledWith(fakeRequest);
    expect(deny).not.toHaveBeenCalled();
    // The 5-min in-flight timeout path stays reachable — nothing here denies.
    expect(server.hasInteractiveClients()).toBe(true);
  });

  it('auto-denies after the reported heartbeat goes stale (fake clock)', async () => {
    const { server, socketPath } = await startPresenceServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 1 });

    const { callbacks, deny } = buildTaskFixture(server, 'scheduler');

    // Fresh report → prompt possible.
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(deny).not.toHaveBeenCalled();

    // Host died (no further heartbeat) → presence expires after STALE_MS.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + STALE_MS + 1);
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(server.hasInteractiveClients()).toBe(false);
    expect(deny).toHaveBeenCalledWith('tsk_gate', {
      taskId: 'tsk_gate',
      requestId: 'filereq_gate',
      decision: 'deny',
    });
  });

  it('graceful gateway disconnect → subsequent requests auto-deny immediately', async () => {
    const { server, socketPath } = await startPresenceServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 1 });
    expect(server.hasInteractiveClients()).toBe(true);

    client.close();
    await waitFor(() => server.hasInteractiveClients() === false);

    const { callbacks, deny } = buildTaskFixture(server, 'ui');
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(deny).toHaveBeenCalled();
  });
});

describe('scheduled / whatsapp task outcomes unchanged', () => {
  it('scheduled task with no interactive client → auto-deny (same outcome as today)', async () => {
    const { server, socketPath } = await startPresenceServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 0 });

    const { callbacks, deny } = buildTaskFixture(server, 'scheduler');
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(deny).toHaveBeenCalledWith('tsk_gate', {
      taskId: 'tsk_gate',
      requestId: 'filereq_gate',
      decision: 'deny',
    });
  });

  it('scheduled task with an interactive client → prompts (user can still approve)', async () => {
    const { server, socketPath } = await startPresenceServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 1 });

    const { callbacks, permissionListener, deny } = buildTaskFixture(server, 'scheduler');
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(permissionListener).toHaveBeenCalledWith(fakeRequest);
    expect(deny).not.toHaveBeenCalled();
  });

  it('pure-Electron session (legacy client, no gateway) → prompt delivered', async () => {
    const { server, socketPath } = await startPresenceServer();
    // Electron main: connects and never calls daemon.setClientType.
    await connectClient(socketPath);
    expect(server.hasInteractiveClients()).toBe(true);

    const { callbacks, permissionListener, deny } = buildTaskFixture(server, 'ui');
    callbacks.onPermissionRequest?.(fakeRequest);
    expect(permissionListener).toHaveBeenCalledWith(fakeRequest);
    expect(deny).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// daemon-routes.ts registration of the two identity methods.
// ─────────────────────────────────────────────────────────────────────────────

describe('daemon-routes: daemon.setClientType / daemon.setUiPresence', () => {
  function makeStubServices(): RouteServices {
    const evented = () => ({
      on: vi.fn(),
      emit: vi.fn(),
      listenerCount: vi.fn(() => 0),
    });
    // The routes only call `registerMethod`/`notify` plus service `.on`
    // subscriptions during registration; handlers close over the services.
    return {
      rpc: {
        registerMethod: vi.fn(),
        notify: vi.fn(),
        setClientType: vi.fn(),
        setUiPresence: vi.fn(),
      },
      taskService: {} as never,
      healthService: {} as never,
      storageService: { getStorage: () => ({}) } as never,
      schedulerService: {} as never,
      accomplishRuntime: { onUsageUpdate: vi.fn() } as never,
      whatsappService: {} as never,
      openAiOauthManager: {} as never,
      secretsService: {} as never,
      settingsService: evented() as never,
      workspaceService: evented() as never,
      connectorService: {} as never,
      legacyImportService: {} as never,
      googleAccountService: evented() as never,
      skillsService: evented() as never,
    } as unknown as RouteServices;
  }

  function registeredHandler(rpc: { registerMethod: Mock }, method: string) {
    const call = (rpc.registerMethod as Mock).mock.calls.find(([m]) => m === method);
    return call?.[1] as (params: unknown, clientId: string) => Promise<unknown>;
  }

  it('registers setClientType and forwards (validated type, caller clientId)', async () => {
    const services = makeStubServices();
    registerRpcMethods(services);
    const handler = registeredHandler(
      services.rpc as { registerMethod: Mock },
      'daemon.setClientType',
    );
    expect(handler).toBeDefined();
    await expect(handler({ clientType: 'gateway' }, 'conn-a')).resolves.toEqual({ ok: true });
    expect(services.rpc.setClientType).toHaveBeenCalledWith('conn-a', 'gateway');
    await expect(handler({ clientType: 'legacy' }, 'conn-b')).resolves.toEqual({ ok: true });
    expect(services.rpc.setClientType).toHaveBeenCalledWith('conn-b', 'legacy');
  });

  it('rejects an unknown clientType', async () => {
    const services = makeStubServices();
    registerRpcMethods(services);
    const handler = registeredHandler(
      services.rpc as { registerMethod: Mock },
      'daemon.setClientType',
    );
    await expect(handler({ clientType: 'browser' }, 'conn-a')).rejects.toThrow(/Invalid payload/i);
    expect(services.rpc.setClientType).not.toHaveBeenCalled();
  });

  it('registers setUiPresence, validates count, forwards caller clientId', async () => {
    const services = makeStubServices();
    registerRpcMethods(services);
    const handler = registeredHandler(
      services.rpc as { registerMethod: Mock },
      'daemon.setUiPresence',
    );
    await expect(handler({ count: 7 }, 'conn-c')).resolves.toEqual({ ok: true });
    expect(services.rpc.setUiPresence).toHaveBeenCalledWith('conn-c', 7);
    await expect(handler({ count: -1 }, 'conn-c')).rejects.toThrow(/Invalid payload/i);
    await expect(handler({ count: 1.5 }, 'conn-c')).rejects.toThrow(/Invalid payload/i);
    await expect(handler({}, 'conn-c')).rejects.toThrow(/Invalid payload/i);
    expect(services.rpc.setUiPresence).toHaveBeenCalledTimes(1);
  });
});
