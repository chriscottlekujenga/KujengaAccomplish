/**
 * Unit tests for the HTTP gateway shim (Firefox migration Phase 1).
 *
 * Covers token bootstrap (URL fragment → sessionStorage, hash stripped),
 * loopback-origin gating, the JSON-RPC transport, the AccomplishAPI surface
 * (implemented methods + loud not-supported stubs), event mapping, and the
 * getAccomplish() fallback chain that preserves Electron behaviour.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GatewayEventStream,
  HttpShimNotSupportedError,
  HttpTransport,
  createHttpAccomplishApi,
  isHttpGatewayAvailable,
  isLoopbackHttpOrigin,
  readGatewayToken,
  tryCreateHttpAccomplishApi,
  type GatewaySocket,
} from '@/lib/accomplish-http';

const TEST_TOKEN = 'unit-test-gateway-token-1234567890';

class FakeEventStream {
  handlers = new Map<string, Set<(params: unknown) => void>>();
  controls = new Map<string, Set<() => void>>();

  onNotification(method: string, callback: (params: unknown) => void): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(callback);
    this.handlers.set(method, set);
    return () => {
      set.delete(callback);
    };
  }

  onControlEvent(event: string, callback: () => void): () => void {
    const set = this.controls.get(event) ?? new Set();
    set.add(callback);
    this.controls.set(event, set);
    return () => {
      set.delete(callback);
    };
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.handlers.get(method) ?? []) {
      handler(params);
    }
  }

  emitControl(event: string): void {
    for (const handler of this.controls.get(event) ?? []) {
      handler();
    }
  }
}

describe('token bootstrap', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('reads the token from the launch fragment, persists it, and strips the hash', () => {
    window.location.hash = `#token=${TEST_TOKEN}`;
    expect(readGatewayToken()).toBe(TEST_TOKEN);
    expect(window.sessionStorage.getItem('accomplish.gateway-token')).toBe(TEST_TOKEN);
    expect(window.location.hash).toBe('');
  });

  it('falls back to sessionStorage on later loads (no fragment)', () => {
    window.sessionStorage.setItem('accomplish.gateway-token', TEST_TOKEN);
    expect(readGatewayToken()).toBe(TEST_TOKEN);
  });

  it('returns null when no token is available', () => {
    expect(readGatewayToken()).toBeNull();
  });

  it('rejects malformed tokens instead of adopting them', () => {
    window.location.hash = '#token=short';
    expect(readGatewayToken()).toBeNull();
    window.location.hash = '#token=<script>alert(1)</script>';
    expect(readGatewayToken()).toBeNull();
  });
});

describe('isLoopbackHttpOrigin', () => {
  it('accepts loopback http origins', () => {
    expect(isLoopbackHttpOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isLoopbackHttpOrigin('http://localhost:8080')).toBe(true);
  });

  it('rejects https and non-loopback origins', () => {
    expect(isLoopbackHttpOrigin('https://127.0.0.1:8443')).toBe(false);
    expect(isLoopbackHttpOrigin('http://evil.example.com')).toBe(false);
    expect(isLoopbackHttpOrigin('not a url')).toBe(false);
  });
});

describe('HttpTransport', () => {
  function makeTransport(fetchImpl: typeof fetch): HttpTransport {
    return new HttpTransport({ baseUrl: 'http://127.0.0.1:8123', token: TEST_TOKEN, fetchImpl });
  }

  it('posts JSON-RPC requests with the bearer token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'ok' } }), {
          status: 200,
        }),
    );
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);
    const result = await transport.call('daemon.ping');
    expect(result).toEqual({ status: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8123/rpc');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TEST_TOKEN}` });
    const body = JSON.parse(String(init.body)) as { method: string; params?: unknown };
    expect(body.method).toBe('daemon.ping');
  });

  it('throws GatewayRpcError on JSON-RPC error bodies', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'denied' } }),
          { status: 200 },
        ),
    );
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);
    await expect(transport.call('secrets.getApiKey')).rejects.toThrow(/denied/);
  });

  it('throws GatewayRpcError on HTTP-level rejections', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const transport = makeTransport(fetchImpl as unknown as typeof fetch);
    await expect(transport.call('task.list', {})).rejects.toThrow(/HTTP 401/);
  });
});

describe('GatewayEventStream', () => {
  it('authenticates on open and dispatches notifications', () => {
    const sent: string[] = [];
    const factory = (): GatewaySocket => ({
      send: (data) => {
        sent.push(data);
      },
      close: () => {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    });
    const stream = new GatewayEventStream({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      socketFactory: factory,
    });

    const received: unknown[] = [];
    stream.onNotification('task.message', (params) => {
      received.push(params);
    });

    const socket = (stream as unknown as { socket: GatewaySocket }).socket;
    socket.onopen?.();
    expect(JSON.parse(sent[0])).toEqual({ type: 'auth', token: TEST_TOKEN });

    socket.onmessage?.({ data: JSON.stringify({ type: 'auth-ok' }) });
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'notification',
        method: 'task.message',
        params: { taskId: 't1' },
      }),
    });
    expect(received).toEqual([{ taskId: 't1' }]);
    stream.close();
  });

  it('synthesizes daemon:disconnected when the socket drops after a session', async () => {
    const factory = (): GatewaySocket => ({
      send: () => {},
      close: () => {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    });
    const stream = new GatewayEventStream({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      socketFactory: factory,
      reconnectInitialMs: 10_000,
    });
    const disconnects: number[] = [];
    stream.onControlEvent('daemon:disconnected', () => {
      disconnects.push(Date.now());
    });

    const socket = (stream as unknown as { socket: GatewaySocket }).socket;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'auth-ok' }) });
    const before = disconnects.length;
    socket.onclose?.();
    expect(disconnects.length).toBe(before + 1);
    stream.close();
  });
});

describe('createHttpAccomplishApi', () => {
  let calls: { method: string; params?: unknown }[];
  let transport: HttpTransport;
  let events: FakeEventStream;

  beforeEach(() => {
    calls = [];
    events = new FakeEventStream();
    transport = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === 'task.list') {
          return [];
        }
        if (method === 'settings.getAll') {
          return {
            app: { theme: 'system', language: 'en', debugMode: false, onboardingComplete: false },
            notificationsEnabled: true,
            closeBehavior: 'keep-daemon',
          };
        }
        return null;
      },
      openExternal: async () => {},
      health: async () => ({ ok: true, version: '0.1.0', platform: 'linux' }),
    } as unknown as HttpTransport;
  });

  function makeApi() {
    return createHttpAccomplishApi({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      transport,
      events: events as unknown as GatewayEventStream,
    });
  }

  it('maps task methods onto RPC calls', async () => {
    const api = makeApi();
    await api.listTasks();
    expect(calls.at(-1)?.method).toBe('task.list');

    await api.startTask({ prompt: 'organize downloads' } as never);
    expect(calls.at(-1)).toEqual({
      method: 'task.start',
      params: { prompt: 'organize downloads' },
    });

    await api.cancelTask('tsk_1');
    expect(calls.at(-1)).toEqual({ method: 'task.cancel', params: { taskId: 'tsk_1' } });

    await api.respondToPermission({
      requestId: 'req_1',
      decision: 'allow',
    } as never);
    expect(calls.at(-1)?.method).toBe('permission.respond');
  });

  it('reads settings through the settings.getAll snapshot', async () => {
    const api = makeApi();
    await expect(api.getTheme()).resolves.toBe('system');
    await expect(api.getOnboardingComplete()).resolves.toBe(false);
    // Second read is served from cache — settings.getAll called once.
    await api.getLanguage();
    const getAllCalls = calls.filter((c) => c.method === 'settings.getAll').length;
    expect(getAllCalls).toBe(1);
  });

  it('maps workspace and scheduler methods', async () => {
    const api = makeApi();
    await api.switchWorkspace('ws_1');
    expect(calls.at(-1)?.method).toBe('workspace.setActive');
    await api.createSchedule('30 2 31 12 *', 'test prompt');
    expect(calls.at(-1)?.method).toBe('task.schedule');
    await api.listSchedules();
    expect(calls.at(-1)?.method).toBe('task.listScheduled');
  });

  it('throws a loud error for methods not yet implemented over HTTP', () => {
    const api = makeApi();
    expect(() => api.pickFolder()).toThrow(HttpShimNotSupportedError);
    expect(() => api.pickFolder()).toThrow(/pickFolder/);
    expect(() => (api as unknown as { daemonRestart: () => void }).daemonRestart()).toThrow(
      HttpShimNotSupportedError,
    );
  });

  it('makes analytics a safe no-op', async () => {
    const api = makeApi();
    await expect(api.analytics.trackPageView('/home')).resolves.toBeUndefined();
    await expect(api.analytics.trackTaskStart('t', 's', 'chat')).resolves.toBeUndefined();
  });

  it('keeps thenables away from the Proxy (await-safe)', async () => {
    const api = makeApi();
    const resolved = await Promise.resolve(api);
    expect(resolved).toBe(api);
  });

  it('maps daemon notifications to renderer callbacks', () => {
    const api = makeApi();
    const updates: unknown[] = [];
    api.onTaskUpdate((event) => {
      updates.push(event);
    });
    events.emit('task.complete', { taskId: 'tsk_1', result: { summary: 'done' } });
    events.emit('task.error', { taskId: 'tsk_1', error: 'boom' });
    expect(updates).toEqual([
      { taskId: 'tsk_1', type: 'complete', result: { summary: 'done' } },
      { taskId: 'tsk_1', type: 'error', error: 'boom' },
    ]);

    const themes: unknown[] = [];
    api.onThemeChange?.((data) => {
      themes.push(data);
    });
    events.emit('settings.changed', { key: 'theme', value: 'dark' });
    events.emit('settings.changed', { key: 'debugMode', value: true });
    expect(themes).toEqual([{ theme: 'dark', resolved: 'dark' }]);

    let disconnected = 0;
    api.onDaemonDisconnected(() => {
      disconnected++;
    });
    events.emitControl('daemon:disconnected');
    expect(disconnected).toBe(1);
  });

  it('returns working unsubscribe functions for event subscriptions', () => {
    const api = makeApi();
    const seen: unknown[] = [];
    const unsubscribe = api.onTaskProgress((progress) => {
      seen.push(progress);
    });
    events.emit('task.progress', { taskId: 'tsk_1' });
    unsubscribe();
    events.emit('task.progress', { taskId: 'tsk_2' });
    expect(seen).toEqual([{ taskId: 'tsk_1' }]);
  });
});

describe('getAccomplish fallback chain', () => {
  // The web test setup installs a global window.accomplish mock for the
  // Electron path; these tests exercise the gateway fallback, so it is
  // removed for the duration and restored afterwards.
  const windowWithApi = window as unknown as { accomplish?: unknown };
  let savedAccomplish: unknown;
  let savedShell: unknown;

  beforeEach(() => {
    savedAccomplish = windowWithApi.accomplish;
    savedShell = (window as unknown as { accomplishShell?: unknown }).accomplishShell;
    delete windowWithApi.accomplish;
    delete (window as unknown as { accomplishShell?: unknown }).accomplishShell;
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    windowWithApi.accomplish = savedAccomplish;
    (window as unknown as { accomplishShell?: unknown }).accomplishShell = savedShell;
  });

  it('is unavailable without a gateway token (preserves the classic error)', async () => {
    expect(isHttpGatewayAvailable()).toBe(false);
    expect(tryCreateHttpAccomplishApi()).toBeNull();
    const { getAccomplish } = await import('@/lib/accomplish');
    expect(() => getAccomplish()).toThrow('Accomplish API not available - not running in Electron');
  });

  it('builds an HTTP-backed API when a token is present on a loopback origin', async () => {
    window.sessionStorage.setItem('accomplish.gateway-token', TEST_TOKEN);
    expect(isHttpGatewayAvailable()).toBe(true);
    const { getAccomplish, hasShellApiAccess } = await import('@/lib/accomplish');
    const api = getAccomplish();
    expect(typeof api.listTasks).toBe('function');
    expect(hasShellApiAccess()).toBe(true);
  });

  it('prefers the Electron bridge when window.accomplish exists', async () => {
    window.sessionStorage.setItem('accomplish.gateway-token', TEST_TOKEN);
    const mockApi = { listTasks: vi.fn(async () => []) };
    (window as unknown as { accomplish: unknown }).accomplish = mockApi;
    try {
      const { getAccomplish } = await import('@/lib/accomplish');
      const api = getAccomplish();
      // The Electron path returns the spread wrapper delegating to the bridge.
      await api.listTasks();
      expect(mockApi.listTasks).toHaveBeenCalled();
    } finally {
      delete (window as unknown as { accomplish?: unknown }).accomplish;
    }
  });
});
