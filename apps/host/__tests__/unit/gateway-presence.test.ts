/**
 * Phase 3 M1 (PHASE_3_IMPLEMENTATION_PLAN §5.2) — gateway↔daemon presence
 * channel.
 *
 * The gateway reports interactive browser-UI presence to the daemon so the
 * permission auto-deny gate can distinguish an open UI from the gateway's
 * (persistent) own socket. Covers: WS lifecycle-driven reports, the 30 s
 * heartbeat, overlap guarding, and the security invariant that a browser can
 * NEVER forge presence — `daemon.setUiPresence` / `daemon.setClientType` are
 * host-internal and must stay outside the browser-facing allowlist.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createGateway, type GatewayHandle } from '../../src/gateway.js';
import { RPC_METHOD_ALLOWLIST } from '../../src/policy.js';
import { createFakeRpc, type RecordedCall } from './fake-rpc.js';

const TOKEN = 'presence-test-token';

interface PresenceGateway {
  gateway: GatewayHandle;
  rpc: ReturnType<typeof createFakeRpc>;
}

async function makeGateway(
  overrides: Partial<Parameters<typeof createGateway>[0]> = {},
): Promise<PresenceGateway> {
  const rpc = createFakeRpc();
  const gateway = await createGateway({
    port: 0,
    token: TOKEN,
    webDist: null,
    rpc,
    ...overrides,
  });
  return { gateway, rpc };
}

function presenceCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'daemon.setUiPresence');
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met within timeout');
}

function connectWs(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/events`);
}

function authenticate(ws: WebSocket, token = TOKEN): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8')) as { type: string };
      if (message.type === 'auth-ok') {
        resolve();
      } else {
        reject(new Error(`unexpected message during auth: ${data.toString('utf8')}`));
      }
    });
    ws.on('error', reject);
  });
}

// ── WS lifecycle-driven presence ─────────────────────────────────────────────

describe('browser WS lifecycle drives setUiPresence (Phase 3 M1 §5.2)', () => {
  let gw: PresenceGateway;

  beforeAll(async () => {
    gw = await makeGateway();
  });

  afterAll(async () => {
    await gw.gateway.close();
  });

  it('authenticated connect reports count 1, disconnect reports 0', async () => {
    const ws = connectWs(gw.gateway.port);
    await authenticate(ws);
    await waitFor(() => presenceCalls(gw.rpc.calls).length >= 1);
    expect(presenceCalls(gw.rpc.calls).at(-1)?.params).toEqual({ count: 1 });
    expect(gw.gateway.uiPresenceCount()).toBe(1);

    ws.close();
    await waitFor(() =>
      presenceCalls(gw.rpc.calls).some((c) =>
        c.params === undefined ? false : (c.params as { count: number }).count === 0,
      ),
    );
    expect(gw.gateway.uiPresenceCount()).toBe(0);
    // Last reported state after the disconnect is the 0-count.
    expect(presenceCalls(gw.rpc.calls).at(-1)?.params).toEqual({ count: 0 });
  });

  it('counts multiple authenticated clients', async () => {
    const a = connectWs(gw.gateway.port);
    const b = connectWs(gw.gateway.port);
    // Both authentications must arm concurrently — awaiting the first would
    // miss `b`'s 'open' event inside this test file's local handler.
    await Promise.all([authenticate(a), authenticate(b)]);
    try {
      await waitFor(() => gw.gateway.uiPresenceCount() === 2);
      expect(presenceCalls(gw.rpc.calls).at(-1)?.params).toEqual({ count: 2 });
    } finally {
      a.close();
      b.close();
      await waitFor(() => gw.gateway.uiPresenceCount() === 0);
    }
  });

  it('does not count unauthenticated sockets, even before their auth timeout', async () => {
    const before = presenceCalls(gw.rpc.calls).length;
    const ws = connectWs(gw.gateway.port);
    // Trigger a liveness report without authenticating (a closing unauthed
    // socket fires the close-path report) — the count must stay at 0.
    ws.on('error', () => {});
    ws.on('open', () => {
      ws.close();
    });
    await waitFor(() => presenceCalls(gw.rpc.calls).length >= before + 1);
    expect(presenceCalls(gw.rpc.calls).at(-1)?.params).toEqual({ count: 0 });
    expect(gw.gateway.uiPresenceCount()).toBe(0);
  });
});

// ── Heartbeat ────────────────────────────────────────────────────────────────

describe('presence heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-asserts the current count every 30s while armed', async () => {
    vi.useFakeTimers();
    const gw = await makeGateway({ presenceHeartbeatMs: 30_000 });
    gw.gateway.startPresenceHeartbeat();
    const base = presenceCalls(gw.rpc.calls).length;

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const ticks = presenceCalls(gw.rpc.calls).slice(base);
    expect(ticks.length).toBe(2);
    expect(ticks[0].params).toEqual({ count: 0 });

    // Disarm (daemon disconnected) → no further ticks.
    gw.gateway.stopPresenceHeartbeat();
    const afterStop = presenceCalls(gw.rpc.calls).length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(presenceCalls(gw.rpc.calls).length).toBe(afterStop);
    await gw.gateway.close();
  });

  it('is idempotent: arming twice does not double the interval', async () => {
    vi.useFakeTimers();
    const gw = await makeGateway({ presenceHeartbeatMs: 30_000 });
    gw.gateway.startPresenceHeartbeat();
    gw.gateway.startPresenceHeartbeat();
    const base = presenceCalls(gw.rpc.calls).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(presenceCalls(gw.rpc.calls).length - base).toBe(1);
    gw.gateway.stopPresenceHeartbeat();
    await gw.gateway.close();
  });

  it('close() disarms the heartbeat and fires a final 0-count report', async () => {
    vi.useFakeTimers();
    const gw = await makeGateway({ presenceHeartbeatMs: 1_000 });
    gw.gateway.startPresenceHeartbeat();
    await gw.gateway.close();
    const last = presenceCalls(gw.rpc.calls).at(-1);
    expect(last?.method).toBe('daemon.setUiPresence');
    expect(last?.params).toEqual({ count: 0 });
    const atClose = presenceCalls(gw.rpc.calls).length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(presenceCalls(gw.rpc.calls).length).toBe(atClose);
  });
});

// ── Overlap guard ────────────────────────────────────────────────────────────

describe('presence overlap guard', () => {
  it('coalesces reports while one is in flight and follows up with the latest count', async () => {
    const deferreds: Array<(v: unknown) => void> = [];
    const calls: RecordedCall[] = [];
    const rpc = {
      calls,
      call(method: string, params?: unknown): Promise<unknown> {
        calls.push({ method, params });
        return new Promise((resolve) => {
          deferreds.push(resolve);
        });
      },
    };
    const gateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist: null,
      rpc,
      // Short tick so real timers produce overlap quickly.
      presenceHeartbeatMs: 10,
    });
    const drain = async (): Promise<void> => {
      for (const resolve of deferreds.splice(0)) {
        resolve({});
      }
      await new Promise((r) => setTimeout(r, 10));
    };
    const reportCount = (): number =>
      calls.filter((c) => c.method === 'daemon.setUiPresence').length;

    try {
      gateway.startPresenceHeartbeat();
      // Convergence point: at least one tick fired and its request is
      // dangling (never resolved, so presenceInFlight stays true).
      await waitFor(() => reportCount() >= 1, 3000);

      // Another tick arrives while the first is still in flight → coalesced
      // (no concurrent second request), a follow-up is queued instead.
      await new Promise((r) => setTimeout(r, 30));
      const inFlightCalls = reportCount();
      expect(inFlightCalls).toBe(1);

      // The in-flight request completes → the queued follow-up re-reads the
      // live count and sends exactly one more.
      await drain();
      expect(reportCount()).toBe(2);
    } finally {
      gateway.stopPresenceHeartbeat();
      for (const resolve of deferreds.splice(0)) resolve({});
      await gateway.close();
      for (const resolve of deferreds.splice(0)) resolve({});
    }
  });
});

// ── Security invariant: browsers can never forge presence ────────────────────

describe('presence methods are not browser-callable', () => {
  let gw: PresenceGateway;

  beforeAll(async () => {
    gw = await makeGateway();
  });

  afterAll(async () => {
    await gw.gateway.close();
  });

  function rpcBody(id: number, method: string, params?: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params });
  }

  async function postRpc(
    method: string,
    params?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${gw.gateway.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: rpcBody(1, method, params),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('daemon.setUiPresence is rejected for a fully authenticated browser', async () => {
    const { status, body } = await postRpc('daemon.setUiPresence', { count: 5 });
    expect(status).toBe(403);
    expect((body.error as { code: number }).code).toBe(-32003);
  });

  it('daemon.setClientType is rejected for a fully authenticated browser', async () => {
    const { status, body } = await postRpc('daemon.setClientType', { clientType: 'gateway' });
    expect(status).toBe(403);
    expect((body.error as { code: number }).code).toBe(-32003);
    expect(gw.rpc.calls.filter((c) => c.method.startsWith('daemon.set')).length).toBe(0);
  });

  it('neither method appears in the browser allowlist (grep-proof invariant)', () => {
    expect(RPC_METHOD_ALLOWLIST).not.toContain('daemon.setUiPresence');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('daemon.setClientType');
  });
});
