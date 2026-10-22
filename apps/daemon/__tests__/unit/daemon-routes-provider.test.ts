/**
 * Unit tests for the Phase 3 M2 T1a provider/model-management RPC routes:
 * `provider.testConnection`, `provider.fetchModels`, `provider.validateKey`,
 * `secrets.listApiKeys`.
 *
 * Proves (§5.4 expansion policy):
 *   - desktop-parity dispatch semantics (provider-native result shapes,
 *     stored-key resolution, OpenAI OAuth fallback, azure-foundry config);
 *   - redaction: request-supplied and stored key material never appears in
 *     response error strings (exact-substring + pattern redaction);
 *   - the masked `secrets.listApiKeys` read delegates to the masking service.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRpcMethods, type RouteServices } from '../../src/daemon-routes.js';
import type { SecretsService } from '../../src/secrets-service.js';

type RpcHandler = (params: unknown, clientId?: string) => Promise<unknown>;

const providerMocks = vi.hoisted(() => ({
  testOllamaConnection: vi.fn(),
  testLiteLLMConnection: vi.fn(),
  testLMStudioConnection: vi.fn(),
  testNimConnection: vi.fn(),
  testCustomConnection: vi.fn(),
  testAzureFoundryConnection: vi.fn(),
  fetchOpenRouterModels: vi.fn(),
  fetchProviderModels: vi.fn(),
  fetchLiteLLMModels: vi.fn(),
  fetchLMStudioModels: vi.fn(),
  fetchNimModels: vi.fn(),
  fetchBedrockModels: vi.fn(),
  fetchVertexModels: vi.fn(),
  validateApiKey: vi.fn(),
  validateAzureFoundry: vi.fn(),
  validateBedrockCredentials: vi.fn(),
  validateVertexCredentials: vi.fn(),
}));

// Partial mock: network-touching provider fns are mocks, everything else
// (redact, sanitizeString, DEFAULT_PROVIDERS, zod schemas, ...) stays real.
vi.mock('@accomplish_ai/agent-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...providerMocks };
});

interface ServiceStubs {
  getApiKey: ReturnType<typeof vi.fn>;
  getBedrockCredentials: ReturnType<typeof vi.fn>;
  listApiKeysMasked: ReturnType<typeof vi.fn>;
  getLiteLLMConfig: ReturnType<typeof vi.fn>;
  getLMStudioConfig: ReturnType<typeof vi.fn>;
  getNimConfig: ReturnType<typeof vi.fn>;
  getAzureFoundryConfig: ReturnType<typeof vi.fn>;
  getOpenAiBaseUrl: ReturnType<typeof vi.fn>;
  getAccessToken: ReturnType<typeof vi.fn>;
}

function buildServices() {
  const registered = new Map<string, RpcHandler>();
  const stubs: ServiceStubs = {
    getApiKey: vi.fn(() => null),
    getBedrockCredentials: vi.fn(() => null),
    listApiKeysMasked: vi.fn(async () => ({}) as Record<string, never>),
    getLiteLLMConfig: vi.fn(() => null),
    getLMStudioConfig: vi.fn(() => null),
    getNimConfig: vi.fn(() => null),
    getAzureFoundryConfig: vi.fn(() => null),
    getOpenAiBaseUrl: vi.fn(() => ''),
    getAccessToken: vi.fn(() => null),
  };
  const secretsService = {
    getApiKey: stubs.getApiKey,
    getBedrockCredentials: stubs.getBedrockCredentials,
    listApiKeysMasked: stubs.listApiKeysMasked,
  } as unknown as SecretsService;
  const settingsService = {
    getLiteLLMConfig: stubs.getLiteLLMConfig,
    getLMStudioConfig: stubs.getLMStudioConfig,
    getNimConfig: stubs.getNimConfig,
    getAzureFoundryConfig: stubs.getAzureFoundryConfig,
    getOpenAiBaseUrl: stubs.getOpenAiBaseUrl,
    on: vi.fn(),
  };
  const openAiOauthManager = { getAccessToken: stubs.getAccessToken };
  const services = {
    rpc: {
      registerMethod: vi.fn((method: string, handler: RpcHandler) => {
        registered.set(method, handler);
      }),
      notify: vi.fn(),
      setClientType: vi.fn(),
      setUiPresence: vi.fn(),
    },
    taskService: {},
    healthService: {},
    storageService: { getStorage: vi.fn(() => ({})) },
    schedulerService: {},
    accomplishRuntime: { onUsageUpdate: vi.fn() },
    whatsappService: {},
    openAiOauthManager,
    secretsService,
    settingsService,
    workspaceService: { on: vi.fn() },
    connectorService: {},
    legacyImportService: {},
    googleAccountService: { on: vi.fn() },
    skillsService: { on: vi.fn() },
    devBrowserService: { getPreviewInfo: vi.fn(), openPreviewPage: vi.fn() },
  } as unknown as RouteServices;
  return { services, registered, stubs };
}

describe('provider.testConnection RPC route (M2 T1a)', () => {
  let registered: Map<string, RpcHandler>;
  let stubs: ServiceStubs;

  beforeEach(() => {
    const built = buildServices();
    registered = built.registered;
    stubs = built.stubs;
    registerRpcMethods(built.services);
    for (const mock of Object.values(providerMocks)) {
      mock.mockReset();
    }
  });

  it('registers provider.testConnection, provider.fetchModels, provider.validateKey', () => {
    expect(registered.has('provider.testConnection')).toBe(true);
    expect(registered.has('provider.fetchModels')).toBe(true);
    expect(registered.has('provider.validateKey')).toBe(true);
  });

  it('ollama: happy path passes the URL through and preserves the native shape', async () => {
    providerMocks.testOllamaConnection.mockResolvedValue({
      success: true,
      models: [{ id: 'llama3', displayName: 'llama3', size: 4 }],
    });
    const handler = registered.get('provider.testConnection');
    await expect(
      handler?.({ providerId: 'ollama', url: 'http://127.0.0.1:11434' }),
    ).resolves.toEqual({
      success: true,
      models: [{ id: 'llama3', displayName: 'llama3', size: 4 }],
    });
    expect(providerMocks.testOllamaConnection).toHaveBeenCalledWith('http://127.0.0.1:11434');
  });

  it('ollama: rejects a missing URL without calling the provider fn', async () => {
    const handler = registered.get('provider.testConnection');
    await expect(handler?.({ providerId: 'ollama' })).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/URL is required/),
    });
    expect(providerMocks.testOllamaConnection).not.toHaveBeenCalled();
  });

  it('litellm: an apiKey in the request wins and the stored key is not read', async () => {
    providerMocks.testLiteLLMConnection.mockResolvedValue({ success: true, models: [] });
    const handler = registered.get('provider.testConnection');
    await expect(
      handler?.({ providerId: 'litellm', url: 'http://127.0.0.1:4000', apiKey: 'ui-key' }),
    ).resolves.toEqual({ success: true, models: [] });
    expect(providerMocks.testLiteLLMConnection).toHaveBeenCalledWith(
      'http://127.0.0.1:4000',
      'ui-key',
    );
    expect(stubs.getApiKey).not.toHaveBeenCalled();
  });

  it('litellm: falls back to the stored key when the request carries none', async () => {
    providerMocks.testLiteLLMConnection.mockResolvedValue({ success: true, models: [] });
    stubs.getApiKey.mockReturnValue('stored-litellm-key');
    const handler = registered.get('provider.testConnection');
    await handler?.({ providerId: 'litellm', url: 'http://127.0.0.1:4000' });
    expect(stubs.getApiKey).toHaveBeenCalledWith('litellm');
    expect(providerMocks.testLiteLLMConnection).toHaveBeenCalledWith(
      'http://127.0.0.1:4000',
      'stored-litellm-key',
    );
  });

  it('nim: pre-store UI key wins, stored key acts as fallback', async () => {
    providerMocks.testNimConnection.mockResolvedValue({ success: true, models: [] });
    stubs.getApiKey.mockReturnValue('stored-nim-key');
    const handler = registered.get('provider.testConnection');
    await handler?.({
      providerId: 'nim',
      url: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'ui-nim',
    });
    expect(providerMocks.testNimConnection).toHaveBeenCalledWith(
      'https://integrate.api.nvidia.com/v1',
      'ui-nim',
    );
    await handler?.({ providerId: 'nim', url: 'https://integrate.api.nvidia.com/v1' });
    expect(providerMocks.testNimConnection).toHaveBeenLastCalledWith(
      'https://integrate.api.nvidia.com/v1',
      'stored-nim-key',
    );
  });

  it('custom: falls back to the stored key', async () => {
    providerMocks.testCustomConnection.mockResolvedValue({ success: true });
    stubs.getApiKey.mockReturnValue('stored-custom-key');
    const handler = registered.get('provider.testConnection');
    await handler?.({ providerId: 'custom', url: 'http://127.0.0.1:8080/v1' });
    expect(providerMocks.testCustomConnection).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1',
      'stored-custom-key',
    );
  });

  it('lmstudio: delegates with the url option shape', async () => {
    providerMocks.testLMStudioConnection.mockResolvedValue({ success: true, models: [] });
    const handler = registered.get('provider.testConnection');
    await handler?.({ providerId: 'lmstudio', url: 'http://127.0.0.1:1234' });
    expect(providerMocks.testLMStudioConnection).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:1234',
    });
  });

  it('azure-foundry: passes the full option set with the desktop timeout', async () => {
    providerMocks.testAzureFoundryConnection.mockResolvedValue({ success: true });
    const handler = registered.get('provider.testConnection');
    await handler?.({
      providerId: 'azure-foundry',
      endpoint: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'api-key',
      apiKey: 'az-key',
    });
    expect(providerMocks.testAzureFoundryConnection).toHaveBeenCalledWith({
      endpoint: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'api-key',
      apiKey: 'az-key',
      timeout: 15000,
    });
  });

  it('azure-foundry: rejects when endpoint/deploymentName/authType are missing', async () => {
    const handler = registered.get('provider.testConnection');
    await expect(handler?.({ providerId: 'azure-foundry' })).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/endpoint, deploymentName and authType are required/),
    });
    expect(providerMocks.testAzureFoundryConnection).not.toHaveBeenCalled();
  });

  it('unknown providerId is rejected', async () => {
    const handler = registered.get('provider.testConnection');
    await expect(handler?.({ providerId: 'not-a-provider' })).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/Unsupported provider/),
    });
  });

  it('failure path passes provider errors through after redaction', async () => {
    providerMocks.testLiteLLMConnection.mockResolvedValue({
      success: false,
      error: 'Cannot connect to LiteLLM: ECONNREFUSED',
    });
    const handler = registered.get('provider.testConnection');
    await expect(
      handler?.({ providerId: 'litellm', url: 'http://127.0.0.1:4000', apiKey: 'ui-key' }),
    ).resolves.toEqual({ success: false, error: 'Cannot connect to LiteLLM: ECONNREFUSED' });
  });

  it('redacts a request-supplied apiKey echoed inside a provider error', async () => {
    providerMocks.testLiteLLMConnection.mockResolvedValue({
      success: false,
      error: 'Cannot connect to LiteLLM: 401 for key=uigivenplainkey123',
    });
    const handler = registered.get('provider.testConnection');
    const result = (await handler?.({
      providerId: 'litellm',
      url: 'http://127.0.0.1:4000',
      apiKey: 'uigivenplainkey123',
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('uigivenplainkey123');
    expect(result.error).toBe('Cannot connect to LiteLLM: 401 for key=[REDACTED]');
  });

  it('redacts URL-embedded credential echoes from provider errors', async () => {
    providerMocks.testCustomConnection.mockResolvedValue({
      success: false,
      error:
        'connect failed for https://user:uigivenplainkey123@proxy.example.com: getaddrinfo ENOTFOUND',
    });
    const handler = registered.get('provider.testConnection');
    const result = (await handler?.({
      providerId: 'custom',
      url: 'https://proxy.example.com/v1',
      apiKey: 'uigivenplainkey123',
    })) as { success: boolean; error?: string };
    expect(result.error).not.toContain('uigivenplainkey123');
    expect(result.error).toContain('[REDACTED]');
  });

  it('models lists pass through in provider-native shape (field scrubbing is the gateway scrubber)', async () => {
    // The daemon preserves the provider-native shape byte-identically to the
    // desktop handlers; key-shaped FIELDS are removed by the host gateway's
    // universal scrubber (see gateway-scrub-redaction M2 tests).
    providerMocks.testOllamaConnection.mockResolvedValue({
      success: true,
      models: [{ id: 'llama3', displayName: 'llama3', size: 4, token: 'leak-token-value' }],
    });
    const handler = registered.get('provider.testConnection');
    const result = (await handler?.({
      providerId: 'ollama',
      url: 'http://127.0.0.1:11434',
    })) as { models?: Array<Record<string, unknown>> };
    expect(result.models?.[0]).toEqual({
      id: 'llama3',
      displayName: 'llama3',
      size: 4,
      token: 'leak-token-value',
    });
  });
});

describe('provider.fetchModels RPC route (M2 T1a)', () => {
  let registered: Map<string, RpcHandler>;
  let stubs: ServiceStubs;

  beforeEach(() => {
    const built = buildServices();
    registered = built.registered;
    stubs = built.stubs;
    registerRpcMethods(built.services);
    for (const mock of Object.values(providerMocks)) {
      mock.mockReset();
    }
  });

  it('openrouter: resolves the stored key daemon-side', async () => {
    providerMocks.fetchOpenRouterModels.mockResolvedValue({
      success: true,
      models: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
    });
    stubs.getApiKey.mockReturnValue('stored-or-key');
    const handler = registered.get('provider.fetchModels');
    await expect(handler?.({ providerId: 'openrouter' })).resolves.toEqual({
      success: true,
      models: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
    });
    expect(providerMocks.fetchOpenRouterModels).toHaveBeenCalledWith('stored-or-key', 15000);
  });

  it('litellm: passes the stored config + stored key', async () => {
    providerMocks.fetchLiteLLMModels.mockResolvedValue({ success: true, models: [] });
    const config = { baseUrl: 'http://127.0.0.1:4000', enabled: true };
    stubs.getLiteLLMConfig.mockReturnValue(config);
    stubs.getApiKey.mockReturnValue('stored-litellm-key');
    const handler = registered.get('provider.fetchModels');
    await handler?.({ providerId: 'litellm' });
    expect(providerMocks.fetchLiteLLMModels).toHaveBeenCalledWith({
      config,
      apiKey: 'stored-litellm-key',
    });
  });

  it('lmstudio: no stored config degrades cleanly, config flows into fetch', async () => {
    const handler = registered.get('provider.fetchModels');
    await expect(handler?.({ providerId: 'lmstudio' })).resolves.toEqual({
      success: false,
      error: 'No LM Studio configured',
    });
    providerMocks.fetchLMStudioModels.mockResolvedValue({ success: true, models: [] });
    stubs.getLMStudioConfig.mockReturnValue({ baseUrl: 'http://127.0.0.1:1234' });
    await handler?.({ providerId: 'lmstudio' });
    expect(providerMocks.fetchLMStudioModels).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:1234',
    });
  });

  it('openai: OAuth access token is the fallback when no stored key exists', async () => {
    providerMocks.fetchProviderModels.mockResolvedValue({ success: true, models: [] });
    stubs.getApiKey.mockReturnValue(null);
    stubs.getAccessToken.mockReturnValue('oauth-access-token');
    const handler = registered.get('provider.fetchModels');
    await handler?.({ providerId: 'openai' });
    expect(stubs.getAccessToken).toHaveBeenCalledTimes(1);
    const call = providerMocks.fetchProviderModels.mock.calls[0][0] as {
      apiKey: string;
      timeout: number;
    };
    expect(call.apiKey).toBe('oauth-access-token');
    expect(call.timeout).toBe(15000);
  });

  it('openai: stored key wins over the OAuth fallback', async () => {
    providerMocks.fetchProviderModels.mockResolvedValue({ success: true, models: [] });
    stubs.getApiKey.mockReturnValue('stored-openai-key');
    const handler = registered.get('provider.fetchModels');
    await handler?.({ providerId: 'openai' });
    expect(stubs.getAccessToken).not.toHaveBeenCalled();
    expect(providerMocks.fetchProviderModels.mock.calls[0][0].apiKey).toBe('stored-openai-key');
  });

  it('openai: baseUrl option overrides the models URL and drops the model filter', async () => {
    providerMocks.fetchProviderModels.mockResolvedValue({ success: true, models: [] });
    stubs.getApiKey.mockReturnValue('stored-openai-key');
    const handler = registered.get('provider.fetchModels');
    await handler?.({
      providerId: 'openai',
      options: { baseUrl: 'https://proxy.example.com/v1/' },
    });
    const call = providerMocks.fetchProviderModels.mock.calls[0][0] as {
      urlOverride?: string;
      endpointConfig: { modelFilter?: RegExp };
    };
    expect(call.urlOverride).toBe('https://proxy.example.com/v1/models');
    expect(call.endpointConfig.modelFilter).toBeUndefined();
  });

  it('zai: region option maps to the regional endpoint', async () => {
    providerMocks.fetchProviderModels.mockResolvedValue({ success: true, models: [] });
    stubs.getApiKey.mockReturnValue('zai-key');
    const handler = registered.get('provider.fetchModels');
    await handler?.({ providerId: 'zai', options: { zaiRegion: 'china' } });
    expect(providerMocks.fetchProviderModels.mock.calls[0][0].urlOverride).toBe(
      'https://open.bigmodel.cn/api/paas/v4/models',
    );
  });

  it('bedrock: stored credentials flow into the fetcher; absent credentials error out', async () => {
    const handler = registered.get('provider.fetchModels');
    await expect(handler?.({ providerId: 'bedrock' })).resolves.toEqual({
      success: false,
      error: 'No API key found for this provider',
    });
    const creds = { authType: 'accessKeys', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's3cr3t' };
    stubs.getBedrockCredentials.mockReturnValue(creds);
    providerMocks.fetchBedrockModels.mockResolvedValue({ success: true, models: [] });
    await handler?.({ providerId: 'bedrock' });
    expect(providerMocks.fetchBedrockModels).toHaveBeenCalledWith(creds);
  });

  it('vertex: stored JSON credentials are parsed in-process and never round-trip', async () => {
    const creds = {
      projectId: 'proj',
      location: 'us-central1',
      authType: 'adc',
    };
    stubs.getApiKey.mockReturnValue(JSON.stringify(creds));
    providerMocks.fetchVertexModels.mockResolvedValue({
      success: true,
      models: [{ id: 'vertex/publisher/model', name: 'Model' }],
    });
    const handler = registered.get('provider.fetchModels');
    await expect(handler?.({ providerId: 'vertex' })).resolves.toEqual({
      success: true,
      models: [{ id: 'vertex/publisher/model', name: 'Model' }],
    });
    expect(providerMocks.fetchVertexModels).toHaveBeenCalledWith(creds);
  });

  it('vertex: absent or unparseable stored credentials degrade to an error', async () => {
    const handler = registered.get('provider.fetchModels');
    await expect(handler?.({ providerId: 'vertex' })).resolves.toEqual({
      success: false,
      error: 'No API key found for this provider',
    });
    stubs.getApiKey.mockReturnValue('not-json{{');
    await expect(handler?.({ providerId: 'vertex' })).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/could not be parsed/),
    });
    expect(providerMocks.fetchVertexModels).not.toHaveBeenCalled();
  });

  it('unknown provider mimics the desktop no-endpoint error', async () => {
    const handler = registered.get('provider.fetchModels');
    await expect(handler?.({ providerId: 'totally-fake-provider' })).resolves.toEqual({
      success: false,
      error: 'No models endpoint configured for this provider',
    });
  });

  it('openai without any key material degrades to the desktop no-key error', async () => {
    const handler = registered.get('provider.fetchModels');
    await expect(handler?.({ providerId: 'openai' })).resolves.toEqual({
      success: false,
      error: 'No API key found for this provider',
    });
  });

  it('redacts pattern-matchable key material echoed in fetch errors', async () => {
    stubs.getApiKey.mockReturnValue('sk-livestoredopenaikey12345');
    providerMocks.fetchProviderModels.mockResolvedValue({
      success: false,
      error: 'upstream rejected sk-livestoredopenaikey12345',
    });
    const handler = registered.get('provider.fetchModels');
    const result = (await handler?.({ providerId: 'openai' })) as { error?: string };
    expect(result.error).not.toContain('sk-livestoredopenaikey12345');
    expect(result.error).toContain('[REDACTED]');
  });
});

describe('provider.validateKey RPC route (M2 T1a)', () => {
  let registered: Map<string, RpcHandler>;
  let stubs: ServiceStubs;

  beforeEach(() => {
    const built = buildServices();
    registered = built.registered;
    stubs = built.stubs;
    registerRpcMethods(built.services);
    for (const mock of Object.values(providerMocks)) {
      mock.mockReset();
    }
  });

  it('standard provider forwards the sanitized key with the desktop timeout', async () => {
    providerMocks.validateApiKey.mockResolvedValue({ valid: true });
    const handler = registered.get('provider.validateKey');
    await expect(
      handler?.({ providerId: 'anthropic', key: '  sk-ant-validkey  ' }),
    ).resolves.toEqual({ valid: true });
    expect(providerMocks.validateApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-validkey', {
      timeout: 15000,
      baseUrl: undefined,
      zaiRegion: undefined,
    });
  });

  it('openai falls back to the stored base URL when the options omit one', async () => {
    providerMocks.validateApiKey.mockResolvedValue({ valid: true });
    stubs.getOpenAiBaseUrl.mockReturnValue('https://stored-proxy.example.com/v1');
    const handler = registered.get('provider.validateKey');
    await handler?.({ providerId: 'openai', key: 'sk-openai-validkey' });
    expect(providerMocks.validateApiKey).toHaveBeenCalledWith('openai', 'sk-openai-validkey', {
      timeout: 15000,
      baseUrl: 'https://stored-proxy.example.com/v1',
      zaiRegion: undefined,
    });
  });

  it('openai: an options.baseUrl wins over the stored base URL', async () => {
    providerMocks.validateApiKey.mockResolvedValue({ valid: true });
    stubs.getOpenAiBaseUrl.mockReturnValue('https://stored-proxy.example.com/v1');
    const handler = registered.get('provider.validateKey');
    await handler?.({
      providerId: 'openai',
      key: 'sk-openai-validkey',
      options: { baseUrl: 'https://ui-proxy.example.com/v1' },
    });
    expect(providerMocks.validateApiKey).toHaveBeenCalledWith(
      'openai',
      'sk-openai-validkey',
      expect.objectContaining({ baseUrl: 'https://ui-proxy.example.com/v1' }),
    );
  });

  it('zai normalizes the region with the international default (legacy alias accepted)', async () => {
    providerMocks.validateApiKey.mockResolvedValue({ valid: true });
    const handler = registered.get('provider.validateKey');
    await handler?.({ providerId: 'zai', key: 'zai-key-1', options: { region: 'china' } });
    expect(providerMocks.validateApiKey).toHaveBeenCalledWith(
      'zai',
      'zai-key-1',
      expect.objectContaining({ zaiRegion: 'china' }),
    );
    await handler?.({ providerId: 'zai', key: 'zai-key-1' });
    expect(providerMocks.validateApiKey).toHaveBeenLastCalledWith(
      'zai',
      'zai-key-1',
      expect.objectContaining({ zaiRegion: 'international' }),
    );
  });

  it('unsupported provider returns the desktop error without a network call', async () => {
    // `ollama` is absent from ALLOWED_API_KEY_PROVIDERS (local only) — the
    // desktop api-key:validate-provider handler rejects it identically.
    const handler = registered.get('provider.validateKey');
    await expect(handler?.({ providerId: 'ollama', key: 'whatever' })).resolves.toEqual({
      valid: false,
      error: 'Unsupported provider',
    });
    expect(providerMocks.validateApiKey).not.toHaveBeenCalled();
  });

  it('azure-foundry validates against the stored config with the raw request key', async () => {
    providerMocks.validateAzureFoundry.mockResolvedValue({ valid: true });
    const config = {
      baseUrl: 'https://foundry.example.com',
      deploymentName: 'gpt-4o',
      authType: 'api-key',
      enabled: true,
    };
    stubs.getAzureFoundryConfig.mockReturnValue(config);
    const handler = registered.get('provider.validateKey');
    await handler?.({
      providerId: 'azure-foundry',
      key: 'az-given-key',
      options: { deploymentName: 'gpt-4o-mini' },
    });
    expect(providerMocks.validateAzureFoundry).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        apiKey: 'az-given-key',
        deploymentName: 'gpt-4o-mini',
        timeout: 15000,
      }),
    );
  });

  it('local/custom providers skip validation (desktop skip-validation parity)', async () => {
    const handler = registered.get('provider.validateKey');
    await expect(handler?.({ providerId: 'custom', key: 'any-key' })).resolves.toEqual({
      valid: true,
    });
    expect(providerMocks.validateApiKey).not.toHaveBeenCalled();
  });

  it('validation failures are redacted before crossing the socket', async () => {
    providerMocks.validateApiKey.mockResolvedValue({
      valid: false,
      error: 'Invalid API key sk-livestoredvalidatekey123 rejected by upstream',
    });
    const handler = registered.get('provider.validateKey');
    const result = (await handler?.({
      providerId: 'anthropic',
      key: 'sk-livestoredvalidatekey123',
    })) as { valid: boolean; error?: string };
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('sk-livestoredvalidatekey123');
    expect(result.error).toContain('[REDACTED]');
  });

  it('validation failures are stripped of an exact request-key echo even if unpatterned', async () => {
    providerMocks.validateApiKey.mockResolvedValue({
      valid: false,
      error: 'upstream said no for key=uigivenplainkey123',
    });
    const handler = registered.get('provider.validateKey');
    const result = (await handler?.({
      providerId: 'anthropic',
      key: 'uigivenplainkey123',
    })) as { valid: boolean; error?: string };
    expect(result.error).toBe('upstream said no for key=[REDACTED]');
  });
});

describe('secrets.listApiKeys RPC route (M2 T1a masked read)', () => {
  it('delegates to SecretsService.listApiKeysMasked', async () => {
    const built = buildServices();
    registerRpcMethods(built.services);
    const masked = { anthropic: { exists: true, prefix: 'sk-a' }, openai: { exists: false } };
    built.stubs.listApiKeysMasked.mockResolvedValue(masked);
    const handler = built.registered.get('secrets.listApiKeys');
    expect(handler).toBeDefined();
    await expect(handler?.(undefined)).resolves.toEqual(masked);
    expect(built.stubs.listApiKeysMasked).toHaveBeenCalledTimes(1);
  });
});

describe('provider.validateCredentials RPC route (M2 T1b §A3)', () => {
  let registered: Map<string, RpcHandler>;

  beforeEach(() => {
    const built = buildServices();
    registered = built.registered;
    registerRpcMethods(built.services);
    for (const mock of Object.values(providerMocks)) {
      mock.mockReset();
    }
  });

  it('registers provider.validateCredentials', () => {
    expect(registered.has('provider.validateCredentials')).toBe(true);
  });

  it('bedrock: delegates the document verbatim to the agent-core validator', async () => {
    const credentialsJson = JSON.stringify({
      authType: 'accessKeys',
      accessKeyId: 'AKIAIOSFODNN7TESTKEY',
      secretAccessKey: 'wJalrXUtnFEMItest-secret',
      region: 'us-east-1',
    });
    providerMocks.validateBedrockCredentials.mockResolvedValue({ valid: true });
    const handler = registered.get('provider.validateCredentials');
    await expect(
      handler?.({ providerId: 'bedrock', credentials: credentialsJson }),
    ).resolves.toEqual({ valid: true });
    expect(providerMocks.validateBedrockCredentials).toHaveBeenCalledWith(credentialsJson);
    expect(providerMocks.validateVertexCredentials).not.toHaveBeenCalled();
  });

  it('vertex: delegates the document verbatim to the agent-core validator', async () => {
    const credentialsJson = JSON.stringify({
      authType: 'serviceAccount',
      projectId: 'proj',
      location: 'global',
      serviceAccountJson: '{"type":"service_account"}',
    });
    providerMocks.validateVertexCredentials.mockResolvedValue({ valid: true });
    const handler = registered.get('provider.validateCredentials');
    await expect(
      handler?.({ providerId: 'vertex', credentials: credentialsJson }),
    ).resolves.toEqual({ valid: true });
    expect(providerMocks.validateVertexCredentials).toHaveBeenCalledWith(credentialsJson);
  });

  it('rejects other provider ids with the schema error', async () => {
    const handler = registered.get('provider.validateCredentials');
    await expect(
      handler?.({ providerId: 'anthropic', credentials: '{"authType":"apiKey"}' }),
    ).rejects.toThrow(/Invalid payload/);
    expect(providerMocks.validateBedrockCredentials).not.toHaveBeenCalled();
    expect(providerMocks.validateVertexCredentials).not.toHaveBeenCalled();
  });

  it('redacts secret fields embedded in validation errors and never echoes the document', async () => {
    const ACCESS_KEY = 'AKIAIOSFODNN7TESTKEY';
    const SECRET_KEY = 'wJalrXUtnFEMItest-secret';
    const credentialsJson = JSON.stringify({
      authType: 'accessKeys',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: 'us-east-1',
    });
    providerMocks.validateBedrockCredentials.mockResolvedValue({
      valid: false,
      error: `The security token included in the request is invalid for ${ACCESS_KEY} / ${SECRET_KEY}`,
    });
    const handler = registered.get('provider.validateCredentials');
    const result = (await handler?.({
      providerId: 'bedrock',
      credentials: credentialsJson,
    })) as { valid: boolean; error?: string };
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain(ACCESS_KEY);
    expect(result.error).not.toContain(SECRET_KEY);
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain(credentialsJson);
  });

  it('redacts the service-account private key even when unpatterned', async () => {
    const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqtest-----END PRIVATE KEY-----';
    const credentialsJson = JSON.stringify({
      authType: 'serviceAccount',
      projectId: 'proj',
      location: 'global',
      serviceAccountJson: JSON.stringify({
        type: 'service_account',
        private_key: PRIVATE_KEY,
        client_email: 'svc@proj.iam.gserviceaccount.com',
      }),
    });
    providerMocks.validateVertexCredentials.mockResolvedValue({
      valid: false,
      // Hostile/unusual upstream echo: quotes the entire service-account JSON.
      error: `token rejected: ${JSON.stringify({ private_key: PRIVATE_KEY })}`,
    });
    const handler = registered.get('provider.validateCredentials');
    const result = (await handler?.({
      providerId: 'vertex',
      credentials: credentialsJson,
    })) as { valid: boolean; error?: string };
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain(PRIVATE_KEY);
    expect(result.error).toContain('[REDACTED]');
  });

  it('still passes pattern-shaped errors through the pattern redactor', async () => {
    const credentialsJson = JSON.stringify({
      authType: 'apiKey',
      apiKey: 'plainunpatternedkey000',
      region: 'us-east-1',
    });
    providerMocks.validateBedrockCredentials.mockResolvedValue({
      valid: false,
      error: 'Bearer plainunpatternedkey000 denied',
    });
    const handler = registered.get('provider.validateCredentials');
    const result = (await handler?.({
      providerId: 'bedrock',
      credentials: credentialsJson,
    })) as { valid: boolean; error?: string };
    expect(result.error).toBe('Bearer [REDACTED] denied');
  });
});
