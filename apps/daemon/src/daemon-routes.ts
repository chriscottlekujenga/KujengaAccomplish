/**
 * Daemon RPC method registration and task event forwarding.
 * Extracted from index.ts to keep the entry point under 200 lines.
 *
 * NO electron imports — this runs as plain Node.js.
 */
import {
  type DaemonRpcServer,
  taskConfigSchema,
  permissionResponseSchema,
  resumeSessionSchema,
  authOpenAiAwaitCompletionSchema,
  validate,
  ALLOWED_API_KEY_PROVIDERS,
  DEFAULT_PROVIDERS,
  STANDARD_VALIDATION_PROVIDERS,
  ZAI_ENDPOINTS,
  fetchBedrockModels,
  fetchLiteLLMModels,
  fetchLMStudioModels,
  fetchNimModels,
  fetchOpenRouterModels,
  fetchProviderModels,
  fetchVertexModels,
  redact,
  safeParseJson,
  sanitizeString,
  testAzureFoundryConnection,
  testCustomConnection,
  testLiteLLMConnection,
  testLMStudioConnection,
  testNimConnection,
  testOllamaConnection,
  validateApiKey,
  validateAzureFoundry,
  validateBedrockCredentials,
  validateVertexCredentials,
} from '@accomplish_ai/agent-core';
import type { AccomplishRuntime, StorageDeps } from '@accomplish_ai/agent-core';
import type {
  BedrockCredentials,
  ProviderType,
  VertexCredentials,
  ZaiRegion,
} from '@accomplish_ai/agent-core';
import { z } from 'zod';
import { homedir } from 'node:os';
import type { TaskService } from './task-service.js';
import type { HealthService } from './health.js';
import type { StorageService } from './storage-service.js';
import type { SchedulerService } from './scheduler-service.js';
import type { WhatsAppDaemonService } from './whatsapp-service.js';
import type { OpenAiOauthManager } from './opencode/auth-openai.js';
import type { SecretsService } from './secrets-service.js';
import type { SettingsService, SettingsChangePayload } from './settings-service.js';
import type { WorkspaceService, WorkspaceChangePayload } from './workspace-service.js';
import type { ConnectorService } from './connector-service.js';
import type { LegacyImportService } from './legacy-import-service.js';
import type { GoogleAccountService } from './google-account-service.js';
import type { SkillsService } from './skills-service.js';
import type { DevBrowserService } from './dev-browser-service.js';
import type {
  GwsAccountAddInput,
  GwsAccountStatusChangedPayload,
  SkillsChangedPayload,
} from '@accomplish_ai/agent-core';

const taskIdSchema = z.object({ taskId: z.string().min(1) });
// taskConfigSchema already includes modelId — no extension needed
const taskStartSchema = taskConfigSchema;

// Host identity & UI-presence validation schemas (Phase 3 M1 security
// foundation).
const clientTypeSchema = z.object({ clientType: z.enum(['gateway', 'legacy']) });
const uiPresenceSchema = z.object({ count: z.number().int().min(0) });

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `Invalid parameters: ${err.issues.map((i) => i.message).join('; ')}`;
  }
  const msg = err instanceof Error ? err.message : 'Internal error';
  if (process.env.NODE_ENV === 'development') {
    return msg;
  }
  const home = homedir();
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return msg.replace(new RegExp(`${escapedHome}(?:[\\\\/][^\\s:]*)?`, 'g'), '~/...');
}

export function safeHandler(
  fn: (params: unknown, clientId: string) => Promise<unknown>,
): (params: unknown, clientId: string) => Promise<unknown> {
  return async (params, clientId) => {
    try {
      return await fn(params, clientId);
    } catch (err) {
      throw new Error(sanitizeErrorMessage(err));
    }
  };
}

// ── Provider connection testing / model discovery (Phase 3 M2 T1a) ───────
// Timeout parity with the desktop's API_KEY_VALIDATION_TIMEOUT_MS
// (apps/desktop/src/main/ipc/handlers/utils.ts).
const PROVIDER_CONNECTION_TIMEOUT_MS = 15000;

interface ProviderTestConnectionParams {
  providerId: string;
  url?: string;
  apiKey?: string;
  endpoint?: string;
  deploymentName?: string;
  authType?: 'api-key' | 'entra-id';
}

interface ProviderFetchModelsParams {
  providerId: string;
  options?: { baseUrl?: string; zaiRegion?: string };
}

interface ProviderRouteServices {
  secretsService: Pick<SecretsService, 'getApiKey' | 'getBedrockCredentials'>;
  settingsService: Pick<
    SettingsService,
    | 'getLiteLLMConfig'
    | 'getLMStudioConfig'
    | 'getNimConfig'
    | 'getAzureFoundryConfig'
    | 'getOpenAiBaseUrl'
  >;
  openAiOauthManager: Pick<OpenAiOauthManager, 'getAccessToken'>;
}

/**
 * Run a provider error message through redaction so it can safely cross the
 * RPC boundary: pattern-based redaction covers credential-shaped strings
 * (sk-…, Bearer …, key=…), and an exact-substring pass guarantees the
 * provided-in-request `apiKey` itself never echoes back (URL-embedded
 * credentials, hostile server error echo).
 */
export function redactProviderError(message: string, apiKey?: string): string {
  const withoutKey = apiKey ? message.split(apiKey).join('[REDACTED]') : message;
  return redact(withoutKey);
}

/** JSON fields inside Bedrock/Vertex credential documents whose values are
 *  live secret material (camelCase + gcloud-style snake_case variants). */
const SECRET_CREDENTIAL_FIELDS = [
  'apiKey',
  'secretAccessKey',
  'accessKeyId',
  'sessionToken',
  'serviceAccountJson',
  'privateKey',
  'private_key',
] as const;

function collectSecretCredentialParts(
  node: Record<string, unknown>,
  parts: string[],
  depth = 0,
): void {
  for (const field of SECRET_CREDENTIAL_FIELDS) {
    const value = node[field];
    if (typeof value === 'string' && value.trim().length > 0 && !parts.includes(value)) {
      parts.push(value);
    }
  }
  // Service-account credentials embed a second JSON document whose
  // private_key is the crown jewel — dig one level deeper for it.
  const serviceAccountJson = node.serviceAccountJson;
  if (depth === 0 && typeof serviceAccountJson === 'string') {
    const inner = safeParseJson<Record<string, unknown>>(serviceAccountJson);
    if (inner.success) {
      collectSecretCredentialParts(inner.data, parts, depth + 1);
    }
  }
}

/**
 * Bedrock/Vertex counterpart of `redactProviderError` (Phase 3 M2 §A3):
 * validation happens BEFORE the credentials are ever stored, so the
 * credentials travel in the REQUEST and may never echo back — even inside
 * an AWS/GCP error message. Exact-substring redaction covers every
 * secret-shaped field of the credential document; the pattern pass catches
 * credential-shaped strings the SDKs interpolate.
 */
export function redactCredentialError(message: string, credentialsJson: string): string {
  const parts: string[] = [];
  const parsed = safeParseJson<Record<string, unknown>>(credentialsJson);
  if (parsed.success) {
    collectSecretCredentialParts(parsed.data, parts);
  }
  let redactedMessage = message;
  for (const secret of parts) {
    redactedMessage = redactedMessage.split(secret).join('[REDACTED]');
  }
  return redact(redactedMessage);
}

const PROVIDER_TEST_URL_REQUIRED = 'URL is required for this provider';

