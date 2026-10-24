/**
 * Unit tests for the HTTP gateway shim (Firefox migration Phase 1).
 *
 * Covers token bootstrap (URL fragment → sessionStorage, hash stripped),
 * loopback-origin gating, the JSON-RPC transport, the AccomplishAPI surface
 * (implemented methods + loud not-supported stubs), event mapping, and the
 * getAccomplish() fallback chain that preserves Electron behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  controls = new Map<string, Set<(params?: unknown) => void>>();

  onNotification(method: string, callback: (params: unknown) => void): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(callback);
    this.handlers.set(method, set);
    return () => {
      set.delete(callback);
    };
  }

  onControlEvent(event: string, callback: (params?: unknown) => void): () => void {
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

  emitControl(event: string, params?: unknown): void {
    for (const handler of this.controls.get(event) ?? []) {
      handler(params);
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
      pickFolder: async () => '/home/chris/Documents',
      pickFiles: async () => [
        {
          id: 'u1',
          name: 'a.md',
          path: '/home/chris/a.md',
          type: 'text',
          size: 3,
          content: 'hi\n',
        },
      ],
      health: async () => ({ ok: true, version: '0.1.0', platform: 'linux' }),
      clientLog: vi.fn(async () => undefined),
      cliStatus: vi.fn(async () => ({
        installed: true,
        version: '1.14.18',
        installCommand: 'npm i -g opencode-ai',
      })),
      autostartStatus: vi.fn(async () => ({ enabled: true, active: true })),
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
    expect(() => api.getDaemonSocketPath()).toThrow(HttpShimNotSupportedError);
    expect(() => api.getDaemonSocketPath()).toThrow(/getDaemonSocketPath/);
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

  it('supports native pickers through the gateway', async () => {
    const api = makeApi();
    await expect(api.pickFolder()).resolves.toBe('/home/chris/Documents');
    const files = (await api.pickFiles()) as Array<{ name: string }>;
    expect(files.map((f) => f.name)).toEqual(['a.md']);
  });

  it('stores API keys one-way (secrets.storeApiKey)', async () => {
    const api = makeApi();
    await api.addApiKey('custom', 'test-key-xyz', 'Dev');
    expect(calls.at(-1)).toEqual({
      method: 'secrets.storeApiKey',
      params: { provider: 'custom', apiKey: 'test-key-xyz' },
    });
    await api.hasApiKey();
    expect(calls.at(-1)?.method).toBe('secrets.hasAnyApiKey');
  });

  it('routes accomplish:// MCP deep-link callbacks to onMcpAuthCallback', () => {
    const api = makeApi();
    const urls: string[] = [];
    api.onMcpAuthCallback?.((url) => {
      urls.push(url);
    });
    events.emitControl('mcp-callback', { url: 'accomplish://callback/mcp?state=9' });
    expect(urls).toEqual(['accomplish://callback/mcp?state=9']);
  });

  it('implements the boot-path provider/settings surface without throwing', async () => {
    const api = makeApi();
    await expect(api.getProviderSettings()).resolves.toEqual(null);
    await expect(api.getEnabledSkills()).resolves.toEqual(null);
    await expect(api.checkOpenCodeCli()).resolves.toMatchObject({ installed: true });
    await expect(api.getOpenCodeVersion()).resolves.toBe('1.14.18');
    await expect(api.speechIsConfigured()).resolves.toBe(false);
    await expect(api.getBuildCapabilities()).resolves.toEqual({
      hasFreeMode: false,
      hasAnalytics: false,
    });
    await expect(api.isAutoStartEnabled()).resolves.toBe(true);
  });

  it('forwards logEvent entries to the client-log channel', async () => {
    const api = makeApi();
    await api.logEvent({ level: 'warn', message: 'test event', context: { page: 'home' } });
    expect(transport.clientLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: 'test event' }),
    );
  });

  it('implements the close-confirm flow so CloseConfirmDialog boots without crashing', () => {
    // Regression: the Phase 2 startup crash — the throwing stub made
    // optional methods truthy functions, defeating the app's presence
    // guards (CloseConfirmDialog → RouteErrorFallback "Something went wrong").
    const api = makeApi();
    expect(api.onCloseRequested).toBeTypeOf('function');
    const unsubscribe = api.onCloseRequested?.(() => {});
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe?.()).not.toThrow();
    expect(() => api.respondToClose?.('keep-daemon')).not.toThrow();
  });

  it('reports unimplemented OPTIONAL methods as absent (undefined), not throwing functions', () => {
    const api = makeApi() as unknown as Record<string, unknown>;
    // Phase 3 M2 T4 implemented the four browser-preview poll methods (they
    // are now real shim methods, tested below); the remaining optional
    // methods stay absent.
    expect(api.onBrowserNavigate).toBeUndefined();
    expect(api.onBrowserStatus).toBeUndefined();
    expect(api.onWorkspaceDeleted).toBeUndefined();
    expect(api.gws).toBeUndefined();
  });

  it('keeps REQUIRED unknown methods loud with actionable diagnostics', () => {
    const api = makeApi() as unknown as Record<string, () => unknown>;
    expect(() => api.daemonRestart()).toThrow(HttpShimNotSupportedError);
    expect(() => api.captureScreenshot()).toThrow(/captureScreenshot/);
  });
});

describe('M2 T1b provider/model-management shim (accomplish-http)', () => {
  let calls: { method: string; params?: unknown }[];
  let responses: Map<string, unknown>;
  let transport: HttpTransport;

  beforeEach(() => {
    calls = [];
    responses = new Map();
    transport = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === 'settings.getAll') {
          return {
            app: { theme: 'system', language: 'en', debugMode: false, onboardingComplete: false },
            notificationsEnabled: true,
            closeBehavior: 'keep-daemon',
          };
        }
        if (method === 'provider.getSettings') {
          return responses.get(method) ?? { connectedProviders: {} };
        }
        return responses.get(method) ?? null;
      },
      openExternal: async () => {},
      health: async () => ({ ok: true, version: '0.1.0', platform: 'linux' }),
      clientLog: vi.fn(async () => undefined),
      cliStatus: async () => ({
        installed: true,
        version: '1.14.18',
        installCommand: 'npm i -g opencode-ai',
      }),
      autostartStatus: async () => ({ enabled: false, active: false }),
      pickFolder: async () => null,
      pickFiles: async () => [],
    } as unknown as HttpTransport;
  });

  function makeApi() {
    return createHttpAccomplishApi({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      transport,
      events: new FakeEventStream() as unknown as GatewayEventStream,
    });
  }

  const lastCall = (): { method: string; params?: unknown } => {
    const last = calls.at(-1);
    if (!last) {
      throw new Error('no RPC call recorded');
    }
    return last;
  };

  /** In refetch-asserting tests the recorded tail is [write, refetch] — the
   *  write is the call before the final getAppSettings refetch. */
  const writeBeforeRefetch = (): { method: string; params?: unknown } => {
    const write = calls.at(-2);
    if (!write) {
      throw new Error('no write call recorded');
    }
    return write;
  };

  /** Write methods must invalidate the settings snapshot cache: after the
   *  write, the next getAppSettings() refetches settings.getAll. */
  async function expectSettingsRefetch(
    writer: (api: ReturnType<typeof makeApi>) => Promise<void>,
  ): Promise<void> {
    const api = makeApi();
    await api.getAppSettings();
    const before = calls.filter((c) => c.method === 'settings.getAll').length;
    await writer(api);
    await api.getAppSettings();
    const after = calls.filter((c) => c.method === 'settings.getAll').length;
    expect(after).toBe(before + 1);
  }

  // ── A. provider-configs ────────────────────────────────────────────────

  it('getOpenAiBaseUrl reads the daemon setting', async () => {
    responses.set('settings.getOpenAiBaseUrl', 'https://proxy.example.com/v1');
    const api = makeApi();
    await expect(api.getOpenAiBaseUrl()).resolves.toBe('https://proxy.example.com/v1');
    expect(lastCall()).toEqual({ method: 'settings.getOpenAiBaseUrl', params: undefined });
  });

  it('setOpenAiBaseUrl writes through settings and invalidates the cache', async () => {
    await expectSettingsRefetch((api) => api.setOpenAiBaseUrl('https://new.example.com/v1'));
    expect(writeBeforeRefetch()).toEqual({
      method: 'settings.setOpenAiBaseUrl',
      params: { baseUrl: 'https://new.example.com/v1' },
    });
  });

  it('getOllamaConfig passes the daemon config shape through', async () => {
    const config = { baseUrl: 'http://127.0.0.1:11434', enabled: true, models: [] };
    responses.set('settings.getOllamaConfig', config);
    const api = makeApi();
    await expect(api.getOllamaConfig()).resolves.toEqual(config);
    expect(lastCall()).toEqual({ method: 'settings.getOllamaConfig', params: undefined });
  });

  it('setOllamaConfig writes the config and invalidates the cache', async () => {
    const config = { baseUrl: 'http://127.0.0.1:11434', enabled: true };
    const api = makeApi();
    await api.setOllamaConfig(config as never);
    expect(lastCall()).toEqual({ method: 'settings.setOllamaConfig', params: { config } });
    await expectSettingsRefetch((api) => api.setOllamaConfig(null));
    expect(writeBeforeRefetch()).toEqual({
      method: 'settings.setOllamaConfig',
      params: { config: null },
    });
  });

  it('getLiteLLMConfig passes the daemon config shape through', async () => {
    const config = { baseUrl: 'http://127.0.0.1:4000', enabled: true, models: [] };
    responses.set('settings.getLiteLLMConfig', config);
    const api = makeApi();
    await expect(api.getLiteLLMConfig()).resolves.toEqual(config);
    expect(lastCall()).toEqual({ method: 'settings.getLiteLLMConfig', params: undefined });
  });

  it('setLiteLLMConfig writes the config and invalidates the cache', async () => {
    const config = { baseUrl: 'http://127.0.0.1:4000', enabled: true };
    const api = makeApi();
    await api.setLiteLLMConfig(config as never);
    expect(lastCall()).toEqual({ method: 'settings.setLiteLLMConfig', params: { config } });
    await expectSettingsRefetch((api) => api.setLiteLLMConfig(null));
    expect(writeBeforeRefetch()).toEqual({
      method: 'settings.setLiteLLMConfig',
      params: { config: null },
    });
  });

  it('getLMStudioConfig passes the daemon config shape through', async () => {
    const config = { baseUrl: 'http://127.0.0.1:1234', enabled: true };
    responses.set('settings.getLMStudioConfig', config);
    const api = makeApi();
    await expect(api.getLMStudioConfig()).resolves.toEqual(config);
    expect(lastCall()).toEqual({ method: 'settings.getLMStudioConfig', params: undefined });
  });

  it('setLMStudioConfig writes the config and invalidates the cache', async () => {
    const config = { baseUrl: 'http://127.0.0.1:1234', enabled: true };
    const api = makeApi();
    await api.setLMStudioConfig(config as never);
    expect(lastCall()).toEqual({ method: 'settings.setLMStudioConfig', params: { config } });
    await expectSettingsRefetch((api) => api.setLMStudioConfig(null));
    expect(writeBeforeRefetch()).toEqual({
      method: 'settings.setLMStudioConfig',
      params: { config: null },
    });
  });

  it('getAzureFoundryConfig passes the daemon config shape through', async () => {
    const config = {
      baseUrl: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'api-key',
      enabled: true,
    };
    responses.set('settings.getAzureFoundryConfig', config);
    const api = makeApi();
    await expect(api.getAzureFoundryConfig()).resolves.toEqual(config);
    expect(lastCall()).toEqual({ method: 'settings.getAzureFoundryConfig', params: undefined });
  });

  it('setAzureFoundryConfig (direct setter) passes the config through and invalidates', async () => {
    const config = {
      baseUrl: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'entra-id',
      enabled: true,
    };
    const api = makeApi();
    await api.setAzureFoundryConfig(config as never);
    expect(lastCall()).toEqual({ method: 'settings.setAzureFoundryConfig', params: { config } });
    await expectSettingsRefetch((api) => api.setAzureFoundryConfig(null));
    expect(writeBeforeRefetch()).toEqual({
      method: 'settings.setAzureFoundryConfig',
      params: { config: null },
    });
  });

  // ── B. model-discovery ─────────────────────────────────────────────────

  it('testOllamaConnection maps to provider.testConnection with the ollama id', async () => {
    responses.set('provider.testConnection', { success: true, models: [] });
    const api = makeApi();
    await expect(api.testOllamaConnection('http://127.0.0.1:11434')).resolves.toEqual({
      success: true,
      models: [],
    });
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: { providerId: 'ollama', url: 'http://127.0.0.1:11434' },
    });
  });

  it('testLiteLLMConnection sends the key only when provided', async () => {
    responses.set('provider.testConnection', { success: true, models: [] });
    const api = makeApi();
    await api.testLiteLLMConnection('http://127.0.0.1:4000', 'litellm-key-1');
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: { providerId: 'litellm', url: 'http://127.0.0.1:4000', apiKey: 'litellm-key-1' },
    });
    await api.testLiteLLMConnection('http://127.0.0.1:4000');
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: { providerId: 'litellm', url: 'http://127.0.0.1:4000' },
    });
  });

  it('testLMStudioConnection maps to provider.testConnection with the lmstudio id', async () => {
    const api = makeApi();
    await api.testLMStudioConnection('http://127.0.0.1:1234');
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: { providerId: 'lmstudio', url: 'http://127.0.0.1:1234' },
    });
  });

  it('testNimConnection maps to provider.testConnection with the pre-store key', async () => {
    responses.set('provider.testConnection', { success: true, models: [] });
    const api = makeApi();
    await expect(
      api.testNimConnection('https://integrate.api.nvidia.com/v1', 'nim-key-1'),
    ).resolves.toEqual({ success: true, models: [] });
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: {
        providerId: 'nim',
        url: 'https://integrate.api.nvidia.com/v1',
        apiKey: 'nim-key-1',
      },
    });
  });

  it('testCustomConnection omits the apiKey key when the flow has none', async () => {
    responses.set('provider.testConnection', { success: true });
    const api = makeApi();
    await api.testCustomConnection('http://127.0.0.1:8080/v1', 'custom-key-1');
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: { providerId: 'custom', url: 'http://127.0.0.1:8080/v1', apiKey: 'custom-key-1' },
    });
    await api.testCustomConnection('http://127.0.0.1:8080/v1');
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: { providerId: 'custom', url: 'http://127.0.0.1:8080/v1' },
    });
  });

  it('testAzureFoundryConnection maps the full azure-foundry option set', async () => {
    responses.set('provider.testConnection', { success: true });
    const api = makeApi();
    await api.testAzureFoundryConnection({
      endpoint: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'api-key',
      apiKey: 'az-key-1',
    });
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: {
        providerId: 'azure-foundry',
        endpoint: 'https://foundry.example.com',
        deploymentName: 'gpt-4o',
        authType: 'api-key',
        apiKey: 'az-key-1',
      },
    });
    await api.testAzureFoundryConnection({
      endpoint: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'entra-id',
    });
    expect(lastCall()).toEqual({
      method: 'provider.testConnection',
      params: {
        providerId: 'azure-foundry',
        endpoint: 'https://foundry.example.com',
        deploymentName: 'gpt-4o',
        authType: 'entra-id',
      },
    });
  });

  it('saveAzureFoundryConfig sends the exact 2-call save sequence desktop does', async () => {
    const api = makeApi();
    await api.saveAzureFoundryConfig({
      endpoint: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'api-key',
      apiKey: 'az-key-1',
    });
    expect(calls.slice(-2)).toEqual([
      {
        method: 'secrets.storeApiKey',
        params: { provider: 'azure-foundry', apiKey: 'az-key-1' },
      },
      {
        method: 'settings.setAzureFoundryConfig',
        params: {
          config: {
            baseUrl: 'https://foundry.example.com',
            deploymentName: 'gpt-4o',
            authType: 'api-key',
            enabled: true,
            lastValidated: expect.any(Number),
          },
        },
      },
    ]);
  });

  it('saveAzureFoundryConfig skips the key store when authType is entra-id', async () => {
    const api = makeApi();
    await api.saveAzureFoundryConfig({
      endpoint: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'entra-id',
    });
    expect(lastCall()).toEqual({
      method: 'settings.setAzureFoundryConfig',
      params: {
        config: {
          baseUrl: 'https://foundry.example.com',
          deploymentName: 'gpt-4o',
          authType: 'entra-id',
          enabled: true,
          lastValidated: expect.any(Number),
        },
      },
    });
    expect(calls.some((c) => c.method === 'secrets.storeApiKey')).toBe(false);
  });

  it('saveAzureFoundryConfig validates endpoint/deploymentName/authType at the boundary', async () => {
    const api = makeApi();
    await expect(
      api.saveAzureFoundryConfig({
        endpoint: ' ',
        deploymentName: 'gpt-4o',
        authType: 'api-key',
      }),
    ).rejects.toThrow(/endpoint is required/);
    await expect(
      api.saveAzureFoundryConfig({
        endpoint: 'https://foundry.example.com',
        deploymentName: ' ',
        authType: 'api-key',
      }),
    ).rejects.toThrow(/deploymentName is required/);
    await expect(
      api.saveAzureFoundryConfig({
        endpoint: 'https://foundry.example.com',
        deploymentName: 'gpt-4o',
        authType: 'bogus' as never,
      }),
    ).rejects.toThrow(/authType must be api-key or entra-id/);
    await expect(
      api.saveAzureFoundryConfig({
        endpoint: 'not a url',
        deploymentName: 'gpt-4o',
        authType: 'api-key',
      }),
    ).rejects.toThrow(/Invalid endpoint URL format/);
    expect(calls).toEqual([]);
  });

  it('saveAzureFoundryConfig invalidates the settings cache after the config write', async () => {
    await expectSettingsRefetch((api) =>
      api.saveAzureFoundryConfig({
        endpoint: 'https://foundry.example.com',
        deploymentName: 'gpt-4o',
        authType: 'entra-id',
      }),
    );
  });

  it('fetchProviderModels passes the provider id and options through', async () => {
    responses.set('provider.fetchModels', { success: true, models: [{ id: 'm1', name: 'M1' }] });
    const api = makeApi();
    await api.fetchProviderModels('zai', { zaiRegion: 'international' });
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'zai', options: { zaiRegion: 'international' } },
    });
    await api.fetchProviderModels('openai');
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'openai' },
    });
  });

  it('fetchOpenRouterModels targets the openrouter model list without options', async () => {
    responses.set('provider.fetchModels', {
      success: true,
      models: [{ id: 'or/m', name: 'M', provider: 'openrouter', contextLength: 8192 }],
    });
    const api = makeApi();
    await expect(api.fetchOpenRouterModels()).resolves.toEqual({
      success: true,
      models: [{ id: 'or/m', name: 'M', provider: 'openrouter', contextLength: 8192 }],
    });
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'openrouter' },
    });
  });

  it('fetchLiteLLMModels targets the daemon-side litellm config + stored key', async () => {
    responses.set('provider.fetchModels', { success: true, models: [] });
    const api = makeApi();
    await expect(api.fetchLiteLLMModels()).resolves.toEqual({ success: true, models: [] });
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'litellm' },
    });
  });

  it('fetchLMStudioModels targets the daemon-side lmstudio config', async () => {
    const api = makeApi();
    await api.fetchLMStudioModels();
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'lmstudio' },
    });
  });

  it('fetchNimModels targets the daemon-side nim config + stored key', async () => {
    const api = makeApi();
    await api.fetchNimModels();
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'nim' },
    });
  });

  it('fetchBedrockModels uses stored credentials daemon-side and normalizes models to an array', async () => {
    const credentialsJson = JSON.stringify({ authType: 'apiKey', apiKey: 'br-key' });
    responses.set('provider.fetchModels', {
      success: true,
      models: [{ id: 'anthropic.claude', name: 'Claude', provider: 'bedrock' }],
    });
    const api = makeApi();
    const result = await api.fetchBedrockModels(credentialsJson);
    expect(result).toEqual({
      success: true,
      models: [{ id: 'anthropic.claude', name: 'Claude', provider: 'bedrock' }],
    });
    // The credentials argument must NOT travel — the daemon resolves its
    // stored copy; only the provider id goes on the wire.
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'bedrock' },
    });
  });

  it('fetchBedrockModels degrades a failed/absent fetch to models: [] + error', async () => {
    responses.set('provider.fetchModels', {
      success: false,
      error: 'No API key found for this provider',
    });
    const api = makeApi();
    await expect(api.fetchBedrockModels('{}')).resolves.toEqual({
      success: false,
      models: [],
      error: 'No API key found for this provider',
    });
    responses.set('provider.fetchModels', null);
    await expect(api.fetchBedrockModels('{}')).resolves.toEqual({
      success: false,
      models: [],
    });
  });

  it('fetchVertexModels uses stored credentials daemon-side and normalizes models to an array', async () => {
    responses.set('provider.fetchModels', {
      success: true,
      models: [{ id: 'vertex/google/gemini-2.5-pro', name: 'Gemini', provider: 'vertex' }],
    });
    const api = makeApi();
    const credentialsJson = JSON.stringify({ authType: 'adc', projectId: 'p', location: 'global' });
    await expect(api.fetchVertexModels(credentialsJson)).resolves.toEqual({
      success: true,
      models: [{ id: 'vertex/google/gemini-2.5-pro', name: 'Gemini', provider: 'vertex' }],
    });
    expect(lastCall()).toEqual({
      method: 'provider.fetchModels',
      params: { providerId: 'vertex' },
    });
  });

  it('validateBedrockCredentials sends the credential document one-way to provider.validateCredentials', async () => {
    const document = { authType: 'apiKey', apiKey: 'br-key', region: 'us-east-1' };
    responses.set('provider.validateCredentials', { valid: true });
    const api = makeApi();
    await expect(api.validateBedrockCredentials(document as never)).resolves.toEqual({
      valid: true,
    });
    expect(lastCall()).toEqual({
      method: 'provider.validateCredentials',
      params: { providerId: 'bedrock', credentials: JSON.stringify(document) },
    });
  });

  it('validateVertexCredentials sends a verbatim JSON document one-way', async () => {
    const document = JSON.stringify({ authType: 'adc', projectId: 'p', location: 'global' });
    responses.set('provider.validateCredentials', { valid: false, error: 'denied' });
    const api = makeApi();
    await expect(api.validateVertexCredentials(document)).resolves.toEqual({
      valid: false,
      error: 'denied',
    });
    expect(lastCall()).toEqual({
      method: 'provider.validateCredentials',
      params: { providerId: 'vertex', credentials: document },
    });
  });

  // ── C. api-keys / secrets (masked reads + one-way writes) ──────────────

  it('getApiKeys maps the masked record to existing-only entries with prefixes', async () => {
    responses.set('secrets.listApiKeys', {
      anthropic: { exists: true, prefix: 'sk-a' },
      openai: { exists: false },
      litellm: { exists: true },
    });
    const api = makeApi();
    await expect(api.getApiKeys()).resolves.toEqual([
      { id: 'anthropic', provider: 'anthropic', exists: true, prefix: 'sk-a' },
      { id: 'litellm', provider: 'litellm', exists: true },
    ]);
    expect(lastCall()).toEqual({ method: 'secrets.listApiKeys', params: undefined });
  });

  it('getAllApiKeys returns the masked record shape verbatim', async () => {
    const masked = {
      anthropic: { exists: true, prefix: 'sk-a' },
      openai: { exists: false },
    };
    responses.set('secrets.listApiKeys', masked);
    const api = makeApi();
    await expect(api.getAllApiKeys()).resolves.toEqual(masked);
    expect(lastCall()).toEqual({ method: 'secrets.listApiKeys', params: undefined });
  });

  it('setApiKey stores under the desktop default provider (anthropic)', async () => {
    const api = makeApi();
    await api.setApiKey('sk-ant-newkey');
    expect(lastCall()).toEqual({
      method: 'secrets.storeApiKey',
      params: { provider: 'anthropic', apiKey: 'sk-ant-newkey' },
    });
  });

  it('removeApiKey deletes by provider id', async () => {
    const api = makeApi();
    await api.removeApiKey('litellm');
    expect(lastCall()).toEqual({
      method: 'secrets.deleteApiKey',
      params: { provider: 'litellm' },
    });
  });

  it('validateApiKey validates the desktop default provider key', async () => {
    responses.set('provider.validateKey', { valid: true });
    const api = makeApi();
    await expect(api.validateApiKey('sk-ant-valid')).resolves.toEqual({ valid: true });
    expect(lastCall()).toEqual({
      method: 'provider.validateKey',
      params: { providerId: 'anthropic', key: 'sk-ant-valid' },
    });
  });

  it('validateApiKeyForProvider passes the provider and options through', async () => {
    responses.set('provider.validateKey', { valid: true });
    const api = makeApi();
    await api.validateApiKeyForProvider('zai', 'zai-key-1', { zaiRegion: 'international' });
    expect(lastCall()).toEqual({
      method: 'provider.validateKey',
      params: { providerId: 'zai', key: 'zai-key-1', options: { zaiRegion: 'international' } },
    });
    await api.validateApiKeyForProvider('openrouter', 'or-key-1');
    expect(lastCall()).toEqual({
      method: 'provider.validateKey',
      params: { providerId: 'openrouter', key: 'or-key-1' },
    });
  });

  it('clearApiKey deletes only the default-provider key (desktop api-key:clear parity)', async () => {
    const api = makeApi();
    await api.clearApiKey();
    expect(lastCall()).toEqual({
      method: 'secrets.deleteApiKey',
      params: { provider: 'anthropic' },
    });
    expect(calls.some((c) => c.method === 'secrets.clear')).toBe(false);
  });

  // ── D. provider-settings writes ────────────────────────────────────────

  it('setActiveProvider passes a literal provider id or null and invalidates', async () => {
    await expectSettingsRefetch((api) => api.setActiveProvider('anthropic' as never));
    expect(writeBeforeRefetch()).toEqual({
      method: 'provider.setActive',
      params: { providerId: 'anthropic' },
    });
    const api = makeApi();
    await api.setActiveProvider(null);
    expect(lastCall()).toEqual({ method: 'provider.setActive', params: { providerId: null } });
  });

  it('getConnectedProvider derives from the masked provider.getSettings snapshot', async () => {
    const connected = { providerId: 'anthropic', connectionStatus: 'connected' };
    responses.set('provider.getSettings', {
      connectedProviders: { anthropic: connected },
    });
    const api = makeApi();
    await expect(api.getConnectedProvider('anthropic')).resolves.toEqual(connected);
    expect(lastCall()).toEqual({ method: 'provider.getSettings', params: undefined });
    await expect(api.getConnectedProvider('vertex')).resolves.toBeNull();
  });

  it('setConnectedProvider writes the connected provider one-way and invalidates', async () => {
    const provider = { providerId: 'anthropic', connectionStatus: 'connected' };
    await expectSettingsRefetch((api) => api.setConnectedProvider('anthropic', provider as never));
    expect(writeBeforeRefetch()).toEqual({
      method: 'provider.setConnected',
      params: { providerId: 'anthropic', provider },
    });
  });

  it('removeConnectedProvider deletes the connection entry and invalidates', async () => {
    await expectSettingsRefetch((api) => api.removeConnectedProvider('vertex' as never));
    expect(writeBeforeRefetch()).toEqual({
      method: 'provider.removeConnected',
      params: { providerId: 'vertex' },
    });
  });

  it('updateProviderModel writes the model id (null included) and invalidates', async () => {
    await expectSettingsRefetch((api) => api.updateProviderModel('openai' as never, 'o3' as never));
    expect(writeBeforeRefetch()).toEqual({
      method: 'provider.updateModel',
      params: { providerId: 'openai', modelId: 'o3' },
    });
    const api = makeApi();
    await api.updateProviderModel('openai' as never, null);
    expect(lastCall()).toEqual({
      method: 'provider.updateModel',
      params: { providerId: 'openai', modelId: null },
    });
  });

  it('set/getProviderDebugMode round-trip through the dedicated RPCs', async () => {
    responses.set('provider.getDebugMode', true);
    await expectSettingsRefetch((api) => api.setProviderDebugMode(true));
    expect(writeBeforeRefetch()).toEqual({
      method: 'provider.setDebugMode',
      params: { enabled: true },
    });
    const api = makeApi();
    await expect(api.getProviderDebugMode()).resolves.toBe(true);
    expect(lastCall()).toEqual({ method: 'provider.getDebugMode', params: undefined });
  });

  it('saveBedrockCredentials stores one-way and derives the desktop ApiKeyConfig locally', async () => {
    const api = makeApi();
    const credentials = { authType: 'apiKey', apiKey: 'br-live-key-1', region: 'us-east-1' };
    const result = (await api.saveBedrockCredentials(credentials as never)) as ApiKeyConfig;
    expect(lastCall()).toEqual({
      method: 'secrets.storeBedrockCredentials',
      params: { credentials: JSON.stringify(credentials) },
    });
    expect(result).toMatchObject({
      id: 'local-bedrock',
      provider: 'bedrock',
      label: 'Bedrock API Key',
      keyPrefix: 'br-live-...',
      isActive: true,
    });
  });

  it('saveBedrockCredentials maps accessKeys and profile labels/prefixes like desktop', async () => {
    const api = makeApi();
    const accessKeys = {
      authType: 'accessKeys',
      accessKeyId: 'AKIAIOSFODNN7',
      secretAccessKey: 's3cr3t',
    };
    const accessResult = (await api.saveBedrockCredentials(accessKeys as never)) as ApiKeyConfig;
    expect(accessResult).toMatchObject({ label: 'AWS Access Keys', keyPrefix: 'AKIAIOSF...' });
    const profile = { authType: 'profile', profileName: 'work-profile', region: 'us-east-1' };
    const profileResult = (await api.saveBedrockCredentials(profile as never)) as ApiKeyConfig;
    expect(profileResult).toMatchObject({
      label: 'AWS Profile: work-profile',
      keyPrefix: 'work-profile',
    });
  });

  it('saveBedrockCredentials rejects malformed documents like desktop without any RPC', async () => {
    const api = makeApi();
    await expect(
      api.saveBedrockCredentials({ authType: 'apiKey', apiKey: '' } as never),
    ).rejects.toThrow('API Key is required');
    await expect(
      api.saveBedrockCredentials({ authType: 'accessKeys', accessKeyId: 'x' } as never),
    ).rejects.toThrow('Access Key ID and Secret Access Key are required');
    await expect(
      api.saveBedrockCredentials({ authType: 'profile', profileName: '' } as never),
    ).rejects.toThrow('Profile name is required');
    await expect(api.saveBedrockCredentials({ authType: 'bogus' } as never)).rejects.toThrow(
      'Invalid authentication type',
    );
    expect(calls).toEqual([]);
  });

  it('saveVertexCredentials rides the standard api-key bucket and derives the desktop ApiKeyConfig', async () => {
    const api = makeApi();
    const credentials = {
      authType: 'serviceAccount',
      projectId: 'proj-1',
      location: 'global',
      serviceAccountJson: '{}',
    };
    const result = (await api.saveVertexCredentials(credentials as never)) as ApiKeyConfig;
    expect(lastCall()).toEqual({
      method: 'secrets.storeApiKey',
      params: { provider: 'vertex', apiKey: JSON.stringify(credentials) },
    });
    expect(result).toMatchObject({
      id: 'local-vertex',
      provider: 'vertex',
      label: 'Service Account',
      keyPrefix: 'proj-1 (global)',
      isActive: true,
    });
    const adc = { authType: 'adc', projectId: 'proj-2', location: 'us-central1' };
    const adcResult = (await api.saveVertexCredentials(adc as never)) as ApiKeyConfig;
    expect(adcResult).toMatchObject({ label: 'Application Default Credentials' });
  });

  it('saveVertexCredentials rejects malformed documents like desktop without any RPC', async () => {
    const api = makeApi();
    await expect(
      api.saveVertexCredentials({ authType: 'serviceAccount', location: 'global' } as never),
    ).rejects.toThrow('Project ID is required');
    await expect(
      api.saveVertexCredentials({ projectId: 'p', location: ' ' } as never),
    ).rejects.toThrow('Location is required');
    await expect(
      api.saveVertexCredentials({
        projectId: 'p',
        location: 'global',
        authType: 'serviceAccount',
        serviceAccountJson: ' ',
      } as never),
    ).rejects.toThrow('Service account JSON key is required');
    expect(calls).toEqual([]);
  });

  it('keeps plaintext credential reads and deferred HuggingFace config loud-throwers', () => {
    const api = makeApi() as unknown as Record<string, () => unknown>;
    for (const method of [
      'getApiKey',
      'getBedrockCredentials',
      'getVertexCredentials',
      'getHuggingFaceLocalConfig',
      'setHuggingFaceLocalConfig',
      'detectVertexProject',
      'listVertexProjects',
    ]) {
      expect(() => api[method]()).toThrow(HttpShimNotSupportedError);
      expect(() => api[method]()).toThrow(new RegExp(method));
    }
  });
});

