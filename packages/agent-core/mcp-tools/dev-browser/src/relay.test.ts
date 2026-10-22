/**
 * Integration tests for the dev-browser CDP relay (:9224) — Phase 3 M1 §5.3.
 *
 * Covers:
 *  - HTTP bearer-token auth (401 without/wrong token) on all routes
 *  - Origin rejection (browser UI must not call this API directly)
 *  - Loopback-bind assertion (127.0.0.1)
 *  - WS /cdp upgrade-header auth (Playwright client path)
 *  - WS /cdp first-message auth exchange ({"type":"auth","token":...}),
 *    mirroring the host gateway /events socket
 *  - WS /extension auth exchange
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { serveRelay } from './relay.js';

const TOKEN = 't2-relay-test-token';
const ENV_KEY = 'ACCOMPLISH_DEV_BROWSER_TOKEN';

let relay: Awaited<ReturnType<typeof serveRelay>>;

beforeAll(async () => {
  // The relay resolves its token from ACCOMPLISH_DEV_BROWSER_TOKEN (Phase 3
  // M1 §5.3) — seed it before serveRelay resolves the token.
  process.env[ENV_KEY] = TOKEN;
  relay = await serveRelay({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  if (relay) {
    await relay.stop();
    relay = undefined as unknown as typeof relay;
  }
  if (process.env[ENV_KEY] === TOKEN) {
    delete process.env[ENV_KEY];
  }
});

describe('relay HTTP auth', () => {
  it('binds loopback only (127.0.0.1) — scripted bind assertion', async () => {
    const r = relay;
    expect(r.bindAddress).toBe('127.0.0.1');
    expect(r.port).toBeGreaterThan(0);
  });

  it('returns 401 without a token', async () => {
    const r = relay;
    const res = await fetch(`http://127.0.0.1:${r.port}/`);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('returns 401 with a wrong token', async () => {
    const r = relay;
    const res = await fetch(`http://127.0.0.1:${r.port}/pages`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with the correct token on every HTTP route', async () => {
    const r = relay;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const info = await fetch(`http://127.0.0.1:${r.port}/`, { headers: auth });
    expect(info.status).toBe(200);
    const body = (await info.json()) as { mode: string; extensionConnected: boolean };
    expect(body.mode).toBe('extension');

    const pages = await fetch(`http://127.0.0.1:${r.port}/pages`, { headers: auth });
    expect(pages.status).toBe(200);
    expect(await pages.json()).toEqual({ pages: [] });

    const del = await fetch(`http://127.0.0.1:${r.port}/pages/does-not-exist`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(del.status).toBe(200);
  });

  it('rejects any Origin-bearing request with 403 (browser UI must not call this API)', async () => {
    const r = relay;
    const res = await fetch(`http://127.0.0.1:${r.port}/`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://127.0.0.1:5173' },
    });
    expect(res.status).toBe(403);
  });
});

describe('relay /cdp WebSocket auth', () => {
  it('accepts a client that authenticates via upgrade headers (Playwright cdpHeaders path)', async () => {
    const r = relay;
    // The CDP-relay client path: connectOverCDP sends connection credentials
    // on the upgrade request; afterwards raw CDP commands flow.
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${r.port}/cdp/test-header-auth`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });

    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      setTimeout(() => reject(new Error('no CDP reply')), 3000);
    });
    expect(JSON.parse(reply).error.message).toBe('Extension not connected');
    ws.close();
  });

  it('accepts a header-less client via the first-message auth exchange', async () => {
    const r = relay;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${r.port}/cdp/test-exchange`);
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });

    const authOk = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
      setTimeout(() => reject(new Error('no auth-ok'), 3000));
    });
    expect(JSON.parse(authOk)).toEqual({ type: 'auth-ok' });
    ws.close();
  });

  it('closes with auth error code 4401 on a WRONG exchange token', async () => {
    const r = relay;
    const outcome = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/cdp/test-wrong-token`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'not-the-token' }));
      });
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('socket should have closed')), 3000);
    });
    expect(outcome.code).toBe(4401);
    expect(outcome.reason).toBe('invalid token');
  });

  it('closes with auth error code 4401 when the first message is not the auth exchange', async () => {
    const r = relay;
    const outcome = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/cdp/test-no-auth`);
      // Imitates a Playwright handshake with no credentials: a raw CDP
      // command must NOT be piped before authentication.
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      });
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('socket should have closed')), 3000);
    });
    expect(outcome.code).toBe(4401);
    expect(outcome.reason).toBe('authentication required');
  });

  it('closes with auth error code 4401 when the wrong credential is in the upgrade headers', async () => {
    const r = relay;
    const outcome = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/cdp/test-bad-header`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      ws.on('error', () => {
        /* expected close follows */
      });
      setTimeout(() => reject(new Error('socket should have closed')), 3000);
    });
    expect(outcome.code).toBe(4401);
    expect(outcome.reason).toBe('invalid token');
  });

  it('accepts the extension path via the first-message auth exchange and pipes events to /cdp clients', async () => {
    const r = relay;

    // An authenticated /cdp (Playwright) client receives relayed CDP events.
    const cdpClient = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${r.port}/cdp/test-ext-relay`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${r.port}/extension`);
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });

    const authOk = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()));
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
      setTimeout(() => reject(new Error('no auth-ok')), 3000);
    });
    expect(JSON.parse(authOk)).toEqual({ type: 'auth-ok' });

    // After auth, extension CDP events flow to attached /cdp clients.
    const forwarded = await new Promise<string>((resolve, reject) => {
      cdpClient.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { method?: string };
        if (msg.method === 'Target.targetCreated') {
          resolve(data.toString());
        }
      });
      ws.send(
        JSON.stringify({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.targetCreated',
            params: {
              targetInfo: {
                targetId: 't1',
                type: 'page',
                title: 'T2',
                url: 'about:blank',
                attached: false,
              },
            },
          },
        }),
      );
      setTimeout(() => reject(new Error('event not relayed')), 3000);
    });
    expect(JSON.parse(forwarded).params.targetInfo.targetId).toBe('t1');
    ws.close();
    cdpClient.close();
  });

  it('rejects the extension path without auth (old unauthenticated extension behavior removed)', async () => {
    const r = relay;
    const outcome = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/extension`);
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            method: 'forwardCDPEvent',
            params: { method: 'Target.targetCreated', params: { targetInfo: {} } },
          }),
        );
      });
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      ws.on('error', () => {
        /* expected close follows */
      });
      setTimeout(() => reject(new Error('socket should have closed')), 3000);
    });
    expect(outcome.code).toBe(4401);
    expect(outcome.reason).toBe('authentication required');
  });
});

afterAll(async () => {
  if (relay) {
    await relay.stop();
    relay = undefined as unknown as typeof relay;
  }
});
