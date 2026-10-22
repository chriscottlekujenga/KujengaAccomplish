/**
 * Daemon connector tests — spawn contract, node-binary resolution, and
 * connect/reuse behaviour against a fake JSON-RPC socket server.
 *
 * The full spawn → disconnect → reconnect cycle against the real daemon is
 * covered by __tests__/integration/gateway-daemon.test.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonConnector,
  type DaemonConnectorOptions,
  type ConnectionState,
} from '../../src/daemon-connector.js';
import {
  resolveDefaultDaemonEntryPath,
  resolveDefaultWebDist,
  resolveNodeBin,
} from '../../src/config.js';

interface FakeDaemonHandle {
  server: Server;
  requests: { method: string; params?: unknown }[];
  /** Destroy all client sockets and close the listener. */
  stop(): Promise<void>;
}

/**
 * Minimal daemon stand-in: a net server at `<dataDir>/daemon.sock` speaking
 * newline-delimited JSON-RPC for daemon.ping and daemon.shutdown. Like the
 * real daemon, it exits (stops listening, drops connections) on
 * daemon.shutdown so the connector's version-guard path is exercised
 * realistically.
 */
async function startFakeDaemon(
  dataDir: string,
  options: { buildId?: string } = {},
): Promise<FakeDaemonHandle> {
  const requests: { method: string; params?: unknown }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        try {
          const message = JSON.parse(line) as { id?: number; method: string; params?: unknown };
          requests.push({ method: message.method, params: message.params });
          if (message.method === 'daemon.ping') {
            const result = {
              status: 'ok',
              uptime: 1,
              ...(options.buildId ? { buildId: options.buildId } : {}),
            };
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
          } else if (message.method === 'daemon.setClientType') {
            socket.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n`,
            );
          } else if (message.method === 'daemon.setUiPresence') {
            socket.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n`,
            );
          } else if (message.method === 'daemon.shutdown') {
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null })}\n`);
            socket.end();
            void shutdownServer();
          }
        } catch {
          /* ignore malformed lines */
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
  });

  function shutdownServer(): Promise<void> {
    return new Promise((resolveShutdown) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => {
        resolveShutdown();
      });
    });
  }

  await new Promise<void>((resolveListen) => {
    server.listen(path.join(dataDir, 'daemon.sock'), resolveListen);
  });
  return {
    server,
    requests,
    stop: shutdownServer,
  };
}

function fakeChild(): ChildProcess {
  return {
    pid: 4321,
    unref: vi.fn(),
    on: vi.fn(),
  } as unknown as ChildProcess;
}

function makeSpawnSpy() {
  return vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => fakeChild());
}

function makeConnectorOptions(dataDir: string, overrides: Partial<DaemonConnectorOptions> = {}) {
  return {
    dataDir,
    daemonEntryPath: '/fake/daemon/index.js',
    nodeBin: '/fake/node',
    readyTimeoutMs: 400,
    pollIntervalMs: 20,
    loginRetryDelayMs: 10,
    reconnectInitialMs: 20,
    reconnectMaxMs: 100,
    reconnectMaxAttempts: 3,
    ...overrides,
  };
}

describe('path and node resolution', () => {
  it('resolves the daemon entry inside the repo', () => {
    const entry = resolveDefaultDaemonEntryPath();
    expect(entry).toBe(path.resolve(entry));
    expect(entry).toMatch(/apps[/\\]daemon[/\\]dist[/\\]index\.js$/);
  });

  it('resolves the web dist inside the repo', () => {
    expect(resolveDefaultWebDist()).toMatch(/apps[/\\]web[/\\]dist[/\\]client$/);
  });

  describe('resolveNodeBin', () => {
    const savedNodeBin = process.env.ACCOMPLISH_NODE_BIN;
    const savedPnpmNode = process.env.npm_node_execpath;

    afterEach(() => {
      if (savedNodeBin === undefined) {
        delete process.env.ACCOMPLISH_NODE_BIN;
      } else {
        process.env.ACCOMPLISH_NODE_BIN = savedNodeBin;
      }
      if (savedPnpmNode === undefined) {
        delete process.env.npm_node_execpath;
      } else {
        process.env.npm_node_execpath = savedPnpmNode;
      }
    });

    it('prefers the explicit argument', () => {
      expect(resolveNodeBin('/opt/node/bin/node')).toBe('/opt/node/bin/node');
    });

    it('falls back to ACCOMPLISH_NODE_BIN, then process.execPath', () => {
      process.env.ACCOMPLISH_NODE_BIN = process.execPath;
      expect(resolveNodeBin()).toBe(process.execPath);
      delete process.env.ACCOMPLISH_NODE_BIN;
      expect(resolveNodeBin()).toBe(process.execPath);
    });

    it('never adopts npm_node_execpath — pnpm ≥10 points it at the pnpm binary', () => {
      process.env.npm_node_execpath = '/definitely/not/node';
      expect(resolveNodeBin()).toBe(process.execPath);
    });
  });
});

describe('DaemonConnector', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'host-connector-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('spawns the daemon detached with the right argv and environment', () => {
    const spawnFn = makeSpawnSpy();
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const connector = new DaemonConnector(
        makeConnectorOptions(dataDir, { spawnFn, appPath: '/repo' }),
      );
      connector.spawnDaemon(dataDir);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawnFn.mock.calls[0];
      expect(command).toBe('/fake/node');
      expect(args).toEqual(['/fake/daemon/index.js', '--data-dir', dataDir]);
      expect(options.detached).toBe(true);
      expect(options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
      // Credential isolation: opencode auth/data scoped to the data dir.
      expect(options.env?.XDG_DATA_HOME).toBe(dataDir);
      expect(options.env?.ACCOMPLISH_APP_PATH).toBe('/repo');
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });

  it('reuses a running daemon without spawning', async () => {
    const fake = await startFakeDaemon(dataDir);
    const spawnFn = makeSpawnSpy();
    try {
      const connector = new DaemonConnector(makeConnectorOptions(dataDir, { spawnFn }));
      const client = await connector.start();
      expect(spawnFn).not.toHaveBeenCalled();
      const ping = await client.ping();
      expect(ping.status).toBe('ok');
      client.close();
    } finally {
      await fake.stop();
    }
  });

  it('polls until the timeout when no daemon comes up, then reports the socket path', async () => {
    const spawnFn = makeSpawnSpy();
    const connector = new DaemonConnector(makeConnectorOptions(dataDir, { spawnFn }));
    await expect(connector.start()).rejects.toThrow(/Daemon did not become ready within/);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('restarts a daemon whose buildId mismatches the expected one', async () => {
    const fake = await startFakeDaemon(dataDir, { buildId: 'old-build' });
    const spawnFn = makeSpawnSpy();
    try {
      const connector = new DaemonConnector(
        makeConnectorOptions(dataDir, {
          spawnFn,
          expectedBuildId: 'new-build',
        }),
      );
      // The fake exits on shutdown, so the spawn+poll path then times out
      // (the fake spawnFn never brings a daemon up) — proving the restart.
      await expect(connector.start()).rejects.toThrow(/Daemon did not become ready within/);
      expect(fake.requests.some((r) => r.method === 'daemon.shutdown')).toBe(true);
      expect(spawnFn).toHaveBeenCalledTimes(1);
    } finally {
      await fake.stop();
    }
  });

  it('keeps a matching-build daemon running', async () => {
    const fake = await startFakeDaemon(dataDir, { buildId: 'expected-build' });
    const spawnFn = makeSpawnSpy();
    try {
      const connector = new DaemonConnector(
        makeConnectorOptions(dataDir, {
          spawnFn,
          expectedBuildId: 'expected-build',
        }),
      );
      const client = await connector.start();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(fake.requests.some((r) => r.method === 'daemon.shutdown')).toBe(false);
      client.close();
    } finally {
      await fake.stop();
    }
  });

  it('suppresses the disconnect handler while reconnection is suppressed', async () => {
    const fake = await startFakeDaemon(dataDir);
    const states: ConnectionState[] = [];
    const connector = new DaemonConnector(makeConnectorOptions(dataDir));
    connector.onStateChange((state) => {
      states.push(state);
    });
    const client = await connector.start();
    connector.suppressReconnect();
    await fake.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(states).toEqual([]);
    client.close();
  });

  it('reports disconnection and reconnects to a restarted daemon', async () => {
    const states: ConnectionState[] = [];
    const connector = new DaemonConnector(
      makeConnectorOptions(dataDir, {
        reconnectInitialMs: 100,
        reconnectMaxMs: 500,
        reconnectMaxAttempts: 10,
        spawnFn: makeSpawnSpy(),
      }),
    );
    connector.onStateChange((state) => {
      states.push(state);
    });
    let replacedClient: unknown = null;
    connector.onClientReplaced((client) => {
      replacedClient = client;
    });

    const fake = await startFakeDaemon(dataDir);
    const client = await connector.start();
    await fake.stop();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(states).toContain('disconnected');
    expect(states).toContain('reconnecting');

    const revived = await startFakeDaemon(dataDir);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(states).toContain('connected');
    expect(replacedClient).not.toBeNull();

    await connector.stop();
    await revived.stop();
    client.close();
  });

  // ── Phase 3 M1 §5.2: host identity declaration ───────────────────────────
  // Every adopted connection (initial connect AND reconnect) must declare
  // the host as a gateway-typed client BEFORE reporting UI presence.

  it('declares gateway identity and UI presence on initial connect', async () => {
    const fake = await startFakeDaemon(dataDir);
    const connector = new DaemonConnector(
      makeConnectorOptions(dataDir, { uiClientCount: () => 2 }),
    );
    try {
      const client = await connector.start();
      await vi.waitFor(
        () => {
          const identity = fake.requests.filter(
            (r) => r.method === 'daemon.setClientType' || r.method === 'daemon.setUiPresence',
          );
          expect(identity.length).toBe(2);
        },
        { timeout: 3000, interval: 25 },
      );
      const [typeCall, presenceCall] = fake.requests.filter(
        (r) => r.method === 'daemon.setClientType' || r.method === 'daemon.setUiPresence',
      );
      expect(typeCall.method).toBe('daemon.setClientType');
      expect(typeCall.params).toEqual({ clientType: 'gateway' });
      expect(presenceCall.method).toBe('daemon.setUiPresence');
      expect(presenceCall.params).toEqual({ count: 2 });
      // Client typing must be declared before its presence report.
      expect(fake.requests.indexOf(typeCall)).toBeLessThan(fake.requests.indexOf(presenceCall));
      client.close();
    } finally {
      await connector.stop();
      await fake.stop();
    }
  });

  it('re-declares gateway identity and UI presence after a daemon reconnect', async () => {
    let revived: FakeDaemonHandle | null = null;
    const first = await startFakeDaemon(dataDir);
    const connector = new DaemonConnector(
      makeConnectorOptions(dataDir, {
        reconnectInitialMs: 20,
        reconnectMaxMs: 60,
        reconnectMaxAttempts: 10,
        spawnFn: makeSpawnSpy(),
        uiClientCount: () => 1,
      }),
    );
    try {
      const client = await connector.start();
      await first.stop();

      revived = await startFakeDaemon(dataDir);
      // The new daemon-side connection gets fresh identity + presence.
      await vi.waitFor(
        () => {
          const identity = revived!.requests.filter(
            (r) => r.method === 'daemon.setClientType' || r.method === 'daemon.setUiPresence',
          );
          expect(identity.length).toBe(2);
        },
        { timeout: 5000, interval: 25 },
      );
      const [typeCall, presenceCall] = revived!.requests.filter(
        (r) => r.method === 'daemon.setClientType' || r.method === 'daemon.setUiPresence',
      );
      expect(typeCall.params).toEqual({ clientType: 'gateway' });
      expect(presenceCall.params).toEqual({ count: 1 });

      await connector.stop();
      await revived.stop();
      client.close();
    } finally {
      await connector.stop();
      if (revived) {
        await revived.stop();
      }
      await first.stop();
    }
  });
});
