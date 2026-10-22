/**
 * Phase 3 M1 (PHASE_3_IMPLEMENTATION_PLAN §5.2) — interactive-presence gate
 * on DaemonRpcServer.
 *
 * Regressions for the permission auto-deny redesign: the gateway's persistent
 * socket must never count as UI presence on its own, while legacy clients
 * (Electron main, trusted shell) keep today's semantics unchanged. Also
 * covers the M1 socket hardening (chmod 0600).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonRpcServer, STALE_MS } from '../../../src/daemon/rpc-server.js';
import { DaemonClient } from '../../../src/daemon/client.js';
import { createSocketTransport } from '../../../src/daemon/socket-transport.js';

let tempDir: string;
let server: DaemonRpcServer | null = null;
const openClients: DaemonClient[] = [];

function createTempSocketPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'opencode/t1-presence-'));
  return join(tempDir, 'test.sock');
}

/**
 * Start a server with the identity routes registered exactly the way
 * apps/daemon/src/daemon-routes.ts registers them — handlers take the
 * caller's clientId and bind presence state to that connection.
 */
async function startServer(): Promise<{ server: DaemonRpcServer; socketPath: string }> {
  const socketPath = createTempSocketPath();
  const instance = new DaemonRpcServer({ socketPath });
  instance.registerMethod('daemon.setClientType', (params, clientId) => {
    const { clientType } = params as { clientType: 'gateway' | 'legacy' };
    instance.setClientType(clientId, clientType);
    return { ok: true };
  });
  instance.registerMethod('daemon.setUiPresence', (params, clientId) => {
    const { count } = params as { count: number };
    instance.setUiPresence(clientId, count);
    return { ok: true };
  });
  await instance.start();
  server = instance;
  return { server: instance, socketPath };
}

async function connectClient(socketPath: string): Promise<DaemonClient> {
  const transport = await createSocketTransport({ socketPath, connectTimeout: 2000 });
  const client = new DaemonClient({ transport });
  await client.ping();
  openClients.push(client);
  return client;
}

/** Wait until the server-side close event has dropped the client's state. */
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met within timeout');
}

afterEach(async () => {
  vi.useRealTimers();
  for (const client of openClients.splice(0)) {
    client.close();
  }
  if (server) {
    await server.stop();
    server = null;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('DaemonRpcServer interactive presence (Phase 3 M1 §5.2)', () => {
  it('exports STALE_MS = 90_000 per the design contract', () => {
    expect(STALE_MS).toBe(90_000);
  });

  it('treats a client that never calls setClientType as legacy (interactive)', async () => {
    const { server: s, socketPath } = await startServer();
    await connectClient(socketPath);
    // No daemon.setClientType call — the bare connection implies a
    // trusted-shell UI (pre-M1 fallback semantics).
    expect(s.hasInteractiveClients()).toBe(true);
  });

  it('counts a legacy client as interactive', async () => {
    const { server: s, socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'legacy' });
    expect(s.hasInteractiveClients()).toBe(true);
  });

  it('gateway with reported count 0 is NOT interactive', async () => {
    const { server: s, socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 0 });
    expect(s.hasInteractiveClients()).toBe(false);
  });

  it('identity routes answer { ok: true }', async () => {
    const { socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await expect(client.call('daemon.setClientType', { clientType: 'gateway' })).resolves.toEqual({
      ok: true,
    });
    await expect(client.call('daemon.setUiPresence', { count: 3 })).resolves.toEqual({
      ok: true,
    });
  });

  it('gateway with reported count > 0 IS interactive', async () => {
    const { server: s, socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 2 });
    expect(s.hasInteractiveClients()).toBe(true);
  });

  it('gateway count dropping to 0 removes interactive presence', async () => {
    const { server: s, socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 2 });
    expect(s.hasInteractiveClients()).toBe(true);
    await client.call('daemon.setUiPresence', { count: 0 });
    expect(s.hasInteractiveClients()).toBe(false);
  });

  it('presence expires after STALE_MS without a heartbeat (fake clock)', async () => {
    const { server: s, socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 1 });
    expect(s.hasInteractiveClients()).toBe(true);

    // Fake only Date — real socket I/O timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + STALE_MS + 1);
    expect(s.hasInteractiveClients()).toBe(false);

    // A heartbeat immediately after the previous check keeps it fresh.
    vi.setSystemTime(Date.now() + STALE_MS + 1);
    await client.call('daemon.setUiPresence', { count: 1 });
    expect(s.hasInteractiveClients()).toBe(true);

    vi.setSystemTime(Date.now() + STALE_MS + 1);
    expect(s.hasInteractiveClients()).toBe(false);
  });

  it('disconnecting the reporting gateway drops presence immediately', async () => {
    const { server: s, socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 3 });
    expect(s.hasInteractiveClients()).toBe(true);

    client.close();
    // Its last reported count must not survive the socket: the crash/no-final
    // message case still terminates once the connection itself is gone.
    await waitFor(() => s.hasInteractiveClients() === false);
    await waitFor(() => s.hasConnectedClients() === false);
    expect(s.hasInteractiveClients()).toBe(false);
  });

  it('hasConnectedClients is unchanged: gateway count 0 still counts as a socket client', async () => {
    const { server: s, socketPath } = await startServer();
    const client = await connectClient(socketPath);
    await client.call('daemon.setClientType', { clientType: 'gateway' });
    await client.call('daemon.setUiPresence', { count: 0 });
    expect(s.hasConnectedClients()).toBe(true);
    expect(s.hasInteractiveClients()).toBe(false);

    client.close();
    await waitFor(() => s.hasConnectedClients() === false);
    expect(s.hasConnectedClients()).toBe(false);
  });

  it('mixed session: legacy client keeps presence even when the gateway reports 0', async () => {
    const { server: s, socketPath } = await startServer();
    const legacy = await connectClient(socketPath);
    const gateway = await connectClient(socketPath);
    await gateway.call('daemon.setClientType', { clientType: 'gateway' });
    await gateway.call('daemon.setUiPresence', { count: 0 });
    // Electron main connected alongside the gateway → prompts still deliver.
    expect(s.hasInteractiveClients()).toBe(true);
    legacy.close();
    await waitFor(() => s.hasConnectedClients() === true);
    gateway.close();
  });
});

describe('DaemonRpcServer socket permissions (Phase 3 M1 §5.3)', () => {
  it('restricts the unix socket to mode 0600', async () => {
    const { socketPath } = await startServer();
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