function normalizeProviderOptions(raw: Record<string, unknown> | undefined): {
  baseUrl?: string;
  zaiRegion?: ZaiRegion;
  deploymentName?: string;
  authType?: 'api-key' | 'entra-id';
} {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const opts: {
    baseUrl?: string;
    zaiRegion?: ZaiRegion;
    deploymentName?: string;
    authType?: 'api-key' | 'entra-id';
  } = {};
  if (typeof raw.baseUrl === 'string') {
    opts.baseUrl = raw.baseUrl;
  }
  // Both fieldnames accepted; zaiRegion wins if both are present (desktop
  // normalizeProviderOptions parity).
  const regionValue = raw.zaiRegion ?? raw.region;
  if (typeof regionValue === 'string') {
    opts.zaiRegion = regionValue as ZaiRegion;
  }
  if (typeof raw.deploymentName === 'string') {
    opts.deploymentName = raw.deploymentName;
  }
  if (typeof raw.authType === 'string') {
    opts.authType = raw.authType as 'api-key' | 'entra-id';
  }
  return opts;
}

/**
 * Mirror of the desktop per-provider test-connection handlers
 * (provider-config-handlers/*): provider-native result shapes are preserved
 * and every response error is redacted before it crosses the socket — the
 * provided-in-request `apiKey` must never echo back in an error.
 */
export async function testProviderConnection(
  params: ProviderTestConnectionParams,
  services: ProviderRouteServices,
): Promise<{ success: boolean; models?: unknown[]; error?: string }> {
  const { apiKey } = params;
  const raw = await testProviderConnectionRaw(params, services);
  if (raw.error) {
    return { ...raw, error: redactProviderError(raw.error, apiKey) };
  }
  return raw;
}

async function testProviderConnectionRaw(
  params: ProviderTestConnectionParams,
  services: ProviderRouteServices,
): Promise<{ success: boolean; models?: unknown[]; error?: string }> {
  const { providerId, apiKey } = params;
  switch (providerId) {
    case 'ollama': {
      if (!params.url) {
        return { success: false, error: PROVIDER_TEST_URL_REQUIRED };
      }
      return testOllamaConnection(params.url);
    }
    case 'litellm': {
      if (!params.url) {
        return { success: false, error: PROVIDER_TEST_URL_REQUIRED };
      }
      const key = params.apiKey ?? services.secretsService.getApiKey('litellm') ?? undefined;
      return testLiteLLMConnection(params.url, key);
    }
    case 'lmstudio': {
      if (!params.url) {
        return { success: false, error: PROVIDER_TEST_URL_REQUIRED };
      }
      return testLMStudioConnection({ url: params.url });
    }
    case 'nim': {
      if (!params.url) {
        return { success: false, error: PROVIDER_TEST_URL_REQUIRED };
      }
      // The key may arrive pre-store from the UI or resolve to the stored one.
      const key = params.apiKey ?? services.secretsService.getApiKey('nim') ?? '';
      return testNimConnection(params.url, key);
    }
    case 'custom': {
      if (!params.url) {
        return { success: false, error: PROVIDER_TEST_URL_REQUIRED };
      }
      const key = params.apiKey ?? services.secretsService.getApiKey('custom') ?? undefined;
      return testCustomConnection(params.url, key);
    }
    case 'azure-foundry': {
      if (!params.endpoint || !params.deploymentName || !params.authType) {
        return {
          success: false,
          error: 'endpoint, deploymentName and authType are required for this provider',
        };
      }
      return testAzureFoundryConnection({
        endpoint: params.endpoint,
        deploymentName: params.deploymentName,
        authType: params.authType,
        apiKey,
        timeout: PROVIDER_CONNECTION_TIMEOUT_MS,
      });
    }
    default:
      return { success: false, error: `Unsupported provider: ${providerId}` };
  }
}

/**
 * Mirror of desktop model-discovery-handlers.ts with one hard invariant:
 * keys resolve daemon-side (`secretsService.getApiKey` / OAuth manager) and
 * NEVER cross the socket — the shim/UI half sends provider id + options only.
 * Error strings are pattern-redacted before crossing back (a hostile fetch
 * target cannot echo stored key material into the UI).
 */
export async function fetchProviderModelsOverRpc(
  providerId: string,
  options: ProviderFetchModelsParams['options'],
  services: ProviderRouteServices,
): Promise<{ success: boolean; models?: unknown[]; error?: string }> {
  const { raw, apiKey } = await fetchProviderModelsRaw(providerId, options, services);
  if (raw.error) {
    return { ...raw, error: redactProviderError(raw.error, apiKey ?? undefined) };
  }
  return raw;
}

async function fetchProviderModelsRaw(
  providerId: string,
  options: ProviderFetchModelsParams['options'],
  services: ProviderRouteServices,
): Promise<{ raw: { success: boolean; models?: unknown[]; error?: string }; apiKey?: string }> {
  const storedKey = services.secretsService.getApiKey(providerId);
  switch (providerId) {
    case 'openrouter': {
      return {
        raw: await fetchOpenRouterModels(storedKey ?? '', PROVIDER_CONNECTION_TIMEOUT_MS),
        apiKey: storedKey ?? undefined,
      };
    }
    case 'litellm': {
      return {
        raw: await fetchLiteLLMModels({
          config: services.settingsService.getLiteLLMConfig(),
          apiKey: storedKey || undefined,
        }),
        apiKey: storedKey ?? undefined,
      };
    }
    case 'lmstudio': {
      const config = services.settingsService.getLMStudioConfig();
      if (!config || !config.baseUrl) {
        return { raw: { success: false, error: 'No LM Studio configured' } };
      }
      return { raw: await fetchLMStudioModels({ baseUrl: config.baseUrl }) };
    }
    case 'nim': {
      return {
        raw: await fetchNimModels({
          config: services.settingsService.getNimConfig(),
          apiKey: storedKey || undefined,
        }),
        apiKey: storedKey ?? undefined,
      };
    }
    case 'bedrock': {
      const credentials = services.secretsService.getBedrockCredentials();
      if (!credentials) {
        return { raw: { success: false, error: 'No API key found for this provider' } };
      }
      // StorageAPI types the parsed JSON as Record<string, string> — the
      // recorded shape is BedrockCredentials (desktop bedrock:get-credentials
      // does the same JSON round-trip).
      return { raw: await fetchBedrockModels(credentials as unknown as BedrockCredentials) };
    }
    case 'vertex': {
      if (!storedKey) {
        return { raw: { success: false, error: 'No API key found for this provider' } };
      }
      const parsed = safeParseJson<VertexCredentials>(storedKey);
      if (!parsed.success) {
        return {
          raw: { success: false, error: 'Stored Vertex AI credentials could not be parsed' },
        };
      }
      return { raw: await fetchVertexModels(parsed.data) };
    }
  }

  // Config-driven providers (openai, zai, anthropic, google, ...).
  const providerConfig = DEFAULT_PROVIDERS.find((p) => p.id === providerId);
  if (!providerConfig?.modelsEndpoint) {
    return { raw: { success: false, error: 'No models endpoint configured for this provider' } };
  }

  let apiKey: string | null = storedKey;
  if (!apiKey && providerId === 'openai') {
    apiKey = services.openAiOauthManager.getAccessToken();
  }
  if (!apiKey) {
    return { raw: { success: false, error: 'No API key found for this provider' } };
  }

  let urlOverride: string | undefined;
  let endpointConfig = providerConfig.modelsEndpoint;
  if (providerId === 'openai' && typeof options?.baseUrl === 'string' && options.baseUrl) {
    urlOverride = `${options.baseUrl.replace(/\/+$/, '')}/models`;
    endpointConfig = { ...endpointConfig, modelFilter: undefined };
  }
  if (providerId === 'zai' && options?.zaiRegion) {
    const zaiUrl = ZAI_ENDPOINTS[options.zaiRegion as ZaiRegion];
    if (zaiUrl) {
      urlOverride = `${zaiUrl}/models`;
    }
  }

  return {
    raw: await fetchProviderModels({
      endpointConfig,
      apiKey,
      urlOverride,
      timeout: PROVIDER_CONNECTION_TIMEOUT_MS,
    }),
    apiKey,
  };
}