describe('M2 T2 skills/connector CRUD shim (accomplish-http)', () => {
  let calls: { method: string; params?: unknown }[];
  let responses: Map<string, unknown>;
  let transport: HttpTransport;

  beforeEach(() => {
    calls = [];
    responses = new Map();
    transport = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return responses.get(method) ?? null;
      },
      openExternal: async () => {},
      pickFolder: vi.fn(async () => '/home/user/skills-dir'),
      pickFiles: async () => [],
      health: async () => ({ ok: true, version: '0.1.0', platform: 'linux' }),
      clientLog: vi.fn(async () => undefined),
      cliStatus: async () => ({
        installed: true,
        version: '1.14.18',
        installCommand: 'npm i -g opencode-ai',
      }),
      autostartStatus: async () => ({ enabled: false, active: false }),
    } as unknown as HttpTransport;
  });

  function makeApi() {
    return createHttpAccomplishApi({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      transport,
      events: new FakeEventStream() as unknown as GatewayEventStream,
    });
  }

  const lastCall = (): { method: string; params?: unknown } => {
    const last = calls.at(-1);
    if (!last) {
      throw new Error('no RPC call recorded');
    }
    return last;
  };

  describe('skills management', () => {
    it('getUserSkillsPath reads the daemon skills directory', async () => {
      responses.set('skills.getUserSkillsPath', '/home/user/.accomplish/skills');
      const api = makeApi();
      await expect(api.getUserSkillsPath()).resolves.toBe('/home/user/.accomplish/skills');
      expect(lastCall()).toEqual({ method: 'skills.getUserSkillsPath', params: undefined });
    });

    it('pickSkillFolder reuses the host zenity folder picker (no RPC)', async () => {
      const api = makeApi();
      await expect(api.pickSkillFolder()).resolves.toBe('/home/user/skills-dir');
      expect(transport.pickFolder).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([]);
    });

    it('addSkillFromFolder maps to skills.addFromPath { sourcePath }', async () => {
      const skill = { id: 's1', name: 'From Folder', source: 'custom' };
      responses.set('skills.addFromPath', skill);
      const api = makeApi();
      await expect(api.addSkillFromFolder('/home/user/my-skill')).resolves.toEqual(skill);
      expect(lastCall()).toEqual({
        method: 'skills.addFromPath',
        params: { sourcePath: '/home/user/my-skill' },
      });
    });

    it('addSkillFromGitHub maps to skills.addFromGitHub { rawUrl }', async () => {
      const skill = { id: 's2', name: 'GitHub Skill', source: 'community' };
      responses.set('skills.addFromGitHub', skill);
      const api = makeApi();
      await expect(api.addSkillFromGitHub('https://github.com/o/r/tree/main')).resolves.toEqual(
        skill,
      );
      expect(lastCall()).toEqual({
        method: 'skills.addFromGitHub',
        params: { rawUrl: 'https://github.com/o/r/tree/main' },
      });
    });

    it('deleteSkill maps to skills.delete { skillId }', async () => {
      const api = makeApi();
      await api.deleteSkill('s1');
      expect(lastCall()).toEqual({ method: 'skills.delete', params: { skillId: 's1' } });
    });

    it('setSkillEnabled sends skillId (daemon zod param, not the pre-T2 `id`)', async () => {
      const api = makeApi();
      await api.setSkillEnabled('s1', false);
      expect(lastCall()).toEqual({
        method: 'skills.setEnabled',
        params: { skillId: 's1', enabled: false },
      });
    });

    it('getSkillContent sends skillId (daemon zod param, not the pre-T2 `id`)', async () => {
      responses.set('skills.getContent', '# SKILL.md');
      const api = makeApi();
      await expect(api.getSkillContent('s1')).resolves.toBe('# SKILL.md');
      expect(lastCall()).toEqual({ method: 'skills.getContent', params: { skillId: 's1' } });
    });

    it('openSkillInEditor / showSkillInFolder stay loud not-supported (M2 degradation)', () => {
      const api = makeApi() as unknown as Record<string, () => unknown>;
      for (const method of ['openSkillInEditor', 'showSkillInFolder']) {
        expect(() => api[method]('/tmp/skill/SKILL.md')).toThrow(HttpShimNotSupportedError);
        expect(() => api[method]('/tmp/skill/SKILL.md')).toThrow(new RegExp(method));
      }
    });
  });

  describe('custom MCP connector CRUD', () => {
    it('getConnectors reads the connectors.list registry', async () => {
      const connectors = [
        { id: 'mcp-1', name: 'Linear', url: 'https://mcp.linear.app/sse', isEnabled: true },
      ];
      responses.set('connectors.list', connectors);
      const api = makeApi();
      await expect(api.getConnectors()).resolves.toEqual(connectors);
      expect(lastCall()).toEqual({ method: 'connectors.list', params: undefined });
    });

    it('addConnector sanitizes, builds the desktop McpConnector row, upserts it, and echoes it back', async () => {
      const api = makeApi();
      const created = (await api.addConnector(
        '  Linear MCP  ',
        '  https://mcp.linear.app/sse  ',
      )) as {
        id: string;
        name: string;
        url: string;
        status: string;
        isEnabled: boolean;
        createdAt: string;
        updatedAt: string;
      };
      expect(lastCall()).toEqual({
        method: 'connectors.upsert',
        params: { connector: created },
      });
      expect(created.id).toMatch(/^mcp-[a-z0-9]+-[a-z0-9]+$/);
      expect(created.name).toBe('Linear MCP');
      expect(created.url).toBe('https://mcp.linear.app/sse');
      expect(created.status).toBe('disconnected');
      expect(created.isEnabled).toBe(true);
      expect(created.createdAt).toBeTruthy();
      expect(created.updatedAt).toBe(created.createdAt);
      // No connectors.deleteTokens / setStatus side effects on plain add.
      expect(calls).toHaveLength(1);
    });

    it('addConnector rejects malformed and non-http(s) URLs before any RPC', async () => {
      const api = makeApi();
      for (const badUrl of ['not a url', 'file:///etc/passwd', 'ws://mcp.example.com']) {
        await expect(api.addConnector('x', badUrl)).rejects.toThrow(
          errMessageRe(badUrl === 'not a url' ? 'Invalid connector URL' : 'http'),
        );
      }
      expect(calls).toEqual([]);
    });

    it('addConnector length-guards name and url locally (sanitizeString)', async () => {
      const api = makeApi();
      await expect(api.addConnector('x'.repeat(129), 'https://mcp.example.com')).rejects.toThrow(
        /exceeds maximum length of 128/,
      );
      await expect(api.addConnector('ok', `https://${'a'.repeat(600)}.com`)).rejects.toThrow(
        /exceeds maximum length of 512/,
      );
      expect(calls).toEqual([]);
    });

    it('deleteConnector mirrors desktop connectors:delete — deleteTokens first, then the row delete', async () => {
      const api = makeApi();
      await api.deleteConnector('mcp-1');
      expect(calls).toEqual([
        { method: 'connectors.deleteTokens', params: { connectorId: 'mcp-1' } },
        { method: 'connectors.delete', params: { id: 'mcp-1' } },
      ]);
    });

    it('setConnectorEnabled maps to connectors.setEnabled { id, enabled }', async () => {
      const api = makeApi();
      await api.setConnectorEnabled('mcp-1', false);
      expect(lastCall()).toEqual({
        method: 'connectors.setEnabled',
        params: { id: 'mcp-1', enabled: false },
      });
    });

    it('disconnectConnector mirrors desktop: deleteTokens + setStatus(disconnected)', async () => {
      const api = makeApi();
      await api.disconnectConnector('mcp-1');
      expect(calls).toEqual([
        { method: 'connectors.deleteTokens', params: { connectorId: 'mcp-1' } },
        { method: 'connectors.setStatus', params: { id: 'mcp-1', status: 'disconnected' } },
      ]);
    });

    it('the M6-deferred OAuth family stays loud not-supported', () => {
      const api = makeApi() as unknown as Record<string, () => unknown>;
      for (const method of [
        'startConnectorOAuth',
        'completeConnectorOAuth',
        'getBuiltInConnectorAuthStatus',
        'loginBuiltInConnector',
        'logoutBuiltInConnector',
        'lightdashGetServerUrl',
        'lightdashSetServerUrl',
        'datadogGetServerUrl',
        'datadogSetServerUrl',
        'getOpenAiOauthStatus',
        'loginOpenAiWithChatGpt',
        'getSlackMcpOauthStatus',
        'loginSlackMcp',
        'logoutSlackMcp',
        'getCopilotOAuthStatus',
        'loginGithubCopilot',
        'logoutGithubCopilot',
      ]) {
        expect(() => api[method]()).toThrow(HttpShimNotSupportedError);
      }
    });
  });
});

