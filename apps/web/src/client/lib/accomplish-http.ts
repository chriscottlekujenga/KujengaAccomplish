/**
 * Browser (non-Electron) transport for the Accomplish API.
 *
 * Firefox migration Phase 1 (FIREFOX_MIGRATION_PLAN §6/§9): when the UI runs
 * inside a plain browser tab served by the host gateway, `window.accomplish`
 * does not exist. This module implements the same `AccomplishAPI` surface
 * over the gateway's same-origin HTTP + WebSocket endpoints:
 *
 *   - Token bootstrap: the launcher opens
 *     `http://127.0.0.1:<port>/#token=<session-token>` — the fragment never
 *     leaves the browser; it is moved to sessionStorage and stripped from
 *     the URL on first read.
 *   - RPC: POST /rpc with `Authorization: Bearer <token>` (JSON-RPC 2.0).
 *   - Events: WebSocket /events authenticated by a first message.
 *
 * The gateway authorizes an explicit subset of daemon methods (policy.ts).
 * Methods the Phase 1 shim has not wired yet throw `HttpShimNotSupportedError`
 * via a Proxy, so missing coverage is loud instead of silently undefined.
 * Analytics are no-ops (Phase 3 adds a batched endpoint).
 */

import type {
  Task,
  TaskConfig,
  TaskUpdateEvent,
  PermissionRequest,
  PermissionResponse,
  TaskProgress,
  TaskMessage,
  TodoItem,
  Workspace,
  WorkspaceCreateInput,
  WorkspaceUpdateInput,
  KnowledgeNote,
  KnowledgeNoteCreateInput,
  KnowledgeNoteUpdateInput,
  StoredFavorite,
  FileAttachmentInfo,
  ApiKeyConfig,
} from '@accomplish_ai/agent-core';
import { sanitizeString, validateHttpUrl } from '@accomplish_ai/agent-core';
import type { ScheduledTask } from '@accomplish_ai/agent-core/common';
import type { AccomplishAPI } from './accomplish';

const TOKEN_STORAGE_KEY = 'accomplish.gateway-token';

/** Minimal gateway-token shape (base64url of ≥128 bits, or dev-injected). */
function isValidTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,256}$/.test(token);
}

/**
 * Drop undefined keys from a params object so RPC payloads stay canonical —
 * optional request parameters must be absent on the wire, not `undefined`
 * (same semantics daemon-side, but the explicit shape is easier to audit).
 */
function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

/**
 * The Bedrock/Vertex connect flows pass credential OBJECTS through the
 * widened Electron wrapper (accomplish.ts `buildElectronAccomplishApi`)
 * while the raw AccomplishAPI contract names `string` — accept both and
 * canonicalize to the JSON document the daemon's validators and secret
 * store expect.
 */
function credentialsJsonOf(credentials: unknown): string {
  if (typeof credentials === 'string') {
    return credentials;
  }
  return JSON.stringify(credentials);
}

/** Normalize a provider model-fetch result to the `models`-is-an-array
 *  contract the Bedrock/Vertex shim methods promise (the desktop handlers
 *  return `models: []` on failure; the daemon field is optional). */
function withModelsArray(raw: { success?: boolean; models?: unknown[]; error?: string } | null): {
  success: boolean;
  models: Array<{ id: string; name: string; provider: string }>;
  error?: string;
} {
  if (!raw || typeof raw !== 'object') {
    return { success: false, models: [] };
  }
  const result: {
    success: boolean;
    models: Array<{ id: string; name: string; provider: string }>;
    error?: string;
  } = {
    success: Boolean(raw.success),
    models: (Array.isArray(raw.models) ? raw.models : []) as Array<{
      id: string;
      name: string;
      provider: string;
    }>,
  };
  if (typeof raw.error === 'string') {
    result.error = raw.error;
  }
  return result;
}

export class HttpShimNotSupportedError extends Error {
  constructor(method: string) {
    super(`Method "${method}" is not yet supported over the HTTP gateway shim`);
    this.name = 'HttpShimNotSupportedError';
  }
}

export class GatewayRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayRpcError';
  }
}

/**
 * Defensively read window.location — hostile test environments replace the
 * window object wholesale, and the fallback must degrade to "unavailable"
 * rather than crash when it is missing.
 */
function currentLocation(): Location | null {
  try {
    return window.location ?? null;
  } catch {
    return null;
  }
}

/**
 * Loopback check — the HTTP fallback must never activate on an arbitrary
 * website; only on the gateway's own origin.
 */
export function isLoopbackHttpOrigin(origin?: string): boolean {
  const candidate = origin ?? currentLocation()?.origin ?? null;
  if (!candidate) {
    return false;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:') {
      return false;
    }
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Read the session token from the launch URL fragment (once), persisting it
 * to sessionStorage; fall back to sessionStorage on later loads. The
 * fragment is stripped via history.replaceState so it never leaks into
 * shared links or the address bar.
 */
export function readGatewayToken(): string | null {
  const location = currentLocation();
  if (!location) {
    return null;
  }
  const hash = location.hash;
  if (hash.startsWith('#token=')) {
    const token = decodeURIComponent(hash.slice('#token='.length)).trim();
    if (isValidTokenShape(token)) {
      try {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        /* private-browsing quirks — in-memory use still works this session */
      }
      try {
        window.history.replaceState(null, '', location.pathname + location.search);
      } catch {
        /* older engines without replaceState */
      }
      return token;
    }
  }
  try {
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored && isValidTokenShape(stored)) {
      return stored;
    }
  } catch {
    /* sessionStorage unavailable */
  }
  return null;
}