/**
 * Mirror of desktop `api-key:validate-provider` (api-key-validation-handlers):
 * ALLOWED/STANDARD provider gating, sanitize + stored-URL fallback for
 * standard providers, azure-foundry against stored config, and a
 * skip-validation pass-through for local/custom providers. Errors are
 * redacted before crossing the socket.
 */
export async function validateProviderKey(
  providerId: string,
  key: string,
  rawOptions: Record<string, unknown> | undefined,
  services: ProviderRouteServices,
): Promise<{ valid: boolean; error?: string }> {
  if (!ALLOWED_API_KEY_PROVIDERS.has(providerId)) {
    return { valid: false, error: 'Unsupported provider' };
  }

  const options = normalizeProviderOptions(rawOptions);

  if (STANDARD_VALIDATION_PROVIDERS.has(providerId)) {
    let sanitizedKey: string;
    try {
      sanitizedKey = sanitizeString(key, 'apiKey', 256);
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : 'Invalid API key' };
    }

    // OpenAI-compatible providers fall back to the user-configured base URL
    // when the caller didn't supply one — desktop parity, the URL lives in
    // the daemon's app-settings.
    let openAiBaseUrlFallback: string | undefined;
    if (providerId === 'openai') {
      const rawBaseUrl = options.baseUrl;
      if (typeof rawBaseUrl === 'string' && rawBaseUrl.trim()) {
        openAiBaseUrlFallback = rawBaseUrl.trim();
      } else {
        try {
          openAiBaseUrlFallback = services.settingsService.getOpenAiBaseUrl().trim() || undefined;
        } catch {
          openAiBaseUrlFallback = undefined;
        }
      }
    }

    const result = await validateApiKey(providerId as ProviderType, sanitizedKey, {
      timeout: PROVIDER_CONNECTION_TIMEOUT_MS,
      baseUrl: openAiBaseUrlFallback,
      zaiRegion: providerId === 'zai' ? options.zaiRegion || 'international' : undefined,
    });
    return result.error ? { ...result, error: redactProviderError(result.error, key) } : result;
  }

  if (providerId === 'azure-foundry') {
    const config = services.settingsService.getAzureFoundryConfig();
    const result = await validateAzureFoundry(config, {
      apiKey: key,
      baseUrl: typeof options.baseUrl === 'string' ? options.baseUrl : undefined,
      deploymentName: options.deploymentName,
      authType: options.authType,
      timeout: PROVIDER_CONNECTION_TIMEOUT_MS,
    });
    return result.error ? { ...result, error: redactProviderError(result.error, key) } : result;
  }

  return { valid: true };
}

export interface RouteServices {
  rpc: DaemonRpcServer;
  taskService: TaskService;
  healthService: HealthService;
  storageService: StorageService;
  schedulerService: SchedulerService;
  accomplishRuntime: AccomplishRuntime;
  whatsappService: WhatsAppDaemonService;
  /** OAuth manager (Phase 4a of the SDK cutover port). Owns transient
   *  `opencode serve` spawns + the SDK auth flow + plan detection. */
  openAiOauthManager: OpenAiOauthManager;
  // Milestone 2 of the daemon-only-SQLite migration. Five thin services
  // that expose the StorageAPI + ConnectorStorageAPI surfaces over RPC.
  // Main doesn't consume them yet; they're registered so M3/M5 can
  // progressively repoint desktop callers.
  secretsService: SecretsService;
  settingsService: SettingsService;
  workspaceService: WorkspaceService;
  connectorService: ConnectorService;
  legacyImportService: LegacyImportService;
  // Milestone 4 — daemon takes over Google accounts + skills ownership.
  googleAccountService: GoogleAccountService;
  skillsService: SkillsService;
  // Phase 3 M1 — dev-browser preview bridge. Answers `devBrowser.*` RPCs from
  // the daemon-owned sidecar state; the bearer token never leaves the daemon.
  devBrowserService: DevBrowserService;
}

/**
 * Register all RPC methods on the server.
 */