// ── M2 T3: file attachments routed through the authorized host picker ───────

describe('M2 T3 file-attachment shim (accomplish-http)', () => {
  let transport: HttpTransport;
  let pickFiles: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pickFiles = vi.fn(async () => [
      {
        id: 'u1',
        name: 'a.md',
        path: '/home/chris/a.md',
        type: 'text',
        size: 3,
        content: 'hi\n',
      },
    ]);
    transport = {
      call: async () => null,
      openExternal: async () => {},
      pickFolder: async () => null,
      pickFiles,
      health: async () => ({ ok: true, version: '0.1.0', platform: 'linux' }),
      clientLog: vi.fn(async () => undefined),
      cliStatus: vi.fn(async () => ({
        installed: true,
        version: '1.14.18',
        installCommand: 'npm i -g opencode-ai',
      })),
      autostartStatus: vi.fn(async () => ({ enabled: false, active: false })),
    } as unknown as HttpTransport;
  });

  function makeApi() {
    return createHttpAccomplishApi({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      transport,
      events: new FakeEventStream() as unknown as GatewayEventStream,
    });
  }

  it('processDroppedFiles re-opens the authorized host /pick-files flow (paths argument is unusable off-Electron)', async () => {
    const api = makeApi();
    // The paths argument documents the desktop contract only: browser-dropped
    // File objects cannot reveal local paths, so the shim ignores it and
    // re-opens the authorized picker.
    const files = await api.processDroppedFiles(['/ignored', '/also-ignored']);
    expect(pickFiles).toHaveBeenCalledTimes(1);
    expect(pickFiles).toHaveBeenCalledWith();
    expect(files).toEqual([
      {
        id: 'u1',
        name: 'a.md',
        path: '/home/chris/a.md',
        type: 'text',
        size: 3,
        content: 'hi\n',
      },
    ]);
  });

  it('processDroppedFiles rows keep exact FileAttachmentInfo shape parity with /pick-files', async () => {
    const api = makeApi();
    const files = await api.processDroppedFiles([]);
    // Host /pick-files rows already carry every FileAttachmentInfo field
    // (id/name/path/type/size + optional content) — no shim normalization
    // added, so the returned keys must match the host contract 1:1 and no
    // synthetic fields (e.g. mimeType) sneak in.
    expect(Object.keys(files[0]).sort()).toEqual(['content', 'id', 'name', 'path', 'size', 'type']);
    expect(files[0].id).toBeTypeOf('string');
    expect(files[0].type).toBe('text');
    expect(files[0].size).toBeTypeOf('number');
  });

  it('processDroppedFiles surfaces picker cancel as an empty list', async () => {
    pickFiles.mockResolvedValue([]);
    const api = makeApi();
    await expect(api.processDroppedFiles([])).resolves.toEqual([]);
  });

  it('getFilePath stays a loud not-supported stub (never pretends a browser File has a path)', () => {
    const api = makeApi() as unknown as Record<string, (file: File) => string>;
    expect(() => api.getFilePath(new File([], 'dropped.txt'))).toThrow(HttpShimNotSupportedError);
    expect(() => api.getFilePath(new File([], 'dropped.txt'))).toThrow(errMessageRe('getFilePath'));
  });
});