// =============================================================================
// HTTP transport
// =============================================================================

export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface JsonRpcResponseBody {
  result?: unknown;
  error?: { code: number; message: string };
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) {
      throw new GatewayRpcError(res.status, `Gateway rejected ${method} (HTTP ${res.status})`);
    }
    const body = (await res.json()) as JsonRpcResponseBody;
    if (body.error) {
      throw new GatewayRpcError(body.error.code, body.error.message);
    }
    return body.result;
  }

  async openExternal(url: string): Promise<void> {
    await this.postJson('/open-external', { url });
  }

  /** Phase 2 native pickers — served by the host (zenity dialogs). */
  async pickFolder(): Promise<string | null> {
    const body = (await this.postJson('/pick-folder', {})) as { path: string | null };
    return body.path;
  }

  async pickFiles(): Promise<unknown[]> {
    const body = (await this.postJson('/pick-files', {})) as { files?: unknown[] };
    return body.files ?? [];
  }

  /** Client diagnostics — browser errors/logs land in the host log. */
  async clientLog(entry: { level?: string; message: string; context?: string }): Promise<void> {
    await this.postJson('/client-log', entry as unknown as Record<string, unknown>);
  }

  /** OpenCode CLI status (host-side resolution, mirrors opencode:check). */
  async cliStatus(): Promise<{
    installed: boolean;
    version: string | null;
    installCommand: string;
  }> {
    const res = await this.fetchImpl(`${this.baseUrl}/cli-status`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new GatewayRpcError(res.status, `CLI status failed (HTTP ${res.status})`);
    }
    return (await res.json()) as {
      installed: boolean;
      version: string | null;
      installCommand: string;
    };
  }

  /** systemd autostart status (settings UI). */
  async autostartStatus(): Promise<{ enabled: boolean; active: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/autostart-status`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new GatewayRpcError(res.status, `Autostart status failed (HTTP ${res.status})`);
    }
    return (await res.json()) as { enabled: boolean; active: boolean };
  }

  async health(): Promise<{ ok: boolean; version: string; platform: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new GatewayRpcError(res.status, `Gateway health check failed (HTTP ${res.status})`);
    }
    return (await res.json()) as { ok: boolean; version: string; platform: string };
  }

  private async postJson(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: { code: number; message: string };
    } | null;
    if (!res.ok) {
      const message = body?.error?.message ?? `Gateway rejected ${path} (HTTP ${res.status})`;
      throw new GatewayRpcError(body?.error?.code ?? res.status, message);
    }
    return body;
  }
}

// =============================================================================
// WebSocket event stream
// =============================================================================

/** Minimal socket shape — satisfied by the browser WebSocket. */
export interface GatewaySocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface GatewayEventStreamOptions {
  baseUrl: string;
  token: string;
  socketFactory?: (url: string) => GatewaySocket;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
}

export class GatewayEventStream {
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly socketFactory: (url: string) => GatewaySocket;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly controlHandlers = new Map<string, Set<(params?: unknown) => void>>();
  private socket: GatewaySocket | null = null;
  private authed = false;
  private hadOpenedSession = false;
  private manuallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(options: GatewayEventStreamOptions) {
    this.wsUrl = options.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/events';
    this.token = options.token;
    this.socketFactory =
      options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as GatewaySocket);
    this.reconnectInitialMs = options.reconnectInitialMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  }

  /** Subscribe to a daemon notification method. Returns an unsubscribe fn. */
  onNotification(method: string, callback: (params: unknown) => void): () => void {
    this.connect();
    const handlers = this.notificationHandlers.get(method) ?? new Set();
    handlers.add(callback);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(callback);
    };
  }

  /** Subscribe to a control event (`daemon:disconnected`, deep links, etc.). */
  onControlEvent(event: string, callback: (params?: unknown) => void): () => void {
    this.connect();
    const handlers = this.controlHandlers.get(event) ?? new Set();
    handlers.add(callback);
    this.controlHandlers.set(event, handlers);
    return () => {
      handlers.delete(callback);
    };
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.socket || this.manuallyClosed) {
      return;
    }
    const socket = this.socketFactory(this.wsUrl);
    this.socket = socket;
    this.authed = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', token: this.token }));
    };

    socket.onmessage = (event: { data: unknown }) => {
      let message: { type?: string; method?: string; params?: unknown; event?: string };
      const raw =
        typeof event.data === 'string'
          ? event.data
          : typeof (event.data as { toString?: () => string })?.toString === 'function'
            ? String(event.data)
            : '';
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'auth-ok') {
        this.authed = true;
        if (this.hadOpenedSession) {
          // A WS drop is indistinguishable from a daemon drop at this layer;
          // synthesize the reconnect signal so stores refresh their caches.
          this.dispatchControl('daemon:reconnected');
        }
        this.hadOpenedSession = true;
        this.reconnectAttempt = 0;
        return;
      }
      if (message.type === 'notification' && message.method) {
        this.dispatchNotification(message.method, message.params);
        return;
      }
      if (message.type === 'control' && message.event) {
        this.dispatchControl(message.event, message.params);
      }
    };

    socket.onclose = () => {
      this.socket = null;
      this.authed = false;
      if (this.manuallyClosed) {
        return;
      }
      if (this.hadOpenedSession) {
        this.dispatchControl('daemon:disconnected');
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      /* close handler drives reconnection */
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.reconnectInitialMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxMs,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatchNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(params);
    }
  }

  private dispatchControl(event: string, params?: unknown): void {
    const handlers = this.controlHandlers.get(event);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(params);
    }
  }
}

// =============================================================================
// AccomplishAPI over the gateway
// =============================================================================

interface SettingsSnapshotLike {
  app: {
    theme: string;
    language: string;
    debugMode: boolean;
    onboardingComplete: boolean;
  };
  notificationsEnabled: boolean;
  closeBehavior: 'keep-daemon' | 'stop-daemon';
  sandboxConfig: unknown;
  cloudBrowserConfig: unknown;
}

export interface CreateHttpAccomplishApiOptions {
  baseUrl: string;
  token: string;
  /** Injectable transports for tests. */
  transport?: HttpTransport;
  events?: GatewayEventStream;
}

export function createHttpAccomplishApi(options: CreateHttpAccomplishApiOptions): AccomplishAPI {
  const transport =
    options.transport ?? new HttpTransport({ baseUrl: options.baseUrl, token: options.token });
  const events =
    options.events ?? new GatewayEventStream({ baseUrl: options.baseUrl, token: options.token });

  const call = (method: string, params?: unknown) => transport.call(method, params);

  let settingsCache: SettingsSnapshotLike | null = null;
  let settingsFetch: Promise<SettingsSnapshotLike> | null = null;
  const loadSettings = (): Promise<SettingsSnapshotLike> => {
    if (settingsCache) {
      return Promise.resolve(settingsCache);
    }
    settingsFetch ??= call('settings.getAll')
      .then((snapshot) => {
        settingsCache = snapshot as SettingsSnapshotLike;
        settingsFetch = null;
        return settingsCache;
      })
      .catch((err: unknown) => {
        settingsFetch = null;
        throw err;
      });
    return settingsFetch;
  };
  const invalidateSettings = (): void => {
    settingsCache = null;
  };

  const onSettingsChanged = (callback: () => void): (() => void) =>
    events.onNotification('settings.changed', () => {
      invalidateSettings();
      callback();
    });

  const core: Record<string, unknown> = {
    // ── App info ──
    getVersion: () => transport.health().then((h) => h.version),
    getPlatform: () => transport.health().then((h) => h.platform),
    isE2EMode: () => Promise.resolve(false),
    openExternal: (url: string) => transport.openExternal(url),

    // ── Tasks ──
    startTask: (config: TaskConfig) => call('task.start', { ...config }) as Promise<Task>,
    cancelTask: (taskId: string) => call('task.cancel', { taskId }),
    interruptTask: (taskId: string) => call('task.interrupt', { taskId }),
    getTask: (taskId: string) => call('task.get', { taskId }) as Promise<Task | null>,
    listTasks: () => call('task.list', {}) as Promise<Task[]>,
    deleteTask: (taskId: string) => call('task.delete', { taskId }),
    clearTaskHistory: () => call('task.clearHistory'),
    getTodosForTask: (taskId: string) => call('task.getTodos', { taskId }) as Promise<TodoItem[]>,

    // ── Session & permissions ──
    resumeSession: (
      sessionId: string,
      prompt: string,
      taskId?: string,
      attachments?: FileAttachmentInfo[],
    ) =>
      call('session.resume', {
        sessionId,
        prompt,
        existingTaskId: taskId,
        attachments,
      }) as Promise<Task>,
    respondToPermission: (response: PermissionResponse) =>
      call('permission.respond', { ...response }),

    // ── Settings ──
    getTheme: () => loadSettings().then((s) => s.app.theme),
    setTheme: (theme: string) => call('settings.setTheme', { theme }).then(invalidateSettings),
    getLanguage: () => loadSettings().then((s) => s.app.language),
    setLanguage: (language: string) =>
      call('settings.setLanguage', { language }).then(invalidateSettings),
    getDebugMode: () => loadSettings().then((s) => s.app.debugMode),
    setDebugMode: (enabled: boolean) =>
      call('settings.setDebugMode', { enabled }).then(invalidateSettings),
    getNotificationsEnabled: () => call('settings.getNotificationsEnabled'),
    setNotificationsEnabled: (enabled: boolean) =>
      call('settings.setNotificationsEnabled', { enabled }).then(invalidateSettings),
    getCloseBehavior: () => call('settings.getCloseBehavior'),
    setCloseBehavior: (behavior: string) =>
      call('settings.setCloseBehavior', { behavior: behavior as 'keep-daemon' | 'stop-daemon' }),
    getSandboxConfig: () => call('settings.getSandboxConfig'),
    setSandboxConfig: (config: unknown) =>
      call('settings.setSandboxConfig', { config }).then(invalidateSettings),
    getCloudBrowserConfig: () => call('settings.getCloudBrowserConfig'),
    setCloudBrowserConfig: (config: unknown) =>
      call('settings.setCloudBrowserConfig', { config }).then(invalidateSettings),
    getOnboardingComplete: () => loadSettings().then((s) => s.app.onboardingComplete),
    setOnboardingComplete: (complete: boolean) =>
      call('settings.setOnboardingComplete', { complete }).then(invalidateSettings),
    getAppSettings: () =>
      loadSettings().then((s) => ({
        debugMode: s.app.debugMode,
        onboardingComplete: s.app.onboardingComplete,
        theme: s.app.theme,
        language: s.app.language,
      })),
    getSelectedModel: () => call('settings.getSelectedModel'),
    setSelectedModel: (model: unknown) =>
      call('settings.setSelectedModel', { model }).then(invalidateSettings),

    // ── Logging: real diagnostics channel to the host log ──
    logEvent: (payload: { level?: string; message: string; context?: Record<string, unknown> }) =>
      transport.clientLog({
        level: payload.level,
        message: payload.message,
        context: payload.context ? JSON.stringify(payload.context) : undefined,
      }) as Promise<unknown>,

    // ── Provider settings (masked metadata; gateway scrubs secret-looking
    //    fields before the response crosses the trust boundary) ──
    getProviderSettings: () => call('provider.getSettings') as never,

    // ── Provider settings writes (Phase 3 M2 T1b) — everything rides the
    //    T1a provider.* RPCs. getConnectedProvider has no dedicated read
    //    RPC: it derives from the masked provider.getSettings snapshot,
    //    exactly as the desktop handler does. Provider writes mutate the
    //    settings.getAll snapshot too, so they invalidate the cache. ──
    setActiveProvider: (providerId: string | null) =>
      call('provider.setActive', { providerId }).then(invalidateSettings) as Promise<void>,
    getConnectedProvider: async (providerId: string) => {
      const settings = (await call('provider.getSettings')) as {
        connectedProviders?: Record<string, never>;
      };
      return settings.connectedProviders?.[providerId] ?? null;
    },
    setConnectedProvider: (providerId: string, provider: unknown) =>
      call('provider.setConnected', { providerId, provider }).then(
        invalidateSettings,
      ) as Promise<void>,
    removeConnectedProvider: (providerId: string) =>
      call('provider.removeConnected', { providerId }).then(invalidateSettings) as Promise<void>,
    updateProviderModel: (providerId: string, modelId: string | null) =>
      call('provider.updateModel', { providerId, modelId }).then(
        invalidateSettings,
      ) as Promise<void>,
    setProviderDebugMode: (enabled: boolean) =>
      call('provider.setDebugMode', { enabled }).then(invalidateSettings) as Promise<void>,
    getProviderDebugMode: () => call('provider.getDebugMode') as Promise<boolean>,

    // ── Skills ──
    getSkills: () => call('skills.list') as never,
    getEnabledSkills: () => call('skills.listEnabled') as never,
    setSkillEnabled: (id: string, enabled: boolean) => call('skills.setEnabled', { id, enabled }),
    getSkillContent: (id: string) => call('skills.getContent', { id }) as never,
    resyncSkills: () => call('skills.resync') as never,

    // ── OpenCode CLI status (host-side resolution) ──
    checkOpenCodeCli: () => transport.cliStatus() as never,
    getOpenCodeVersion: () =>
      transport.cliStatus().then((status) => status.version) as Promise<string | null>,

    // ── Speech: honestly unconfigured over the gateway in Phase 2 — the
    //    voice UI disables itself instead of crashing or lying ──
    speechIsConfigured: () => Promise.resolve(false),
    speechGetConfig: () => Promise.resolve({ enabled: false, hasApiKey: false }) as never,

    // ── Build capabilities: OSS build, no analytics in the shim ──
    getBuildCapabilities: () => Promise.resolve({ hasFreeMode: false, hasAnalytics: false }),

    // ── systemd autostart status (settings UI) ──
    isAutoStartEnabled: () => transport.autostartStatus().then((s) => s.enabled),

    // ── Accomplish AI usage (allowlisted daemon RPC) ──
    accomplishAiGetUsage: () => call('accomplish-ai.get-usage') as never,

    // ── Daemon (read-only surface; host-side control lands in Phase 2) ──
    daemonPing: () => call('daemon.ping'),

    // ── API key management (Phase 3 M2 T1b) ──
    // Reads are masked: `secrets.listApiKeys` serves
    // `{ provider: { exists, prefix? } }` only, and every plaintext read
    // (`getApiKey`, `getBedrockCredentials`, `getVertexCredentials`) stays
    // blocked — those methods remain loud not-supported stubs. Desktop
    // `api-key:set` / `api-key:clear` / `api-key:validate` semantics all
    // target the DEFAULT provider ('anthropic'; api-key-validation-
    // handlers.ts). Storing keys from the browser is one-way by design.
    addApiKey: ((provider: string, key: string, _label?: string) =>
      call('secrets.storeApiKey', { provider, apiKey: key }).then(
        () =>
          ({
            id: provider,
            provider,
            exists: true,
            prefix: key.slice(0, 4),
          }) as unknown as ApiKeyConfig,
      )) as AccomplishAPI['addApiKey'],
    hasApiKey: () => call('secrets.hasAnyApiKey') as Promise<boolean>,
    hasAnyApiKey: () => call('secrets.hasAnyApiKey') as Promise<boolean>,
    getApiKeys: (async () => {
      const masked = (await call('secrets.listApiKeys')) as Record<
        string,
        { exists: boolean; prefix?: string }
      >;
      // Desktop settings:api-keys parity: only existing keys are listed
      // (desktop filters nulls); labels are not derivable from the masked
      // read, so entries carry the masked prefix only.
      return Object.entries(masked)
        .filter(([, info]) => info.exists)
        .map(([provider, info]) => ({
          id: provider,
          provider,
          exists: true,
          ...(info.prefix ? { prefix: info.prefix } : {}),
        }));
    }) as unknown as AccomplishAPI['getApiKeys'],
    getAllApiKeys: (async () =>
      (await call('secrets.listApiKeys')) as Record<
        string,
        { exists: boolean; prefix?: string }
      >) as unknown as AccomplishAPI['getAllApiKeys'],
    setApiKey: (key: string) =>
      call('secrets.storeApiKey', {
        provider: 'anthropic',
        apiKey: sanitizeString(key, 'apiKey', 256),
      }) as Promise<void>,
    removeApiKey: (id: string) => call('secrets.deleteApiKey', { provider: id }) as Promise<void>,
    validateApiKey: (key: string) =>
      call('provider.validateKey', {
        providerId: 'anthropic',
        key: sanitizeString(key, 'apiKey', 256),
      }) as never,
    validateApiKeyForProvider: (provider: string, key: string, options?: Record<string, unknown>) =>
      call('provider.validateKey', omitUndefined({ providerId: provider, key, options })) as never,
    // Desktop api-key:clear deletes ONLY the default-provider key
    // (`deleteApiKey('anthropic')`) — it never touches other providers, so
    // the blanket-wipe `secrets.clear` is deliberately NOT allowlisted for
    // the browser and stays registered-blocked.
    clearApiKey: () => call('secrets.deleteApiKey', { provider: 'anthropic' }) as Promise<void>,

    // ── Provider runtime configs (Phase 3 M2 T1b): pass-through reads +
    //    settings writers. The T1a settings.* routes handle these config
    //    blobs; desktop writes them through the settings service too, so
    //    every write invalidates the settings snapshot cache. ──
    getOpenAiBaseUrl: () => call('settings.getOpenAiBaseUrl') as Promise<string>,
    setOpenAiBaseUrl: (baseUrl: string) =>
      call('settings.setOpenAiBaseUrl', { baseUrl }).then(invalidateSettings) as Promise<void>,
    getOllamaConfig: () => call('settings.getOllamaConfig') as never,
    setOllamaConfig: (config: unknown) =>
      call('settings.setOllamaConfig', { config }).then(invalidateSettings) as Promise<void>,
    getLiteLLMConfig: () => call('settings.getLiteLLMConfig') as never,
    setLiteLLMConfig: (config: unknown) =>
      call('settings.setLiteLLMConfig', { config }).then(invalidateSettings) as Promise<void>,
    getLMStudioConfig: () => call('settings.getLMStudioConfig') as never,
    setLMStudioConfig: (config: unknown) =>
      call('settings.setLMStudioConfig', { config }).then(invalidateSettings) as Promise<void>,
    getAzureFoundryConfig: () => call('settings.getAzureFoundryConfig') as never,
    setAzureFoundryConfig: (config: unknown) =>
      call('settings.setAzureFoundryConfig', { config }).then(invalidateSettings) as Promise<void>,

    // ── Connection tests + model discovery (Phase 3 M2 T1b) ──
    // `provider.testConnection` accepts a one-way plaintext key; model
    // fetches resolve keys daemon-side from stored secrets, so the shim
    // never has the material to begin with. Errors come back redacted.
    testOllamaConnection: (url: string) =>
      call('provider.testConnection', { providerId: 'ollama', url }) as never,
    testLiteLLMConnection: (url: string, apiKey?: string) =>
      call(
        'provider.testConnection',
        omitUndefined({ providerId: 'litellm', url, apiKey }),
      ) as never,
    testLMStudioConnection: (url: string) =>
      call('provider.testConnection', { providerId: 'lmstudio', url }) as never,
    testNimConnection: (url: string, apiKey: string) =>
      call('provider.testConnection', { providerId: 'nim', url, apiKey }) as never,
    testCustomConnection: (baseUrl: string, apiKey?: string) =>
      call(
        'provider.testConnection',
        omitUndefined({ providerId: 'custom', url: baseUrl, apiKey }),
      ) as never,
    testAzureFoundryConnection: (config: {
      endpoint: string;
      deploymentName: string;
      authType: 'api-key' | 'entra-id';
      apiKey?: string;
    }) =>
      call(
        'provider.testConnection',
        omitUndefined({
          providerId: 'azure-foundry',
          endpoint: config.endpoint,
          deploymentName: config.deploymentName,
          authType: config.authType,
          apiKey: config.apiKey,
        }),
      ) as never,
    // Desktop azure-foundry:save-config sequence, mirrored exactly:
    // validate at the boundary, (optionally) store the key one-way, then
    // write the config through settings with enabled + fresh lastValidated.
    saveAzureFoundryConfig: async (config: {
      endpoint: string;
      deploymentName: string;
      authType: 'api-key' | 'entra-id';
      apiKey?: string;
    }) => {
      const { endpoint, deploymentName, authType, apiKey } = config;
      if (typeof endpoint !== 'string' || !endpoint.trim()) {
        throw new Error('Invalid Azure Foundry configuration: endpoint is required');
      }
      if (typeof deploymentName !== 'string' || !deploymentName.trim()) {
        throw new Error('Invalid Azure Foundry configuration: deploymentName is required');
      }
      if (authType !== 'api-key' && authType !== 'entra-id') {
        throw new Error(
          'Invalid Azure Foundry configuration: authType must be api-key or entra-id',
        );
      }
      try {
        validateHttpUrl(endpoint, 'Azure Foundry endpoint');
      } catch {
        throw new Error('Invalid Azure Foundry configuration: Invalid endpoint URL format');
      }
      if (authType === 'api-key' && apiKey) {
        await call('secrets.storeApiKey', { provider: 'azure-foundry', apiKey });
      }
      await call('settings.setAzureFoundryConfig', {
        config: {
          baseUrl: endpoint,
          deploymentName,
          authType,
          enabled: true,
          lastValidated: Date.now(),
        },
      });
      invalidateSettings();
    },
    fetchProviderModels: (providerId: string, options?: { baseUrl?: string; zaiRegion?: string }) =>
      call('provider.fetchModels', omitUndefined({ providerId, options })) as never,
    fetchOpenRouterModels: () =>
      call('provider.fetchModels', { providerId: 'openrouter' }) as never,
    fetchLiteLLMModels: () => call('provider.fetchModels', { providerId: 'litellm' }) as never,
    fetchLMStudioModels: () => call('provider.fetchModels', { providerId: 'lmstudio' }) as never,
    fetchNimModels: () => call('provider.fetchModels', { providerId: 'nim' }) as never,
    // Bedrock/Vertex model fetches resolve credentials DAEMON-side from the
    // stored secret — the browser cannot read stored credentials back (the
    // plaintext reads are blocklisted). Both connect flows save the
    // credentials immediately before fetching
    // (useBedrockProviderConnect / useVertexProviderConnect), so the stored
    // copy is the one this call intends; honoring the `credentials`
    // argument would require echoing secrets from the daemon, which the
    // trust boundary forbids. Limitation accepted for the browser shim.
    fetchBedrockModels: async (_credentials: string | unknown) => {
      return withModelsArray(
        (await call('provider.fetchModels', { providerId: 'bedrock' })) as {
          success?: boolean;
          models?: unknown[];
          error?: string;
        } | null,
      );
    },
    fetchVertexModels: async (_credentials: string | unknown) => {
      return withModelsArray(
        (await call('provider.fetchModels', { providerId: 'vertex' })) as {
          success?: boolean;
          models?: unknown[];
          error?: string;
        } | null,
      );
    },
    // Credential validation for Bedrock/Vertex (Phase 3 M2 T1b §A3): the
    // JSON document travels ONE-WAY in the request; `provider.
    // validateCredentials` returns a { valid, error? } verdict with
    // daemon-side redacted error text and never echoes the document. Used
    // by the connect flows BEFORE saving — `provider.validateKey` cannot
    // serve these (document-JSON validators, bypasses the api-key gate).
    validateBedrockCredentials: (credentials: string | unknown) =>
      call('provider.validateCredentials', {
        providerId: 'bedrock',
        credentials: credentialsJsonOf(credentials),
      }) as never,
    validateVertexCredentials: (credentials: string | unknown) =>
      call('provider.validateCredentials', {
        providerId: 'vertex',
        credentials: credentialsJsonOf(credentials),
      }) as never,

    // ── Bedrock/Vertex credential saves (Phase 3 M2 T1b §A3): one-way
    //    stores; the returned ApiKeyConfig labels/prefixes derive from the
    //    locally-held document (mirroring desktop bedrock:save and
    //    vertex:save output exactly) — never from secret round-trips. ──
    saveBedrockCredentials: (async (credentials: string | unknown) => {
      const stored = credentialsJsonOf(credentials);
      const parsed = JSON.parse(stored) as {
        authType?: string;
        apiKey?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        profileName?: string;
      };
      // Desktop bedrock:save field validation (bedrock-handlers.ts).
      if (parsed.authType === 'apiKey') {
        if (!(typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0)) {
          throw new Error('API Key is required');
        }
      } else if (parsed.authType === 'accessKeys') {
        const hasAccessKeyId =
          typeof parsed.accessKeyId === 'string' && parsed.accessKeyId.length > 0;
        const hasSecretKey =
          typeof parsed.secretAccessKey === 'string' && parsed.secretAccessKey.length > 0;
        if (!hasAccessKeyId || !hasSecretKey) {
          throw new Error('Access Key ID and Secret Access Key are required');
        }
      } else if (parsed.authType === 'profile') {
        if (!(typeof parsed.profileName === 'string' && parsed.profileName.length > 0)) {
          throw new Error('Profile name is required');
        }
      } else {
        throw new Error('Invalid authentication type');
      }
      await call('secrets.storeBedrockCredentials', { credentials: stored });
      let label: string;
      let keyPrefix: string;
      if (parsed.authType === 'apiKey') {
        label = 'Bedrock API Key';
        keyPrefix = `${parsed.apiKey?.substring(0, 8)}...`;
      } else if (parsed.authType === 'accessKeys') {
        label = 'AWS Access Keys';
        keyPrefix = `${parsed.accessKeyId?.substring(0, 8)}...`;
      } else {
        label = `AWS Profile: ${parsed.profileName}`;
        keyPrefix = parsed.profileName ?? '';
      }
      return {
        id: 'local-bedrock',
        provider: 'bedrock',
        label,
        keyPrefix,
        isActive: true,
        createdAt: new Date().toISOString(),
      } as unknown as ApiKeyConfig;
    }) as AccomplishAPI['saveBedrockCredentials'],
    saveVertexCredentials: (async (credentials: string | unknown) => {
      const stored = credentialsJsonOf(credentials);
      const parsed = JSON.parse(stored) as {
        projectId?: string;
        location?: string;
        authType?: string;
        serviceAccountJson?: string;
      };
      // Desktop vertex:save field validation (providers/vertex.ts).
      if (!parsed.projectId?.trim()) {
        throw new Error('Project ID is required');
      }
      if (!parsed.location?.trim()) {
        throw new Error('Location is required');
      }
      if (parsed.authType === 'serviceAccount' && !parsed.serviceAccountJson?.trim()) {
        throw new Error('Service account JSON key is required');
      }
      // Vertex credentials ride the standard api-key bucket under 'vertex' —
      // exactly what desktop vertex:save stores; `provider.fetchModels`
      // ('vertex') reads the same bucket daemon-side. The SecureStorageAPI
      // vertex analog of Bedrock's storeBedrockCredentials IS
      // storeApiKey('vertex', json) — no dedicated vertex-secret RPC exists.
      await call('secrets.storeApiKey', { provider: 'vertex', apiKey: stored });
      const label =
        parsed.authType === 'serviceAccount'
          ? 'Service Account'
          : 'Application Default Credentials';
      return {
        id: 'local-vertex',
        provider: 'vertex',
        label,
        keyPrefix: `${parsed.projectId} (${parsed.location})`,
        isActive: true,
        createdAt: new Date().toISOString(),
      } as unknown as ApiKeyConfig;
    }) as AccomplishAPI['saveVertexCredentials'],
    // getBedrockCredentials / getVertexCredentials stay UNAVAILABLE: their
    // backing reads return plaintext credential JSON and are
    // registered-blocklisted (blocklist is binding). No web UI call site
    // exists today — the connect flows re-derive state from the masked
    // provider.getSettings snapshot, matching desktop's null-on-absence
    // semantics.

    // ── Native pickers (Phase 2 — host-side zenity dialogs) ──
    pickFolder: () => transport.pickFolder() as Promise<string | null>,
    pickFiles: () => transport.pickFiles() as Promise<FileAttachmentInfo[]>,

    // ── Deep-link callbacks (accomplish:// OAuth) ──
    onMcpAuthCallback: (callback: (url: string) => void): (() => void) =>
      events.onControlEvent('mcp-callback', (params) => {
        callback((params as { url: string } | undefined)?.url ?? '');
      }),

    // ── Workspaces ──
    listWorkspaces: () => call('workspace.list') as Promise<Workspace[]>,
    getActiveWorkspaceId: () =>
      call('workspace.getActive').then((workspace) => (workspace as Workspace | null)?.id ?? null),
    switchWorkspace: (workspaceId: string) =>
      call('workspace.setActive', { workspaceId }).then(() => ({ success: true })),
    createWorkspace: (input: WorkspaceCreateInput) =>
      call('workspace.create', { input }) as Promise<Workspace>,
    updateWorkspace: (id: string, input: WorkspaceUpdateInput) =>
      call('workspace.update', { workspaceId: id, input }) as Promise<Workspace | null>,
    deleteWorkspace: (id: string) =>
      call('workspace.delete', { workspaceId: id }).then(
        (result) => (result as { deleted: boolean }).deleted,
      ),

    // ── Knowledge notes ──
    listKnowledgeNotes: (workspaceId: string) =>
      call('knowledgeNote.list', { workspaceId }) as Promise<KnowledgeNote[]>,
    createKnowledgeNote: (input: KnowledgeNoteCreateInput) =>
      call('knowledgeNote.create', { input }) as Promise<KnowledgeNote>,
    updateKnowledgeNote: (id: string, workspaceId: string, input: KnowledgeNoteUpdateInput) =>
      call('knowledgeNote.update', {
        noteId: id,
        workspaceId,
        input,
      }) as Promise<KnowledgeNote | null>,
    deleteKnowledgeNote: (id: string, workspaceId: string) =>
      call('knowledgeNote.delete', { noteId: id, workspaceId }),

    // ── Favorites ──
    listFavorites: () => call('favorites.list') as Promise<StoredFavorite[]>,
    removeFavorite: (taskId: string) => call('favorites.remove', { taskId }),
    isFavorite: (taskId: string) => call('favorites.isFavorite', { taskId }) as Promise<boolean>,
    addFavorite: async (taskId: string) => {
      const task = (await call('task.get', { taskId })) as {
        prompt: string;
        summary?: string;
      } | null;
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }
      await call('favorites.add', { taskId, prompt: task.prompt, summary: task.summary });
    },

    // ── Scheduler ──
    listSchedules: (workspaceId?: string) =>
      call('task.listScheduled', { workspaceId }) as Promise<ScheduledTask[]>,
    createSchedule: (cron: string, prompt: string, workspaceId?: string) =>
      call('task.schedule', { cron, prompt, workspaceId }) as Promise<ScheduledTask>,
    deleteSchedule: (scheduleId: string) => call('task.cancelScheduled', { scheduleId }),
    setScheduleEnabled: (scheduleId: string, enabled: boolean) =>
      call('task.setScheduleEnabled', { scheduleId, enabled }),

    // ── Event subscriptions (daemon notifications → renderer callbacks) ──
    onTaskUpdate: (callback: (event: TaskUpdateEvent) => void): (() => void) => {
      const offComplete = events.onNotification('task.complete', (params) => {
        const p = params as { taskId: string; result?: unknown };
        callback({ taskId: p.taskId, type: 'complete', result: p.result as never });
      });
      const offError = events.onNotification('task.error', (params) => {
        const p = params as { taskId: string; error?: string };
        callback({ taskId: p.taskId, type: 'error', error: p.error });
      });
      return () => {
        offComplete();
        offError();
      };
    },
    onTaskUpdateBatch: (
      callback: (event: { taskId: string; messages: TaskMessage[] }) => void,
    ): (() => void) =>
      events.onNotification('task.message', (params) => {
        callback(params as { taskId: string; messages: TaskMessage[] });
      }),
    onTaskProgress: (callback: (progress: TaskProgress) => void): (() => void) =>
      events.onNotification('task.progress', (params) => {
        callback(params as TaskProgress);
      }),
    onPermissionRequest: (callback: (request: PermissionRequest) => void): (() => void) =>
      events.onNotification('permission.request', (params) => {
        callback(params as PermissionRequest);
      }),
    onTaskStatusChange: (
      callback: (data: { taskId: string; status: string }) => void,
    ): (() => void) =>
      events.onNotification('task.statusChange', (params) => {
        callback(params as { taskId: string; status: string });
      }),
    onTaskSummary: (callback: (data: { taskId: string; summary: string }) => void): (() => void) =>
      events.onNotification('task.summary', (params) => {
        callback(params as { taskId: string; summary: string });
      }),
    onTodoUpdate: (callback: (data: { taskId: string; todos: TodoItem[] }) => void): (() => void) =>
      events.onNotification('todo.update', (params) => {
        callback(params as { taskId: string; todos: TodoItem[] });
      }),
    onAuthError: (
      callback: (data: { providerId: string; message: string }) => void,
    ): (() => void) =>
      events.onNotification('auth.error', (params) => {
        callback(params as { providerId: string; message: string });
      }),
    onWorkspaceChanged: (callback: (data: { workspaceId?: string }) => void): (() => void) =>
      events.onNotification('workspace.changed', (params) => {
        callback(params as { workspaceId?: string });
      }),
    onAccomplishAiUsageUpdate: (callback: (usage: unknown) => void): (() => void) =>
      events.onNotification('accomplish-ai.usage-update', (params) => {
        callback(params);
      }),
    onWhatsAppQR: (callback: (qr: string) => void): (() => void) =>
      events.onNotification('whatsapp.qr', (params) => {
        callback((params as { qr: string }).qr);
      }),
    onWhatsAppStatus: (callback: (status: string) => void): (() => void) =>
      events.onNotification('whatsapp.status', (params) => {
        callback((params as { status: string }).status);
      }),
    onThemeChange: (callback: (data: { theme: string; resolved: string }) => void): (() => void) =>
      events.onNotification('settings.changed', (params) => {
        const p = params as { key: string; value?: string };
        if (p.key === 'theme') {
          invalidateSettings();
          callback({ theme: p.value ?? 'system', resolved: p.value ?? 'system' });
        }
      }),
    onDebugModeChange: (callback: (data: { enabled: boolean }) => void): (() => void) =>
      events.onNotification('settings.changed', (params) => {
        const p = params as { key: string; value?: unknown };
        if (p.key === 'debugMode') {
          invalidateSettings();
          callback({ enabled: Boolean(p.value) });
        }
      }),
    onSettingsChangedExternal: onSettingsChanged,

    // ── Daemon connection events (gateway control events) ──
    onDaemonDisconnected: (callback: () => void): (() => void) =>
      events.onControlEvent('daemon:disconnected', callback),
    onDaemonReconnected: (callback: () => void): (() => void) =>
      events.onControlEvent('daemon:reconnected', callback),
    onDaemonReconnectFailed: (callback: () => void): (() => void) =>
      events.onControlEvent('daemon:reconnect-failed', callback),

    // ── Debug log channel: no daemon-side source exists in Phase 1. ──
    onDebugLog: (): (() => void) => () => {},

    // ── HuggingFace download progress: HF local-server control is a
    //    Phase 3 port; the subscription never fires until then. The
    //    get/setHuggingFaceLocalConfig config methods are likewise
    //    deferred to M6 (architect decision) and stay unavailable until
    //    the HF local-server seam ships. ──
    onHuggingFaceDownloadProgress: (): (() => void) => () => {},

    // ── Close confirmation: the Electron window-close flow has no browser
    //    equivalent in Phase 2 — closing the Firefox window is ALWAYS
    //    "keep daemon" (the daemon is a systemd-managed background service
    //    by design). The subscription therefore never fires, and
    //    respondToClose is a harmless no-op. ──
    onCloseRequested:
      (_callback: () => void): (() => void) =>
      () => {},
    respondToClose: (): void => {},

    // ── Analytics: no-op until the Phase 3 batched endpoint. ──
    analytics: new Proxy(
      {},
      {
        get: () => () => Promise.resolve(),
      },
    ),
  };

  // Optional methods (marked `?` on AccomplishAPI) that the gateway shim
  // does not implement. The application guards every one of these with a
  // presence check (e.g. `if (!accomplish.onCloseRequested)`), so the
  // correct browser-shim shape is ABSENCE — returning a throwing function
  // here defeats those guards and crashes the effect path (the Phase 2
  // startup regression: CloseConfirmDialog → RouteErrorFallback).
  const OPTIONAL_NOT_SUPPORTED = new Set([
    'onBrowserFrame',
    'onBrowserNavigate',
    'onBrowserStatus',
    'startBrowserPreview',
    'stopBrowserPreview',
    'getBrowserPreviewStatus',
    'onWorkspaceDeleted',
    'gws',
  ]);

  return new Proxy(core, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      // Promise-protocol introspection must not surface a throwing function.
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        return undefined;
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (OPTIONAL_NOT_SUPPORTED.has(prop)) {
        // Optional and unimplemented — report absence so guards skip it.
        return undefined;
      }
      // Required but not yet implemented — loud, actionable diagnostic.
      return (..._args: unknown[]) => {
        throw new HttpShimNotSupportedError(String(prop));
      };
    },
  }) as unknown as AccomplishAPI;
}

// =============================================================================
// getAccomplish() fallback integration
// =============================================================================

export function isHttpGatewayAvailable(): boolean {
  return isLoopbackHttpOrigin() && readGatewayToken() !== null;
}

/**
 * Build an AccomplishAPI over the gateway when the current page is served
 * by the host (loopback origin + session token). Returns null otherwise so
 * `getAccomplish()` keeps its historical error for plain-Electron-less dev.
 */
export function tryCreateHttpAccomplishApi(): AccomplishAPI | null {
  if (!isHttpGatewayAvailable()) {
    return null;
  }
  const token = readGatewayToken();
  if (!token) {
    return null;
  }
  return createHttpAccomplishApi({ baseUrl: window.location.origin, token });
}
