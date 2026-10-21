/**
 * Phase 1 integration test — the real daemon behind the real gateway.
 *
 * Spawns the actual `apps/daemon` process on an isolated throwaway data
 * directory (never the production/Electron data dir, never real credentials)
 * and drives it end-to-end over the browser-facing HTTP + WebSocket surface:
 *
 *   - daemon.ping / task.list / settings / workspace / scheduler RPCs
 *   - settings.changed + workspace.changed notifications over WS
 *   - the full daemon.shutdown → disconnect → respawn → reconnect cycle
 *
 * Requires `pnpm -F @accomplish/daemon build` to have been run.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHostApp, type HostApp } from '../../src/host-app.js';
import { resolveDefaultDaemonEntryPath } from '../../src/config.js';
import { createConsoleLogger } from '../../src/logger.js';

const TOKEN = 'integration-test-gateway-token';
const RECONNECT_TEST_TIMEOUT_MS = 90_000;

let app: HostApp;
let dataDir: string;
let webDist: string;

function gatewayUrl(pathname: string): string {
  return `http://127.0.0.1:${app.gateway.port}${pathname}`;
}

async function rpc(method: string, params?: unknown): Promise<unknown> {
  const res = await fetch(gatewayUrl('/rpc'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) {
    throw new Error(`RPC ${method} failed: ${body.error.message}`);
  }
  return body.result;
}

interface WsSession {
  nextNotification(method: string, timeoutMs?: number): Promise<unknown>;
  nextControl(event: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

function openEventStream(): Promise<WsSession> {
  const ws = new WebSocket(`ws://127.0.0.1:${app.gateway.port}/events`);
  const queue: Array<{ type: string; method?: string; event?: string; params?: unknown }> = [];
  const waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    match: (message: { type: string; method?: string; event?: string }) => boolean;
    timer: NodeJS.Timeout;
  }> = [];

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString('utf8')) as {
      type: string;
      method?: string;
      event?: string;
      params?: unknown;
    };
    const index = waiters.findIndex((w) => w.match(message));
    if (index !== -1) {
      const waiter = waiters[index];
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
      return;
    }
    queue.push(message);
  });

  return new Promise((resolveAuth, rejectAuth) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    });
    ws.on('message', function onAuth(data) {
      const message = JSON.parse(data.toString('utf8')) as { type: string };
      if (message.type === 'auth-ok') {
        ws.removeListener('message', onAuth);
        resolveAuth({
          nextNotification(method: string, timeoutMs = 5000): Promise<unknown> {
            const queued = queue.findIndex((m) => m.type === 'notification' && m.method === method);
            if (queued !== -1) {
              return Promise.resolve(queue.splice(queued, 1)[0].params);
            }
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`timed out waiting for notification ${method}`));
              }, timeoutMs);
              waiters.push({
                resolve,
                reject,
                timer,
                match: (m) => m.type === 'notification' && m.method === method,
              });
            });
          },
          nextControl(event: string, timeoutMs = 5000): Promise<void> {
            const queued = queue.findIndex((m) => m.type === 'control' && m.event === event);
            if (queued !== -1) {
              queue.splice(queued, 1);
              return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`timed out waiting for control event ${event}`));
              }, timeoutMs);
              waiters.push({
                resolve: () => {
                  resolve();
                },
                reject,
                timer,
                match: (m) => m.type === 'control' && m.event === event,
              });
            });
          },
          close(): void {
            for (const waiter of waiters) {
              clearTimeout(waiter.timer);
              waiter.reject(new Error('socket closed'));
            }
            ws.close();
          },
        });
      }
    });
    ws.on('error', rejectAuth);
    ws.on('close', (code) => {
      rejectAuth(new Error(`socket closed during auth with ${code}`));
    });
  });
}

async function waitForDaemonExit(dir: string, timeoutMs = 15_000): Promise<void> {
  const pidPath = path.join(dir, 'daemon.pid');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(pidPath)) {
      return;
    }
    try {
      const { pid } = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number };
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('daemon did not exit after shutdown');
}

beforeAll(async () => {
  const daemonEntry = resolveDefaultDaemonEntryPath();
  if (!existsSync(daemonEntry)) {
    throw new Error(
      `Daemon not built: ${daemonEntry} is missing. Run "pnpm -F @accomplish/daemon build" first.`,
    );
  }

  dataDir = mkdtempSync(path.join(tmpdir(), 'host-integration-'));
  webDist = mkdtempSync(path.join(tmpdir(), 'host-integration-webdist-'));
  writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>ui</title>');

  app = await startHostApp({
    dataDir,
    token: TOKEN,
    port: 0,
    webDist,
    logger: createConsoleLogger('[host-it]'),
    connectorOptions: {
      readyTimeoutMs: 30_000,
      pollIntervalMs: 200,
      reconnectInitialMs: 100,
      reconnectMaxMs: 500,
      reconnectMaxAttempts: 5,
    },
  });
}, 120_000);

afterAll(async () => {
  if (app) {
    await app.stop();
  }
  if (dataDir) {
    try {
      await waitForDaemonExit(dataDir, 10_000);
    } catch {
      // Safety net: if the daemon somehow survived the shutdown request,
      // SIGTERM it so the test never leaks a process or a temp data dir.
      try {
        const { pid } = JSON.parse(readFileSync(path.join(dataDir, 'daemon.pid'), 'utf8')) as {
          pid: number;
        };
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (webDist) {
    rmSync(webDist, { recursive: true, force: true });
  }
}, 30_000);

describe('gateway ↔ real daemon integration', () => {
  it('serves /health without a token', async () => {
    const res = await fetch(gatewayUrl('/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('proxies daemon.ping to the real daemon', async () => {
    const result = (await rpc('daemon.ping')) as { status: string; uptime: number };
    expect(result.status).toBe('ok');
    expect(typeof result.uptime).toBe('number');
  });

  it('starts with an empty task list on a fresh data dir', async () => {
    const tasks = (await rpc('task.list', {})) as unknown[];
    expect(tasks).toEqual([]);
  });

  it('round-trips settings through the daemon SQLite store', async () => {
    const before = (await rpc('settings.getAll')) as { app: { theme: string } };
    const target = before.app.theme === 'dark' ? 'light' : 'dark';
    await rpc('settings.setTheme', { theme: target });
    const after = (await rpc('settings.getAll')) as { app: { theme: string } };
    expect(after.app.theme).toBe(target);
  });

  it('persists the gateway token file with restrictive permissions', () => {
    const tokenFile = path.join(dataDir, 'gateway-token');
    expect(existsSync(tokenFile)).toBe(true);
    const mode = statSync(tokenFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('publishes gateway-info.json for the .desktop launcher hand-off', () => {
    const infoPath = path.join(dataDir, 'gateway-info.json');
    expect(existsSync(infoPath)).toBe(true);
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { port: number; pid: number };
    expect(info.port).toBe(app.gateway.port);
    expect(info.pid).toBe(process.pid);
    // The instance must be discoverable via findExistingInstance.
    const mode = statSync(infoPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('forwards accomplish:// deep links to authenticated WS clients', async () => {
    const session = await openEventStream();
    const control = session.nextControl('mcp-callback');
    const res = await fetch(gatewayUrl('/deep-link'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ url: 'accomplish://callback/mcp?state=phase2' }),
    });
    expect(res.status).toBe(200);
    await control;
    session.close();
  });

  it('streams settings.changed notifications to authenticated WS clients', async () => {
    const session = await openEventStream();
    const target = ((await rpc('settings.getAll')) as { app: { theme: string } }).app.theme;
    const next = target === 'dark' ? 'light' : 'dark';
    const notification = session.nextNotification('settings.changed');
    await rpc('settings.setTheme', { theme: next });
    const payload = (await notification) as { key: string; value: string };
    expect(payload.key).toBe('theme');
    expect(payload.value).toBe(next);
    session.close();
  });

  it('creates workspaces and broadcasts workspace.changed', async () => {
    const session = await openEventStream();
    const notification = session.nextNotification('workspace.changed');
    const created = (await rpc('workspace.create', {
      input: { name: 'Integration Workspace' },
    })) as { id: string; name: string };
    const payload = (await notification) as { kind: string; workspaceId: string };
    expect(payload.kind).toBe('workspace.created');
    expect(payload.workspaceId).toBe(created.id);
    const workspaces = (await rpc('workspace.list')) as Array<{ id: string }>;
    expect(workspaces.some((w) => w.id === created.id)).toBe(true);
    session.close();
  });

  it('manages scheduler entries end-to-end', async () => {
    // A cron that only fires on Dec 31 — never during this test run.
    const created = (await rpc('task.schedule', {
      cron: '30 2 31 12 *',
      prompt: 'integration-test schedule',
    })) as { id: string; cron: string; enabled: boolean };
    expect(created.cron).toBe('30 2 31 12 *');
    expect(created.enabled).toBe(true);

    const listed = (await rpc('task.listScheduled', {})) as Array<{ id: string }>;
    expect(listed.some((s) => s.id === created.id)).toBe(true);

    await rpc('task.cancelScheduled', { scheduleId: created.id });
    const after = (await rpc('task.listScheduled', {})) as Array<{ id: string }>;
    expect(after.some((s) => s.id === created.id)).toBe(false);
  });

  it(
    'survives a daemon shutdown: disconnect → respawn → reconnect → catch-up',
    async () => {
      const session = await openEventStream();

      const disconnected = session.nextControl('daemon:disconnected');
      const reconnected = session.nextControl('daemon:reconnected');

      // Stop the daemon through the same RPC surface the UI uses.
      await rpc('daemon.shutdown');

      await disconnected;
      await reconnected;

      // The connector respawned the daemon; task.list must work again and
      // reflect persisted state (the workspace created earlier survives).
      const workspaces = (await rpc('workspace.list')) as Array<{ id: string }>;
      expect(workspaces.length).toBeGreaterThan(0);
      session.close();
    },
    RECONNECT_TEST_TIMEOUT_MS,
  );
});