// ── M2 T4: browser-preview on-demand screenshot v1 (shim-local poll) ────────

describe('M2 T4 browser-preview poll shim (accomplish-http)', () => {
  let calls: { method: string; params?: unknown }[];
  let responses: Map<string, unknown>;
  let callBehavior: null | ((method: string) => unknown);
  let clientLog: ReturnType<typeof vi.fn>;
  let transport: HttpTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    responses = new Map();
    callBehavior = null;
    clientLog = vi.fn(async () => undefined);
    transport = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (callBehavior) {
          return callBehavior(method);
        }
        return responses.get(method) ?? null;
      },
      openExternal: async () => {},
      pickFolder: async () => null,
      pickFiles: async () => [],
      health: async () => ({ ok: true, version: '0.1.0', platform: 'linux' }),
      clientLog,
      cliStatus: async () => ({ installed: true, version: '1', installCommand: '' }),
      autostartStatus: async () => ({ enabled: false, active: false }),
    } as unknown as HttpTransport;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeApi() {
    return createHttpAccomplishApi({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      transport,
      events: new FakeEventStream() as unknown as GatewayEventStream,
    });
  }

  const callCount = (method: string): number => calls.filter((c) => c.method === method).length;

  it('ensures the page exists first (openPreviewPage) and defaults pageName to main', async () => {
    const api = makeApi();
    await expect(api.startBrowserPreview?.('task-1')).resolves.toEqual({ success: true });
    expect(calls[0]).toEqual({
      method: 'devBrowser.openPreviewPage',
      params: { name: 'task-1-main', viewport: { width: 1280, height: 720 } },
    });
  });

  it('polls captureFrame (~750ms) and emits frames to onBrowserFrame subscribers', async () => {
    responses.set('devBrowser.captureFrame', { data: 'frame-A', width: 800, height: 600 });
    const api = makeApi();
    const frames: Array<Record<string, unknown>> = [];
    api.onBrowserFrame?.((event) => {
      frames.push(event as Record<string, unknown>);
    });

    await api.startBrowserPreview?.('task-1', 'side');
    await vi.advanceTimersByTimeAsync(750);
    expect(calls[1]).toEqual({
      method: 'devBrowser.captureFrame',
      params: { taskId: 'task-1', pageName: 'side' },
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(callCount('devBrowser.captureFrame')).toBe(2); // one per advanced tick
    const expectedFrame = {
      frame: 'frame-A',
      pageName: 'side',
      timestamp: expect.any(Number),
      taskId: 'task-1',
      width: 800,
      height: 600,
    };
    expect(frames).toEqual([expectedFrame, expectedFrame]);
  });

  it('skips null frames without emitting them', async () => {
    responses.set('devBrowser.captureFrame', null);
    const api = makeApi();
    const frames: unknown[] = [];
    api.onBrowserFrame?.((event) => {
      frames.push(event);
    });

    await api.startBrowserPreview?.('task-1');
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    expect(callCount('devBrowser.captureFrame')).toBe(2);
    expect(frames).toEqual([]);
  });

  it('stopBrowserPreview clears the poll (no further transport calls)', async () => {
    responses.set('devBrowser.captureFrame', { data: 'frame-B', width: 640, height: 480 });
    const api = makeApi();
    await api.startBrowserPreview?.('task-1');
    await vi.advanceTimersByTimeAsync(750);
    const callsAtStop = calls.length;

    await expect(api.stopBrowserPreview?.('task-1')).resolves.toEqual({ stopped: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(callsAtStop);
  });

  it('stopBrowserPreview reports stopped:false when no poll is running for the task', async () => {
    const api = makeApi();
    await expect(api.stopBrowserPreview?.('task-never-started')).resolves.toEqual({
      stopped: false,
    });
  });

  it('getBrowserPreviewStatus reflects the shim-local poll state', async () => {
    const api = makeApi();
    await expect(api.getBrowserPreviewStatus?.()).resolves.toEqual({ active: false });
    await api.startBrowserPreview?.('task-1');
    await expect(api.getBrowserPreviewStatus?.()).resolves.toEqual({ active: true });
    await api.stopBrowserPreview?.('task-1');
    await expect(api.getBrowserPreviewStatus?.()).resolves.toEqual({ active: false });
  });

  it('onBrowserFrame unsubscribe stops delivery', async () => {
    responses.set('devBrowser.captureFrame', { data: 'frame-C', width: 100, height: 100 });
    const api = makeApi();
    const frames: Array<Record<string, unknown>> = [];
    const off = api.onBrowserFrame?.((event) => {
      frames.push(event as Record<string, unknown>);
    });
    await api.startBrowserPreview?.('task-1');
    await vi.advanceTimersByTimeAsync(750);
    expect(frames.length).toBe(1);

    off?.();
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    expect(frames.length).toBe(1);
    // Poll itself keeps running until stopBrowserPreview (subscriber-only removal).
    expect(callCount('devBrowser.captureFrame')).toBe(3);
    await api.stopBrowserPreview?.('task-1');
  });

  it('tolerates consecutive poll failures: logs one breadcrumb at 3, keeps polling', async () => {
    const api = makeApi();
    await api.startBrowserPreview?.('task-1');
    // Every tick misses (sidecar may be relaunching)…
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    expect(callCount('devBrowser.captureFrame')).toBe(3);
    expect(clientLog).toHaveBeenCalledTimes(1);
    expect(clientLog.mock.calls[0][0].level).toBe('warn');

    // …and the poll is still alive afterwards (6 more ticks, no new log).
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);
    expect(callCount('devBrowser.captureFrame')).toBe(9);
    await api.stopBrowserPreview?.('task-1');
    expect(clientLog).toHaveBeenCalledTimes(1);
  });

  it('a successful frame resets the failure counter before tolerating more misses', async () => {
    let fail = true;
    callBehavior = (method) => {
      if (method !== 'devBrowser.captureFrame') {
        return null;
      }
      return fail ? null : { data: 'recovered', width: 1, height: 1 };
    };
    const api = makeApi();
    const frames: unknown[] = [];
    api.onBrowserFrame?.((event) => {
      frames.push(event);
    });
    await api.startBrowserPreview?.('task-1');
    await vi.advanceTimersByTimeAsync(750); // miss 1
    await vi.advanceTimersByTimeAsync(750); // miss 2
    fail = false;
    await vi.advanceTimersByTimeAsync(750); // success → counter reset
    expect(frames.length).toBe(1);
    fail = true;
    // Fresh misses start counting from zero → no new log for 2 more.
    await vi.advanceTimersByTimeAsync(750); // miss 1
    await vi.advanceTimersByTimeAsync(750); // miss 2
    expect(clientLog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750); // miss 3 → new breadcrumb
    expect(clientLog).toHaveBeenCalledTimes(1);
    await api.stopBrowserPreview?.('task-1');
    callBehavior = null;
  });

  it('an openPreviewPage failure never blocks the poll (best-effort ensure)', async () => {
    callBehavior = (method) => {
      if (method === 'devBrowser.openPreviewPage') {
        throw new Error('sidecar unavailable');
      }
      return { data: 'frame-D', width: 100, height: 100 };
    };
    const api = makeApi();
    const frames: unknown[] = [];
    api.onBrowserFrame?.((event) => frames.push(event));
    await expect(api.startBrowserPreview?.('task-1')).resolves.toEqual({ success: true });
    await vi.advanceTimersByTimeAsync(750);
    expect(frames.length).toBeGreaterThan(0);
    await api.stopBrowserPreview?.('task-1');
    callBehavior = null;
  });

  it('the onBrowserNavigate/onBrowserStatus subscriptions stay optional-absent (v1 defer)', () => {
    const api = makeApi() as unknown as Record<string, unknown>;
    expect(api.onBrowserNavigate).toBeUndefined();
    expect(api.onBrowserStatus).toBeUndefined();
  });
});

describe('M6-A T4 pending-request restore shim (accomplish-http)', () => {
  let calls: { method: string; params?: unknown }[];
  let responses: Map<string, unknown>;
  let transport: HttpTransport;

  beforeEach(() => {
    calls = [];
    responses = new Map();
    transport = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return responses.get(method) ?? null;
      },
      openExternal: async () => {},
      pickFolder: async () => null,
      pickFiles: async () => [],
      health: async () => ({ ok: true, version: '0.1.0', platform: 'linux' }),
      clientLog: vi.fn(async () => undefined),
      cliStatus: async () => ({ installed: true, version: '1', installCommand: '' }),
      autostartStatus: async () => ({ enabled: false, active: false }),
    } as unknown as HttpTransport;
  });

  function makeApi() {
    return createHttpAccomplishApi({
      baseUrl: 'http://127.0.0.1:8123',
      token: TEST_TOKEN,
      transport,
      events: new FakeEventStream() as unknown as GatewayEventStream,
    });
  }

  it('maps getPendingRequest onto the dedicated route with the taskId param', async () => {
    const api = makeApi();
    await api.getPendingRequest?.('tsk_1');
    expect(calls.at(-1)).toEqual({ method: 'task.getPendingRequest', params: { taskId: 'tsk_1' } });
  });

  it('unwraps the { pendingRequest } carrier to the record for UI consumers', async () => {
    const record = {
      kind: 'question',
      requestId: 'questionreq_1',
      question: 'A CAPTCHA is blocking the site',
      header: 'Human assistance required',
      options: [{ label: "I'll complete it — please wait" }],
      multiSelect: false,
      createdAt: '2026-10-23T00:00:00.000Z',
    };
    responses.set('task.getPendingRequest', { pendingRequest: record });
    const api = makeApi();
    await expect(api.getPendingRequest?.('tsk_1')).resolves.toEqual(record);
  });

  it('answers null for the null carrier (nothing parked / cleared / unknown task)', async () => {
    const api = makeApi();
    await expect(api.getPendingRequest?.('tsk_terminal')).resolves.toBeNull();
  });

  it('degrades a missing carrier to null without throwing, so a card restore never fails open', async () => {
    // A (hypothetical) daemon that answers without the wrapper key — e.g. an
    // RPC error object — degrades to null; the restorer then shows the
    // explainer instead of crashing or seeding a bogus card.
    responses.set('task.getPendingRequest', {});
    const api = makeApi();
    await expect(api.getPendingRequest?.('tsk_1')).resolves.toBeNull();
  });
});

/** Build a loose matcher for thrown shim error messages. */
function errMessageRe(fragment: string): RegExp {
  return new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

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
