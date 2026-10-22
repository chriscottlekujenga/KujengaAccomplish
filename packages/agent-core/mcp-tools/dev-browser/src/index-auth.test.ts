/**
 * Integration tests for the dev-browser launch server (:9224 surface) —
 * Phase 3 M1 §5.3.
 *
 * The HTTP auth cases never launch Chromium; the final test performs a full
 * ephemeral-CDP-port launch (real headless Chromium) to prove that
 * `--remote-debugging-port=0` + DevToolsActivePort discovery + MCP-style
 * connectOverCDP still work end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { rm } from 'fs/promises';
import { serve, type DevBrowserServer } from './index.js';

const TOKEN = 't2-launch-server-token';
const ENV_KEY = 'ACCOMPLISH_DEV_BROWSER_TOKEN';
// Temp profile under /tmp — never inside the repo.
const PROFILE_DIR = '/tmp/opencode/t2-browser-profiles';

const originalEnv = process.env[ENV_KEY];
process.env[ENV_KEY] = TOKEN;

let server: DevBrowserServer;

beforeAll(async () => {
  server = await serve({
    port: 0,
    headless: true,
    useSystemChrome: false,
    profileDir: PROFILE_DIR,
  });
});

afterAll(async () => {
  await server.stop();
  if (originalEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalEnv;
  }
  await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('launch server HTTP auth (Phase 3 M1 §5.3)', () => {
  it('binds loopback only (127.0.0.1) and reports the actual port — scripted bind assertion', () => {
    expect(server.bindAddress).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
  });

  it('returns 401 without a token on every endpoint', async () => {
    for (const path of ['/', '/pages', '/pages/main/state']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Unauthorized');
    }
  });

  it('returns 401 with a wrong token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer token (health shape unchanged)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wsEndpoint: string; browserReady: boolean };
    expect(body.wsEndpoint).toBe('');
    expect(body.browserReady).toBe(false);
  });

  it('rejects any Origin-bearing request with 403 (browser UI must not call this API directly)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });

  it('OPTIONS without a token is also 401 (no anonymous CORS preflight)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/pages`, { method: 'OPTIONS' });
    expect(res.status).toBe(401);
  });
});

describe('ephemeral CDP port launch (Phase 3 M1 §5.3, real Chromium)', () => {
  it('launches with --remote-debugging-port=0, discovers the OS-assigned port, and connects via CDP', async () => {
    const getRes = await fetch(`http://127.0.0.1:${server.port}/pages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 't2-ephemeral-probe' }),
    });
    expect(getRes.status).toBe(200);
    const info = (await getRes.json()) as { wsEndpoint: string; targetId: string };
    // The CDP endpoint is loopback-only and NOT the removed fixed port 9225.
    const endpoint = new URL(info.wsEndpoint);
    expect(endpoint.hostname).toBe('127.0.0.1');
    const port = Number(endpoint.port);
    expect(Number.isFinite(port)).toBe(true);
    expect(port).not.toBe(9225);
    expect(port).toBeGreaterThan(0);
    expect(info.targetId).toBeTruthy();

    // MCP-client-equivalent: connectOverCDP against the returned endpoint.
    const browser = await chromium.connectOverCDP(info.wsEndpoint);
    const contexts = browser.contexts();
    expect(contexts.length).toBeGreaterThan(0);
    const page = contexts[0].pages()[0];
    expect(page).toBeTruthy();

    browser.close();
  }, 60_000);
});
