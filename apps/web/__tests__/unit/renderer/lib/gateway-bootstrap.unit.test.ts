/**
 * Regression tests for the Firefox startup failures (Phase 2):
 *
 *  1. "must be run inside the desktop app" when opening the URL manually —
 *     the session token travels in the fragment, but HashRouter treats
 *     '#token=...' as a route and rewrites it before the app can read it.
 *     bootstrapGatewayApi() must capture the token BEFORE the router runs.
 *  2. "Something went wrong" route-boundary crash + dead event stream —
 *     stores register window.accomplish subscriptions at module scope and
 *     silently no-op when the shim is not installed. The bootstrap must
 *     install the HTTP API as window.accomplish early.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapGatewayApi, reportClientError } from '@/lib/gateway-bootstrap';
import { readGatewayToken } from '@/lib/accomplish-http';

const TOKEN = 'bootstrap-test-token-1234567890';

describe('bootstrapGatewayApi', () => {
  const windowWithApi = window as unknown as { accomplish?: unknown };

  beforeEach(() => {
    delete windowWithApi.accomplish;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    delete windowWithApi.accomplish;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('captures the token from the launch fragment before HashRouter rewrites it', () => {
    window.location.hash = `#token=${TOKEN}`;
    const api = bootstrapGatewayApi();
    expect(api).not.toBeNull();
    // The token was consumed from the fragment — the hash no longer holds it,
    // so HashRouter will never parse a bogus '/token=...' route.
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem('accomplish.gateway-token')).toBe(TOKEN);
  });

  it('installs the API as window.accomplish so module-scope store subscriptions register', () => {
    window.location.hash = `#token=${TOKEN}`;
    bootstrapGatewayApi();
    expect(typeof windowWithApi.accomplish?.listTasks).toBe('function');
    expect(typeof windowWithApi.accomplish?.onTaskUpdate).toBe('function');
    expect(typeof windowWithApi.accomplish?.onDaemonReconnected).toBe('function');
  });

  it('never shadows the Electron preload bridge', () => {
    const electronApi = { listTasks: vi.fn() };
    windowWithApi.accomplish = electronApi;
    expect(bootstrapGatewayApi()).toBe(electronApi);
  });

  it('is a no-op without a token (plain web/dev origins keep the classic error)', () => {
    expect(bootstrapGatewayApi()).toBeNull();
    expect(windowWithApi.accomplish).toBeUndefined();
  });

  it('is idempotent across calls (one install per session)', () => {
    window.location.hash = `#token=${TOKEN}`;
    const first = bootstrapGatewayApi();
    const second = bootstrapGatewayApi();
    expect(second).toBe(first);
  });
});

describe('reportClientError', () => {
  const windowWithApi = window as unknown as { accomplish?: unknown };
  const savedFetch = globalThis.fetch;

  beforeEach(() => {
    delete windowWithApi.accomplish;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    delete windowWithApi.accomplish;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('forwards errors to /client-log with the bearer token', async () => {
    const fetchMock = vi.fn(async () => new Response('{"recorded":true}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    window.location.hash = `#token=${TOKEN}`;
    bootstrapGatewayApi();
    reportClientError('Something exploded', { stack: 'at foo' });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toContain('/client-log');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    const body = JSON.parse(String(init.body)) as { level: string; message: string };
    expect(body.level).toBe('error');
    expect(body.message).toBe('Something exploded');
  });

  it('does nothing without a boot token — and never throws', () => {
    expect(() => reportClientError('orphan error')).not.toThrow();
  });

  it('survives fetch failures without crashing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    window.location.hash = `#token=${TOKEN}`;
    bootstrapGatewayApi();
    expect(() => reportClientError('boom')).not.toThrow();
  });
});

describe('token fragment handling regression', () => {
  it('a second page load uses sessionStorage (fragment already stripped)', () => {
    window.sessionStorage.setItem('accomplish.gateway-token', TOKEN);
    expect(readGatewayToken()).toBe(TOKEN);
    const api = bootstrapGatewayApi();
    expect(api).not.toBeNull();
  });
});