export function registerRpcMethods(services: RouteServices): void {
  const {
    rpc,
    taskService,
    healthService,
    schedulerService,
    accomplishRuntime,
    whatsappService,
    openAiOauthManager,
    secretsService,
    settingsService,
    workspaceService,
    connectorService,
    legacyImportService,
    googleAccountService,
    skillsService,
    devBrowserService,
  } = services;
  const storage = services.storageService.getStorage();

  // ── Host identity & UI-presence (Phase 3 M1 security foundation) ────────
  // Host-to-daemon internal methods: the host types its own socket
  // connection and reports live browser-UI counts. They are deliberately
  // NOT in the gateway's browser-facing allowlist (apps/host/src/policy.ts
  // is untouched) — a browser can never reach them, and the 0600 daemon
  // socket guarantees only same-user processes can call them at all.
  // Handlers receive the caller's clientId (second handler argument) so the
  // presence state is bound to THAT socket connection.
  rpc.registerMethod(
    'daemon.setClientType',
    safeHandler((params, clientId) => {
      const v = validate(clientTypeSchema, params);
      rpc.setClientType(clientId, v.clientType);
      return Promise.resolve({ ok: true as const });
    }),
  );
  rpc.registerMethod(
    'daemon.setUiPresence',
    safeHandler((params, clientId) => {
      const v = validate(uiPresenceSchema, params);
      rpc.setUiPresence(clientId, v.count);
      return Promise.resolve({ ok: true as const });
    }),
  );

  // ── Dev-browser preview bridge (Phase 3 M1) ─────────────────────────────
  // INTERNAL host↔daemon methods answering from the daemon-owned sidecar
  // state. Deliberately NOT in apps/host/src/policy.ts's allowlist (untouched
  // file, default-deny) so a browser can never reach them — same trust level
  // as daemon.setClientType/setUiPresence above. The bearer token never
  // crosses RPC; only the loopback wsEndpoint URL and page names do. Results
  // degrade to nulls (no throw) when the sidecar is down so the desktop
  // preview keeps its non-crashing fallback semantics.
  rpc.registerMethod(
    'devBrowser.getPreviewInfo',
    safeHandler(() => devBrowserService.getPreviewInfo()),
  );
  rpc.registerMethod(
    'devBrowser.openPreviewPage',
    safeHandler((params) => {
      const v = validate(
        z.object({
          name: z.string().min(1),
          viewport: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
        }),
        params,
      );
      return devBrowserService.openPreviewPage(v);
    }),
  );

  rpc.registerMethod(
    'task.start',
    safeHandler((params) => {
      const validated = validate(taskStartSchema, params);
      return taskService.startTask(validated);
    }),
  );
  rpc.registerMethod(
    'task.stop',
    safeHandler((params) => {
      const validated = validate(taskIdSchema, params);
      return taskService.stopTask(validated);
    }),
  );
  rpc.registerMethod(
    'task.list',
    safeHandler((params) => {
      const raw =
        params && typeof params === 'object' && 'workspaceId' in params
          ? (params as { workspaceId?: unknown }).workspaceId
          : undefined;
      const workspaceId = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
      const includeUnassigned =
        params && typeof params === 'object' && 'includeUnassigned' in params
          ? (params as { includeUnassigned?: unknown }).includeUnassigned === true
          : false;
      return Promise.resolve(taskService.listTasks(workspaceId, includeUnassigned));
    }),
  );
  rpc.registerMethod(
    'task.status',
    safeHandler((params) => {
      const validated = validate(taskIdSchema, params);
      return Promise.resolve(taskService.getTaskStatus(validated));
    }),
  );
  rpc.registerMethod(
    'task.interrupt',
    safeHandler((params) => {
      const validated = validate(taskIdSchema, params);
      return taskService.interruptTask(validated);
    }),
  );
  rpc.registerMethod(
    'task.get',
    safeHandler((params) => {
      const validated = validate(taskIdSchema, params);
      return Promise.resolve(storage.getTask(validated.taskId) || null);
    }),
  );
  rpc.registerMethod(
    'task.delete',
    safeHandler(async (params) => {
      const validated = validate(taskIdSchema, params);
      if (taskService.hasActiveTask(validated.taskId)) {
        await taskService.stopTask({ taskId: validated.taskId });
      }
      storage.deleteTask(validated.taskId);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'task.clearHistory',
    safeHandler(() => {
      if (taskService.getActiveTaskCount() > 0) {
        throw new Error('Cannot clear history while tasks are active or queued');
      }
      storage.clearHistory();
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'task.getTodos',
    safeHandler((params) => {
      const validated = validate(taskIdSchema, params);
      return Promise.resolve(storage.getTodosForTask(validated.taskId));
    }),
  );
  rpc.registerMethod(
    'permission.respond',
    // Rewritten in Phase 2 of the SDK cutover port (commercial PR #720).
    //
    // Pre-port: resolved an in-memory promise map held by `PermissionService`;
    // the HTTP handler awaiting the promise returned the decision back to
    // the `opencode` CLI over its /permission or /question callback.
    //
    // Post-port: `PermissionService` is deleted. The daemon forwards the
    // structured response directly to `TaskService.sendResponse`, which
    // routes to `TaskManager.sendResponse` → `OpenCodeAdapter.sendResponse` →
    // `client.permission.reply` / `client.question.reply` on the SDK v2
    // client. The `taskId` field was added to `permissionResponseSchema`
    // specifically for this routing — without it the daemon cannot scope
    // the reply to a specific in-flight task.
    safeHandler(async (params) => {
      const validated = validate(permissionResponseSchema, params);
      const { taskId, requestId, decision, selectedOptions, customText } = validated;
      // Defensive taskId check. Without it, a bogus taskId (stale UI,
      // double-click, replay of a cancelled task) cascades an error from
      // deep inside `OpenCodeAdapter.sendResponse` (`pending` is null, or
      // the adapter doesn't exist), producing a confusing stack trace
      // rather than a clean "unknown task" RPC error.
      if (!taskService.hasActiveTask(taskId)) {
        throw new Error(
          `permission.respond: no active task with id=${taskId}. The task may have completed, been cancelled, or never existed.`,
        );
      }
      await taskService.sendResponse(taskId, {
        requestId,
        taskId,
        decision,
        ...(selectedOptions ? { selectedOptions } : {}),
        ...(customText ? { customText } : {}),
      });
    }),
  );
  rpc.registerMethod(
    'session.resume',
    safeHandler((params) => {
      const validated = validate(resumeSessionSchema, params);
      return taskService.resumeSession(validated);
    }),
  );
  rpc.registerMethod(
    'health.check',
    safeHandler(() => Promise.resolve(healthService.getStatus())),
  );

  // Alias: desktop IPC uses 'task.cancel', daemon-routes registers 'task.stop'
  rpc.registerMethod(
    'task.cancel',
    safeHandler((params) => {
      const validated = validate(taskIdSchema, params);
      return taskService.stopTask(validated);
    }),
  );

  rpc.registerMethod(
    'task.getActiveCount',
    safeHandler(() => Promise.resolve(taskService.getActiveTaskCount())),
  );

  // ── Scheduler ────────────────────────────────────────────────────────────
  rpc.registerMethod(
    'task.schedule',
    safeHandler((params) => {
      const validated = validate(
        z.object({
          cron: z.string().min(1),
          prompt: z.string().min(1),
          workspaceId: z.string().optional(),
        }),
        params,
      );
      return Promise.resolve(
        schedulerService.createSchedule(validated.cron, validated.prompt, validated.workspaceId),
      );
    }),
  );
  rpc.registerMethod(
    'task.listScheduled',
    safeHandler((params) => {
      const workspaceId =
        params && typeof params === 'object' && 'workspaceId' in params
          ? (params as { workspaceId?: string }).workspaceId
          : undefined;
      return Promise.resolve(schedulerService.listSchedules(workspaceId));
    }),
  );
  rpc.registerMethod(
    'task.cancelScheduled',
    safeHandler((params) => {
      const validated = validate(z.object({ scheduleId: z.string().min(1) }), params);
      schedulerService.deleteSchedule(validated.scheduleId);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'task.setScheduleEnabled',
    safeHandler((params) => {
      const validated = validate(
        z.object({ scheduleId: z.string().min(1), enabled: z.boolean() }),
        params,
      );
      schedulerService.setEnabled(validated.scheduleId, validated.enabled);
      return Promise.resolve();
    }),
  );

  // ── Accomplish AI Free Tier ─────────────────────────────────────────────
  // StorageDeps constructed from daemon's own secure storage — no callbacks over RPC.
  const accomplishStorageDeps: StorageDeps = {
    readKey: (key) => storage.get(key),
    writeKey: (key, value) => storage.set(key, value),
    readGaClientId: () => null, // GA client ID not available in daemon
  };

  rpc.registerMethod(
    'accomplish-ai.connect',
    safeHandler(async () => {
      const result = await accomplishRuntime.connect(accomplishStorageDeps);
      return { deviceFingerprint: result.deviceFingerprint, usage: result.usage };
    }),
  );

  rpc.registerMethod(
    'accomplish-ai.get-usage',
    safeHandler(async () => {
      return accomplishRuntime.getUsage();
    }),
  );

  rpc.registerMethod(
    'accomplish-ai.disconnect',
    safeHandler(async () => {
      accomplishRuntime.disconnect();
      return Promise.resolve();
    }),
  );

  // Bridge proxy usage updates to daemon notifications → forwarded to renderer via IPC
  accomplishRuntime.onUsageUpdate((usage) => {
    rpc.notify('accomplish-ai.usage-update', usage);
  });

  // ── WhatsApp ─────────────────────────────────────────────────────────────
  rpc.registerMethod(
    'whatsapp.connect',
    safeHandler(() => whatsappService.connect()),
  );
  rpc.registerMethod(
    'whatsapp.disconnect',
    safeHandler(() => whatsappService.disconnect()),
  );
  rpc.registerMethod(
    'whatsapp.getConfig',
    safeHandler(() => Promise.resolve(whatsappService.getConfig())),
  );
  rpc.registerMethod(
    'whatsapp.setEnabled',
    safeHandler((params) => {
      const validated = validate(z.object({ enabled: z.boolean() }), params);
      whatsappService.setEnabled(validated.enabled);
      return Promise.resolve();
    }),
  );

  // ---------------------------------------------------------------------------
  // OpenAI ChatGPT OAuth (Phase 4a of the SDK cutover port, commercial PR #720)
  //
  // Four-method protocol. Desktop IPC handler runs:
  //   startLogin → shell.openExternal(authorizeUrl) → awaitCompletion.
  // `status` and `getAccessToken` are non-flow reads used by settings UI
  // and model-discovery respectively.
  // ---------------------------------------------------------------------------
  rpc.registerMethod(
    'auth.openai.startLogin',
    safeHandler(async () => {
      return openAiOauthManager.startLogin();
    }),
  );
  rpc.registerMethod(
    'auth.openai.awaitCompletion',
    safeHandler(async (params) => {
      const validated = validate(authOpenAiAwaitCompletionSchema, params);
      return openAiOauthManager.awaitCompletion(validated);
    }),
  );
  rpc.registerMethod(
    'auth.openai.status',
    safeHandler(() => Promise.resolve(openAiOauthManager.status())),
  );
  rpc.registerMethod(
    'auth.openai.getAccessToken',
    safeHandler(() => Promise.resolve(openAiOauthManager.getAccessToken())),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Milestone 2 of the daemon-only-SQLite migration.
  //
  // Everything below this line is additive: new RPC endpoints and change
  // notifications for the storage surface main currently opens itself.
  // No existing route is modified. Desktop consumes these incrementally
  // during M3 + M5.
  //
  // Validation strategy: inline zod schemas. A single shared file would
  // help reuse, but these are all trivial (one string / one bool / a typed
  // config object) and scoping them here keeps the related `registerMethod`
  // call self-contained.
  // ═══════════════════════════════════════════════════════════════════════

  const providerIdSchema = z
    .string()
    .min(1)
    .describe('ProviderId — any value of the ProviderId type literal');

  // ── Secrets ──────────────────────────────────────────────────────────────
  rpc.registerMethod(
    'secrets.storeApiKey',
    safeHandler((params) => {
      const v = validate(
        z.object({ provider: z.string().min(1), apiKey: z.string().min(1) }),
        params,
      );
      secretsService.storeApiKey(v.provider, v.apiKey);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'secrets.getApiKey',
    safeHandler((params) => {
      const v = validate(z.object({ provider: z.string().min(1) }), params);
      return Promise.resolve(secretsService.getApiKey(v.provider));
    }),
  );
  rpc.registerMethod(
    'secrets.deleteApiKey',
    safeHandler((params) => {
      const v = validate(z.object({ provider: z.string().min(1) }), params);
      return Promise.resolve(secretsService.deleteApiKey(v.provider));
    }),
  );
  rpc.registerMethod(
    'secrets.getAllApiKeys',
    safeHandler(() => secretsService.getAllApiKeys()),
  );
  rpc.registerMethod(
    'secrets.hasAnyApiKey',
    safeHandler(() => secretsService.hasAnyApiKey()),
  );
  // Masked read (Phase 3 M2): `{ provider: { exists, prefix? } }` — plaintext
  // siblings (`secrets.getApiKey`/`secrets.getAllApiKeys`) stay plaintext-never.
  rpc.registerMethod(
    'secrets.listApiKeys',
    safeHandler(() => secretsService.listApiKeysMasked()),
  );
  rpc.registerMethod(
    'secrets.storeBedrockCredentials',
    safeHandler((params) => {
      const v = validate(z.object({ credentials: z.string().min(1) }), params);
      secretsService.storeBedrockCredentials(v.credentials);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'secrets.getBedrockCredentials',
    safeHandler(() => Promise.resolve(secretsService.getBedrockCredentials())),
  );
  rpc.registerMethod(
    'secrets.clear',
    safeHandler(() => {
      secretsService.clear();
      return Promise.resolve();
    }),
  );

  // ── Settings — app-level ─────────────────────────────────────────────────
  rpc.registerMethod(
    'settings.getAll',
    safeHandler(() => Promise.resolve(settingsService.getAll())),
  );
  rpc.registerMethod(
    'settings.setTheme',
    safeHandler((params) => {
      const v = validate(z.object({ theme: z.enum(['system', 'light', 'dark']) }), params);
      settingsService.setTheme(v.theme);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.setLanguage',
    safeHandler((params) => {
      const v = validate(
        z.object({ language: z.enum(['auto', 'en', 'zh-CN', 'ru', 'fr']) }),
        params,
      );
      settingsService.setLanguage(v.language);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.setDebugMode',
    safeHandler((params) => {
      const v = validate(z.object({ enabled: z.boolean() }), params);
      settingsService.setDebugMode(v.enabled);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.setNotificationsEnabled',
    safeHandler((params) => {
      const v = validate(z.object({ enabled: z.boolean() }), params);
      settingsService.setNotificationsEnabled(v.enabled);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getNotificationsEnabled',
    safeHandler(() => Promise.resolve(settingsService.getNotificationsEnabled())),
  );
  rpc.registerMethod(
    'settings.setCloseBehavior',
    safeHandler((params) => {
      const v = validate(z.object({ behavior: z.enum(['keep-daemon', 'stop-daemon']) }), params);
      settingsService.setCloseBehavior(v.behavior);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getCloseBehavior',
    safeHandler(() => Promise.resolve(settingsService.getCloseBehavior())),
  );
  // Sandbox / cloud-browser / messaging configs are typed objects; their
  // Zod schemas would duplicate the TypeScript types. Pass-through `.unknown()`
  // for the config payload and trust the type at the call site — misuse
  // surfaces as a StorageAPI-level error, not a silent no-op.
  rpc.registerMethod(
    'settings.setSandboxConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown() }), params);
      settingsService.setSandboxConfig(
        v.config as Parameters<typeof settingsService.setSandboxConfig>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getSandboxConfig',
    safeHandler(() => Promise.resolve(settingsService.getSandboxConfig())),
  );
  rpc.registerMethod(
    'settings.setCloudBrowserConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setCloudBrowserConfig(
        v.config as Parameters<typeof settingsService.setCloudBrowserConfig>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getCloudBrowserConfig',
    safeHandler(() => Promise.resolve(settingsService.getCloudBrowserConfig())),
  );
  rpc.registerMethod(
    'settings.setMessagingConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setMessagingConfig(
        v.config as Parameters<typeof settingsService.setMessagingConfig>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getMessagingConfig',
    safeHandler(() => Promise.resolve(settingsService.getMessagingConfig())),
  );
  rpc.registerMethod(
    'settings.setOnboardingComplete',
    safeHandler((params) => {
      const v = validate(z.object({ complete: z.boolean() }), params);
      settingsService.setOnboardingComplete(v.complete);
      return Promise.resolve();
    }),
  );

  // ── Selected model + provider configs (app-settings writers) ────────────
  // Typed config objects pass through as `z.unknown()` — the TS contract at
  // the `DaemonMethodMap` level is the source of truth for their shapes.
  rpc.registerMethod(
    'settings.getSelectedModel',
    safeHandler(() => Promise.resolve(settingsService.getSelectedModel())),
  );
  rpc.registerMethod(
    'settings.setSelectedModel',
    safeHandler((params) => {
      const v = validate(z.object({ model: z.unknown() }), params);
      settingsService.setSelectedModel(
        v.model as Parameters<typeof settingsService.setSelectedModel>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getOpenAiBaseUrl',
    safeHandler(() => Promise.resolve(settingsService.getOpenAiBaseUrl())),
  );
  rpc.registerMethod(
    'settings.setOpenAiBaseUrl',
    safeHandler((params) => {
      const v = validate(z.object({ baseUrl: z.string() }), params);
      settingsService.setOpenAiBaseUrl(v.baseUrl);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getOllamaConfig',
    safeHandler(() => Promise.resolve(settingsService.getOllamaConfig())),
  );
  rpc.registerMethod(
    'settings.setOllamaConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setOllamaConfig(
        v.config as Parameters<typeof settingsService.setOllamaConfig>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getLiteLLMConfig',
    safeHandler(() => Promise.resolve(settingsService.getLiteLLMConfig())),
  );
  rpc.registerMethod(
    'settings.setLiteLLMConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setLiteLLMConfig(
        v.config as Parameters<typeof settingsService.setLiteLLMConfig>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getAzureFoundryConfig',
    safeHandler(() => Promise.resolve(settingsService.getAzureFoundryConfig())),
  );
  rpc.registerMethod(
    'settings.setAzureFoundryConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setAzureFoundryConfig(
        v.config as Parameters<typeof settingsService.setAzureFoundryConfig>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getLMStudioConfig',
    safeHandler(() => Promise.resolve(settingsService.getLMStudioConfig())),
  );
  rpc.registerMethod(
    'settings.setLMStudioConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setLMStudioConfig(
        v.config as Parameters<typeof settingsService.setLMStudioConfig>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'settings.getNimConfig',
    safeHandler(() => Promise.resolve(settingsService.getNimConfig())),
  );
  rpc.registerMethod(
    'settings.setNimConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setNimConfig(v.config as Parameters<typeof settingsService.setNimConfig>[0]);
      return Promise.resolve();
    }),
  );

  // ── Settings — provider ──────────────────────────────────────────────────
  rpc.registerMethod(
    'provider.getSettings',
    safeHandler(() => Promise.resolve(settingsService.getProviderSettings())),
  );
  rpc.registerMethod(
    'provider.setActive',
    safeHandler((params) => {
      const v = validate(z.object({ providerId: providerIdSchema.nullable() }), params);
      settingsService.setActiveProvider(
        v.providerId as Parameters<typeof settingsService.setActiveProvider>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'provider.setConnected',
    safeHandler((params) => {
      const v = validate(z.object({ providerId: providerIdSchema, provider: z.unknown() }), params);
      settingsService.setConnectedProvider(
        v.providerId as Parameters<typeof settingsService.setConnectedProvider>[0],
        v.provider as Parameters<typeof settingsService.setConnectedProvider>[1],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'provider.removeConnected',
    safeHandler((params) => {
      const v = validate(z.object({ providerId: providerIdSchema }), params);
      settingsService.removeConnectedProvider(
        v.providerId as Parameters<typeof settingsService.removeConnectedProvider>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'provider.updateModel',
    safeHandler((params) => {
      const v = validate(
        z.object({ providerId: providerIdSchema, modelId: z.string().nullable() }),
        params,
      );
      settingsService.updateProviderModel(
        v.providerId as Parameters<typeof settingsService.updateProviderModel>[0],
        v.modelId,
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'provider.setDebugMode',
    safeHandler((params) => {
      const v = validate(z.object({ enabled: z.boolean() }), params);
      settingsService.setProviderDebugMode(v.enabled);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'provider.getDebugMode',
    safeHandler(() => Promise.resolve(settingsService.getProviderDebugMode())),
  );
  rpc.registerMethod(
    'provider.getAccomplishAiCredits',
    safeHandler(() => Promise.resolve(settingsService.getAccomplishAiCredits())),
  );
  rpc.registerMethod(
    'provider.saveAccomplishAiCredits',
    safeHandler((params) => {
      const v = validate(z.object({ usage: z.unknown() }), params);
      settingsService.saveAccomplishAiCredits(
        v.usage as Parameters<typeof settingsService.saveAccomplishAiCredits>[0],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'provider.getHuggingFaceLocalConfig',
    safeHandler(() => Promise.resolve(settingsService.getHuggingFaceLocalConfig())),
  );
  rpc.registerMethod(
    'provider.setHuggingFaceLocalConfig',
    safeHandler((params) => {
      const v = validate(z.object({ config: z.unknown().nullable() }), params);
      settingsService.setHuggingFaceLocalConfig(
        v.config as Parameters<typeof settingsService.setHuggingFaceLocalConfig>[0],
      );
      return Promise.resolve();
    }),
  );

  // ── Provider connection testing / model discovery (Phase 3 M2 T1a) ──────
  // Dispatchers above (testProviderConnection / fetchProviderModelsOverRpc /
  // validateProviderKey) mirror the desktop per-provider IPC handlers. Keys
  // resolve daemon-side; request-embedded keys pass one-way to the daemon
  // (testConnection / validateKey) and never appear in responses.
  const providerTestConnectionSchema = z.object({
    providerId: providerIdSchema,
    url: z.string().optional(),
    apiKey: z.string().optional(),
    endpoint: z.string().optional(),
    deploymentName: z.string().optional(),
    authType: z.enum(['api-key', 'entra-id']).optional(),
  });
  rpc.registerMethod(
    'provider.testConnection',
    safeHandler(async (params) => {
      const v = validate(providerTestConnectionSchema, params);
      return testProviderConnection(v, {
        secretsService,
        settingsService,
        openAiOauthManager,
      });
    }),
  );
  rpc.registerMethod(
    'provider.fetchModels',
    safeHandler((params) => {
      const v = validate(
        z.object({
          providerId: providerIdSchema,
          options: z
            .object({ baseUrl: z.string().optional(), zaiRegion: z.string().optional() })
            .optional(),
        }),
        params,
      );
      return fetchProviderModelsOverRpc(v.providerId, v.options, {
        secretsService,
        settingsService,
        openAiOauthManager,
      });
    }),
  );
  rpc.registerMethod(
    'provider.validateKey',
    safeHandler(async (params) => {
      const v = validate(
        z.object({
          providerId: providerIdSchema,
          key: z.string().min(1),
          options: z.record(z.unknown()).optional(),
        }),
        params,
      );
      return validateProviderKey(v.providerId, v.key, v.options, {
        secretsService,
        settingsService,
        openAiOauthManager,
      });
    }),
  );

  // Bedrock/Vertex credential validation (Phase 3 M2 T1b §A3). The
  // provider-connect UI validates credentials BEFORE storing them, so the
  // plaintext JSON travels one-way in the REQUEST; the response carries a
  // validity verdict with redacted error text only and NEVER echoes the
  // credential document. `provider.validateKey` cannot serve these because
  // agent-core's Bedrock/Vertex validators are document-JSON based and
  // bypass the api-key provider gate entirely.
  const providerValidateCredentialsSchema = z.object({
    providerId: z.enum(['bedrock', 'vertex']),
    credentials: z.string().min(1),
  });
  rpc.registerMethod(
    'provider.validateCredentials',
    safeHandler(async (params) => {
      const v = validate(providerValidateCredentialsSchema, params);
      const result =
        v.providerId === 'bedrock'
          ? await validateBedrockCredentials(v.credentials)
          : await validateVertexCredentials(v.credentials);
      if (result.error) {
        return { valid: false, error: redactCredentialError(result.error, v.credentials) };
      }
      return result;
    }),
  );

  // Forward settings.changed events to all connected clients.
  settingsService.on('settings.changed', (payload: SettingsChangePayload) => {
    rpc.notify('settings.changed', payload);
  });

  // ── Workspaces ───────────────────────────────────────────────────────────
  const workspaceIdParam = z.object({ workspaceId: z.string().min(1) });

  rpc.registerMethod(
    'workspace.list',
    safeHandler(() => Promise.resolve(workspaceService.list())),
  );
  rpc.registerMethod(
    'workspace.get',
    safeHandler((params) => {
      const v = validate(workspaceIdParam, params);
      return Promise.resolve(workspaceService.get(v.workspaceId));
    }),
  );
  rpc.registerMethod(
    'workspace.getActive',
    safeHandler(() => Promise.resolve(workspaceService.getActive())),
  );
  rpc.registerMethod(
    'workspace.setActive',
    safeHandler((params) => {
      const v = validate(workspaceIdParam, params);
      // Returns { changed: boolean } — the service rejects unknown ids with
      // a thrown error (caught by safeHandler), and no-ops when the target
      // is already active. Callers use `changed` to skip redundant reloads.
      return Promise.resolve(workspaceService.setActive(v.workspaceId));
    }),
  );
  rpc.registerMethod(
    'workspace.create',
    safeHandler((params) => {
      const v = validate(z.object({ input: z.unknown() }), params);
      return Promise.resolve(
        workspaceService.create(v.input as Parameters<typeof workspaceService.create>[0]),
      );
    }),
  );
  rpc.registerMethod(
    'workspace.update',
    safeHandler((params) => {
      const v = validate(z.object({ workspaceId: z.string().min(1), input: z.unknown() }), params);
      return Promise.resolve(
        workspaceService.update(
          v.workspaceId,
          v.input as Parameters<typeof workspaceService.update>[1],
        ),
      );
    }),
  );
  rpc.registerMethod(
    'workspace.delete',
    safeHandler((params) => {
      const v = validate(workspaceIdParam, params);
      // Returns { deleted: boolean; newActiveWorkspaceId?: string }. `deleted`
      // is false for missing/default workspaces; when the active workspace
      // was deleted, `newActiveWorkspaceId` points at the fallback the
      // service switched to before the delete.
      return Promise.resolve(workspaceService.delete(v.workspaceId));
    }),
  );

  // ── Knowledge notes ─────────────────────────────────────────────────────
  const noteKeyParam = z.object({
    noteId: z.string().min(1),
    workspaceId: z.string().min(1),
  });

  rpc.registerMethod(
    'knowledgeNote.list',
    safeHandler((params) => {
      const v = validate(workspaceIdParam, params);
      return Promise.resolve(workspaceService.listKnowledgeNotes(v.workspaceId));
    }),
  );
  rpc.registerMethod(
    'knowledgeNote.get',
    safeHandler((params) => {
      const v = validate(noteKeyParam, params);
      return Promise.resolve(workspaceService.getKnowledgeNote(v.noteId, v.workspaceId));
    }),
  );
  rpc.registerMethod(
    'knowledgeNote.create',
    safeHandler((params) => {
      const v = validate(z.object({ input: z.unknown() }), params);
      return Promise.resolve(
        workspaceService.createKnowledgeNote(
          v.input as Parameters<typeof workspaceService.createKnowledgeNote>[0],
        ),
      );
    }),
  );
  rpc.registerMethod(
    'knowledgeNote.update',
    safeHandler((params) => {
      const v = validate(
        z.object({
          noteId: z.string().min(1),
          workspaceId: z.string().min(1),
          input: z.unknown(),
        }),
        params,
      );
      return Promise.resolve(
        workspaceService.updateKnowledgeNote(
          v.noteId,
          v.workspaceId,
          v.input as Parameters<typeof workspaceService.updateKnowledgeNote>[2],
        ),
      );
    }),
  );
  rpc.registerMethod(
    'knowledgeNote.delete',
    safeHandler((params) => {
      const v = validate(noteKeyParam, params);
      workspaceService.deleteKnowledgeNote(v.noteId, v.workspaceId);
      return Promise.resolve();
    }),
  );

  // Forward workspace.changed events to all connected clients.
  workspaceService.on('workspace.changed', (payload: WorkspaceChangePayload) => {
    rpc.notify('workspace.changed', payload);
  });

  // ── Favorites ────────────────────────────────────────────────────────────
  rpc.registerMethod(
    'favorites.list',
    safeHandler(() => Promise.resolve(storage.getFavorites())),
  );
  rpc.registerMethod(
    'favorites.add',
    safeHandler((params) => {
      const v = validate(
        z.object({
          taskId: z.string().min(1),
          prompt: z.string(),
          summary: z.string().optional(),
        }),
        params,
      );
      storage.addFavorite(v.taskId, v.prompt, v.summary);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'favorites.remove',
    safeHandler((params) => {
      const v = validate(taskIdSchema, params);
      storage.removeFavorite(v.taskId);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'favorites.isFavorite',
    safeHandler((params) => {
      const v = validate(taskIdSchema, params);
      return Promise.resolve(storage.isFavorite(v.taskId));
    }),
  );

  // ── Connectors (MCP registry + OAuth tokens) ───────────────────────────
  rpc.registerMethod(
    'connectors.list',
    safeHandler(() => Promise.resolve(connectorService.list())),
  );
  rpc.registerMethod(
    'connectors.getEnabled',
    safeHandler(() => Promise.resolve(connectorService.getEnabled())),
  );
  rpc.registerMethod(
    'connectors.getById',
    safeHandler((params) => {
      const v = validate(z.object({ id: z.string().min(1) }), params);
      return Promise.resolve(connectorService.getById(v.id));
    }),
  );
  rpc.registerMethod(
    'connectors.upsert',
    safeHandler((params) => {
      const v = validate(z.object({ connector: z.unknown() }), params);
      connectorService.upsert(v.connector as Parameters<typeof connectorService.upsert>[0]);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'connectors.setEnabled',
    safeHandler((params) => {
      const v = validate(z.object({ id: z.string().min(1), enabled: z.boolean() }), params);
      connectorService.setEnabled(v.id, v.enabled);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'connectors.setStatus',
    safeHandler((params) => {
      const v = validate(z.object({ id: z.string().min(1), status: z.unknown() }), params);
      connectorService.setStatus(
        v.id,
        v.status as Parameters<typeof connectorService.setStatus>[1],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'connectors.delete',
    safeHandler((params) => {
      const v = validate(z.object({ id: z.string().min(1) }), params);
      connectorService.delete(v.id);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'connectors.storeTokens',
    safeHandler((params) => {
      const v = validate(z.object({ connectorId: z.string().min(1), tokens: z.unknown() }), params);
      connectorService.storeTokens(
        v.connectorId,
        v.tokens as Parameters<typeof connectorService.storeTokens>[1],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'connectors.getTokens',
    safeHandler((params) => {
      const v = validate(z.object({ connectorId: z.string().min(1) }), params);
      return Promise.resolve(connectorService.getTokens(v.connectorId));
    }),
  );
  rpc.registerMethod(
    'connectors.deleteTokens',
    safeHandler((params) => {
      const v = validate(z.object({ connectorId: z.string().min(1) }), params);
      connectorService.deleteTokens(v.connectorId);
      return Promise.resolve();
    }),
  );

  // Built-in connector auth-store surface (`connector-auth:<key>` prefix).
  // Full `StoredAuthEntry` reads/writes for Slack, Jira, Lightdash, Datadog,
  // monday, Notion, GitHub, Google flows so M3 can repoint
  // `connector-auth-entry.ts` without regressing DCR / PKCE / serverUrl state.
  const connectorKeyParam = z.object({ connectorKey: z.string().min(1) });
  rpc.registerMethod(
    'connectors.authEntry.read',
    safeHandler((params) => {
      const v = validate(connectorKeyParam, params);
      return Promise.resolve(connectorService.readAuthEntry(v.connectorKey));
    }),
  );
  rpc.registerMethod(
    'connectors.authEntry.write',
    safeHandler((params) => {
      const v = validate(z.object({ connectorKey: z.string().min(1), entry: z.unknown() }), params);
      connectorService.writeAuthEntry(
        v.connectorKey,
        v.entry as Parameters<typeof connectorService.writeAuthEntry>[1],
      );
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'connectors.authEntry.delete',
    safeHandler((params) => {
      const v = validate(connectorKeyParam, params);
      connectorService.deleteAuthEntry(v.connectorKey);
      return Promise.resolve();
    }),
  );

  // ── Logs (bug-report support) ───────────────────────────────────────────
  // The desktop bug-report handler reads recent task history to attach to
  // the generated report. Exposing it here avoids having the renderer reach
  // into the DB through main after M3.
  rpc.registerMethod(
    'logs.getTasksForBugReport',
    safeHandler(() => Promise.resolve(storage.getTasks())),
  );

  // ── Legacy electron-store import (one-shot, guarded) ─────────────────────
  rpc.registerMethod(
    'legacy.importElectronStoreIfNeeded',
    safeHandler((params) => {
      const v = validate(
        z.object({
          appSettingsPath: z.string().min(1),
          providerSettingsPath: z.string().min(1),
          taskHistoryPath: z.string().min(1),
        }),
        params,
      );
      return Promise.resolve(legacyImportService.importElectronStoreIfNeeded(v));
    }),
  );

  // ── Google accounts (M4 — daemon owns DB + refresh timers) ───────────────
  // googleAccountService + skillsService are destructured with the other
  // services at the top of registerRpcMethods.

  rpc.registerMethod(
    'gwsAccount.list',
    safeHandler(() => Promise.resolve(googleAccountService.list())),
  );
  rpc.registerMethod(
    'gwsAccount.add',
    safeHandler((params) => {
      const v = validate(
        z.object({
          input: z.object({
            googleAccountId: z.string().min(1),
            email: z.string().min(1),
            displayName: z.string(),
            pictureUrl: z.string().nullable(),
            label: z.string().min(1),
            connectedAt: z.string().min(1),
            token: z.object({
              accessToken: z.string().min(1),
              refreshToken: z.string().min(1),
              expiresAt: z.number(),
              scopes: z.array(z.string()),
            }),
          }),
        }),
        params,
      );
      googleAccountService.add(v.input as GwsAccountAddInput);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'gwsAccount.remove',
    safeHandler((params) => {
      const v = validate(z.object({ googleAccountId: z.string().min(1) }), params);
      googleAccountService.remove(v.googleAccountId);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'gwsAccount.updateLabel',
    safeHandler((params) => {
      const v = validate(
        z.object({ googleAccountId: z.string().min(1), label: z.string().min(1) }),
        params,
      );
      googleAccountService.updateLabel(v.googleAccountId, v.label);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'gwsAccount.updateToken',
    safeHandler((params) => {
      const v = validate(
        z.object({
          googleAccountId: z.string().min(1),
          token: z.object({
            accessToken: z.string().min(1),
            refreshToken: z.string().min(1),
            expiresAt: z.number(),
            scopes: z.array(z.string()),
          }),
          connectedAt: z.string().min(1),
        }),
        params,
      );
      googleAccountService.updateToken(v.googleAccountId, v.token, v.connectedAt);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'gwsAccount.getToken',
    safeHandler((params) => {
      const v = validate(z.object({ googleAccountId: z.string().min(1) }), params);
      return Promise.resolve(googleAccountService.getToken(v.googleAccountId));
    }),
  );
  rpc.registerMethod(
    'gwsAccount.refreshNow',
    safeHandler(async (params) => {
      const v = validate(z.object({ googleAccountId: z.string().min(1) }), params);
      await googleAccountService.refreshNow(v.googleAccountId);
    }),
  );

  // Forward gwsAccount.statusChanged → renderer (via main's notification
  // forwarder). Desktop sends it on as `gws:account:status-changed` IPC.
  googleAccountService.on('gwsAccount.statusChanged', (payload: GwsAccountStatusChangedPayload) => {
    rpc.notify('gwsAccount.statusChanged', payload);
  });

  // ── Skills (M4) ──────────────────────────────────────────────────────────
  rpc.registerMethod(
    'skills.list',
    safeHandler(() => Promise.resolve(skillsService.list())),
  );
  rpc.registerMethod(
    'skills.listEnabled',
    safeHandler(() => Promise.resolve(skillsService.listEnabled())),
  );
  rpc.registerMethod(
    'skills.setEnabled',
    safeHandler((params) => {
      const v = validate(z.object({ skillId: z.string().min(1), enabled: z.boolean() }), params);
      skillsService.setEnabled(v.skillId, v.enabled);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'skills.getContent',
    safeHandler((params) => {
      const v = validate(z.object({ skillId: z.string().min(1) }), params);
      return Promise.resolve(skillsService.getContent(v.skillId));
    }),
  );
  rpc.registerMethod(
    'skills.addFromPath',
    safeHandler(async (params) => {
      const v = validate(z.object({ sourcePath: z.string().min(1) }), params);
      return await skillsService.addFromPath(v.sourcePath);
    }),
  );
  // GitHub skill import (Phase 3 M2 T2): zod gates protocol + host BEFORE
  // the importer runs; agent-core's `resolveGithubRawUrl` re-validates the
  // same host set and normalizes tree/blob paths to the raw SKILL.md URL,
  // so a non-GitHub or insecure URL can never reach the fetch.
  const githubSkillUrlSchema = z.object({
    rawUrl: z
      .string()
      .min(1)
      .refine((raw) => {
        try {
          const parsed = new URL(raw);
          return (
            parsed.protocol === 'https:' &&
            (parsed.hostname === 'github.com' || parsed.hostname === 'raw.githubusercontent.com')
          );
        } catch {
          return false;
        }
      }, 'URL must use HTTPS and a github.com or raw.githubusercontent.com host'),
  });
  rpc.registerMethod(
    'skills.addFromGitHub',
    safeHandler(async (params) => {
      const v = validate(githubSkillUrlSchema, params);
      return await skillsService.addFromGitHub(v.rawUrl);
    }),
  );
  rpc.registerMethod(
    'skills.delete',
    safeHandler((params) => {
      const v = validate(z.object({ skillId: z.string().min(1) }), params);
      skillsService.delete(v.skillId);
      return Promise.resolve();
    }),
  );
  rpc.registerMethod(
    'skills.resync',
    safeHandler(async () => await skillsService.resync()),
  );
  rpc.registerMethod(
    'skills.getUserSkillsPath',
    safeHandler(() => Promise.resolve(skillsService.getUserSkillsPath())),
  );

  skillsService.on('skills.changed', (payload: SkillsChangedPayload) => {
    rpc.notify('skills.changed', payload);
  });
}
