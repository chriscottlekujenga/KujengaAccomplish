/**
 * Gateway universal response scrubbing + log redaction (Phase 3 M1 §5.4).
 *
 * Proves on the live POST /rpc surface that:
 *   - every response is scrubbed, not only provider.getSettings (audit
 *     finding: settings.getAll bundles provider credentials and
 *     settings.getCloudBrowserConfig carries a raw apiKey);
 *   - provider.getSettings output keeps its exact prior behavior
 *     (masked metadata survives, secrets drop);
 *   - no captured gateway log line ever contains the bearer token — for a
 *     normal /rpc call, a 401, a /client-log payload, and a WS auth message.
 */

import { describe, afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGateway, type GatewayHandle } from '../../src/gateway.js';
import type { HostLogger } from '../../src/logger.js';
import { createFakeRpc } from './fake-rpc.js';

const TOKEN = 'unit-test-gateway-token';
const TOKEN_FRAGMENT = 'unit-test'; // survives only if truncation preceeds redaction

interface LogLine {
  level: string;
  text: string;
}

function capturingLogger(lines: LogLine[]): HostLogger {
  const record =
    (level: string) =>
    (msg: string, data?: Record<string, unknown>): void => {
      lines.push({ level, text: msg + (data ? ` ${JSON.stringify(data)}` : '') });
    };
  return {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/** Assert none of the captured log lines carry any of the plain secret
 *  strings — the §5.4 key-leak check for M2 request params. */
function assertNoSecretKeys(lines: LogLine[], secrets: string[]): void {
  for (const line of lines) {
    for (const secret of secrets) {
      expect(line.text, `log line leaked a secret: ${line.text}`).not.toContain(secret);
    }
  }
}

/** Gateway-parameterized /rpc POST for the M2 describe blocks below. */
async function postRpcOn(
  gateway: GatewayHandle,
  method: string,
  params?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${gateway.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Provider settings shape the audit pulled from the daemon service. */
const PROVIDER_SETTINGS = {
  activeProviderId: 'anthropic',
  debugMode: false,
  connectedProviders: {
    anthropic: {
      providerId: 'anthropic',
      connectionStatus: 'connected',
      selectedModelId: 'anthropic/claude-opus-4-5',
      credentials: { type: 'api_key', keyPrefix: 'abcd', apiKey: 'sk-ant-LIVE-KEY' },
    },
    custom: {
      providerId: 'custom',
      connectionStatus: 'connected',
      selectedModelId: 'custom/model',
      credentials: {
        type: 'custom',
        hasApiKey: true,
        keyPrefix: 'ef01',
        apiKey: 'sk-custom-LIVE-KEY',
      },
    },
  },
};

/** settings.getAll — audit finding: bundles providers + cloudBrowserConfig. */
const SETTINGS_SNAPSHOT = {
  app: { theme: 'dark', openaiBaseUrl: 'https://api.openai.com/v1' },
  providers: PROVIDER_SETTINGS,
  cloudBrowserConfig: {
    activeProvider: 'browserbase',
    providers: {
      browserbase: { provider: 'browserbase', enabled: true, apiKey: 'bb_LIVE_KEY_1234' },
    },
  },
  sandboxConfig: { mode: 'disabled' },
  messagingConfig: { integrations: { whatsapp: { platform: 'whatsapp', enabled: false } } },
  notificationsEnabled: true,
  closeBehavior: 'keep-daemon',
};

describe('gateway universal response scrubbing', () => {
  let gateway: GatewayHandle;
  let rpc: ReturnType<typeof createFakeRpc>;

  beforeAll(async () => {
    rpc = createFakeRpc({
      'provider.getSettings': PROVIDER_SETTINGS,
      'settings.getAll': SETTINGS_SNAPSHOT,
      'settings.getCloudBrowserConfig': SETTINGS_SNAPSHOT.cloudBrowserConfig,
      'task.list': [],
      'brand.new.unaudited.method': {
        wrapper: [{ refreshToken: 'rt_LIVE_TOKEN', accessToken: 'at_LIVE_TOKEN' }],
      },
    });
    gateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist: null,
      rpc,
    });
  });

  afterAll(async () => {
    await gateway.close();
  });

  async function postRpc(
    method: string,
    params?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('scrubs credentials embedded anywhere in settings.getAll (audit RAW-SECRET finding)', async () => {
    const { status, body } = await postRpc('settings.getAll');
    expect(status).toBe(200);
    const json = JSON.stringify(body);
    expect(json).not.toContain('sk-ant-LIVE-KEY');
    expect(json).not.toContain('sk-custom-LIVE-KEY');
    expect(json).not.toContain('bb_LIVE_KEY_1234');
    const result = body.result as {
      providers: {
        connectedProviders: { anthropic: { credentials: Record<string, unknown> } };
      };
      cloudBrowserConfig: { providers: { browserbase: Record<string, unknown> } };
    };
    // Masked metadata the UI renders survives the scrub.
    expect(result.providers.connectedProviders.anthropic.credentials.keyPrefix).toBe('abcd');
    const browserbase = result.cloudBrowserConfig.providers.browserbase;
    expect(browserbase.apiKey).toBeUndefined();
    expect(browserbase.enabled).toBe(true);
  });

  it('scrubs settings.getCloudBrowserConfig apiKey in isolation', async () => {
    const { body } = await postRpc('settings.getCloudBrowserConfig');
    const json = JSON.stringify(body);
    expect(json).not.toContain('bb_LIVE_KEY_1234');
    expect(json).toContain('"enabled":true');
  });

  it('keeps provider.getSettings behavior: masked fields pass, secrets drop', async () => {
    const { body } = await postRpc('provider.getSettings');
    const result = body.result as {
      connectedProviders: Record<string, { credentials: Record<string, unknown> }>;
    };
    const anthropic = result.connectedProviders.anthropic.credentials;
    const custom = result.connectedProviders.custom.credentials;
    expect(anthropic.keyPrefix).toBe('abcd');
    expect(anthropic.apiKey).toBeUndefined();
    expect(custom.keyPrefix).toBe('ef01');
    expect(custom.hasApiKey).toBe(true);
    expect(custom.apiKey).toBeUndefined();
    expect(rpc.calls.at(-1)?.method).toBe('provider.getSettings');
  });

  it('default-scrubs unknown methods that are not in the allowlist audit table', async () => {
    const { body } = await postRpc('brand.new.unaudited.method');
    const json = JSON.stringify(body);
    expect(json).not.toContain('rt_LIVE_TOKEN');
    expect(json).not.toContain('at_LIVE_TOKEN');
    expect(json).not.toContain('"refreshToken"');
  });

  // Phase 3 M2 T1a (§5.4(b) scrubber counterpart for the expansion): even
  // if a daemon-side handler regression packed secret-shaped fields into a
  // config-write response, the universal scrubber strips them at the
  // boundary.
  describe('M2 method responses are scrubbed (hypothetical leak defense-in-depth)', () => {
    let scrubGateway: GatewayHandle;

    beforeAll(async () => {
      scrubGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: createFakeRpc({
          'provider.setConnected': {
            providerId: 'anthropic',
            saved: true,
            apiKey: 'sk-ant-SHOULD-NOT-LEAK',
            credentials: { apiKey: 'sk-ant-NESTED-LEAK', connectionStatus: 'connected' },
          },
          'settings.setOllamaConfig': {
            ok: true,
            apiKey: 'ollama-not-a-real-key-but-scrubbed-by-name',
          },
          'provider.validateKey': {
            valid: true,
            apiKey: 'sk-ant-VALIDATE-LEAK-FIELD',
          },
          'provider.validateCredentials': {
            valid: true,
            credentials: { authType: 'accessKeys', apiKey: 'sk-bedrock-VALIDATE-LEAK' },
            apiKey: 'sk-vertex-VALIDATE-LEAK-FIELD',
            secretAccessKey: 'sk-accesskey-VALIDATE-LEAK-FIELD',
            serviceAccountJson: 'sk-serviceaccount-VALIDATE-LEAK-FIELD',
          },
          'secrets.storeBedrockCredentials': {
            ok: true,
            echo: {
              authType: 'accessKeys',
              secretAccessKey: 'sk-bedrock-STORE-LEAK-FIELD',
              sessionToken: 'sk-token-STORE-LEAK-FIELD',
            },
            apiKey: 'sk-top-STORE-LEAK-FIELD',
          },
          'provider.testConnection': {
            success: true,
            models: [{ id: 'llama3', name: 'llama3', token: 'field-scrub-me' }],
          },
        }),
      });
    });

    afterAll(async () => {
      await scrubGateway.close();
    });

    it('scrubs provider.setConnected responses carrying an apiKey field', async () => {
      const { body } = await postRpcOn(scrubGateway, 'provider.setConnected', {
        providerId: 'anthropic',
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('sk-ant-SHOULD-NOT-LEAK');
      expect(json).not.toContain('sk-ant-NESTED-LEAK');
      expect(json).not.toContain('"apiKey"');
      expect(json).toContain('"providerId":"anthropic"');
    });

    it('scrubs settings.setOllamaConfig responses carrying an apiKey field', async () => {
      const { body } = await postRpcOn(scrubGateway, 'settings.setOllamaConfig', {
        config: null,
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('ollama-not-a-real-key-but-scrubbed-by-name');
      expect(json).not.toContain('"apiKey"');
    });

    it('scrubs a hypothetical apiKey field from provider.validateKey responses', async () => {
      // String-level redaction of validateKey error TEXT is the daemon's
      // `redactProviderError` contract (daemon suite); the gateway scrubber
      // owns field-SHAPED leaks of any method's response.
      const { body } = await postRpcOn(scrubGateway, 'provider.validateKey', {
        providerId: 'anthropic',
        key: 'irrelevant',
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('sk-ant-VALIDATE-LEAK-FIELD');
      expect(json).not.toContain('"apiKey"');
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(true);
    });

    it('scrubs key-shaped fields out of provider.testConnection model metadata', async () => {
      const { body } = await postRpcOn(scrubGateway, 'provider.testConnection', {
        providerId: 'ollama',
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('field-scrub-me');
      expect(json).not.toContain('"token"');
      expect(json).toContain('"id":"llama3"');
    });

    // Phase 3 M2 T1b §A3 (echo protection): the validate/store credential
    // methods take a plaintext document one-way in the REQUEST. A daemon
    // regression echoing credential material into key-SHAPED response
    // fields must hit the universal scrubber; error TEXT redaction is the
    // daemon's own contract (tested in the daemon suite).
    it('scrubs echoed credential fields out of provider.validateCredentials responses', async () => {
      const { body } = await postRpcOn(scrubGateway, 'provider.validateCredentials', {
        providerId: 'bedrock',
        credentials: '{"authType":"apiKey","apiKey":"x"}',
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('sk-bedrock-VALIDATE-LEAK');
      expect(json).not.toContain('sk-vertex-VALIDATE-LEAK-FIELD');
      expect(json).not.toContain('sk-accesskey-VALIDATE-LEAK-FIELD');
      expect(json).not.toContain('sk-serviceaccount-VALIDATE-LEAK-FIELD');
      expect(json).not.toContain('"apiKey"');
      expect(json).not.toContain('"secretAccessKey"');
      expect(json).not.toContain('"serviceAccountJson"');
      const result = body.result as Record<string, unknown>;
      expect(result.valid).toBe(true);
    });

    it('scrubs echoed credential fields out of secrets.storeBedrockCredentials responses', async () => {
      const { body } = await postRpcOn(scrubGateway, 'secrets.storeBedrockCredentials', {
        credentials: '{"authType":"accessKeys","accessKeyId":"x"}',
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('sk-bedrock-STORE-LEAK-FIELD');
      expect(json).not.toContain('sk-token-STORE-LEAK-FIELD');
      expect(json).not.toContain('sk-top-STORE-LEAK-FIELD');
      expect(json).not.toContain('"apiKey"');
      expect(json).not.toContain('"secretAccessKey"');
      expect(json).not.toContain('"sessionToken"');
    });
  });

  // Phase 3 M2 T2 (§5.4(a/b) scrubber proof for the connector-CRUD
  // expansion): connectors.list responses are plain registry metadata —
  // tokens live in secure storage under `connector-tokens:<id>`, never in
  // these rows. But a DCR client registration (clientSecret) IS stored
  // inside the row's `clientRegistration` blob, and a daemon regression
  // could hypothetically pack token-shaped fields in too — the universal
  // scrubber must strip all of it at the boundary while the non-secret
  // registry metadata the UI renders survives. (connectors.getEnabled
  // serves the same row shape but stays unauthorized — no browser method
  // maps to it; the shape-identical proof below covers any future
  // allowlisting.)
  describe('connectors.list responses carry no token material (M2 T2)', () => {
    let scrubGateway: GatewayHandle;

    beforeAll(async () => {
      scrubGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: createFakeRpc({
          'connectors.list': [
            {
              id: 'mcp-1',
              name: 'Linear MCP',
              url: 'https://mcp.linear.app/sse',
              status: 'disconnected',
              isEnabled: true,
              createdAt: '2026-10-21T00:00:00.000Z',
              updatedAt: '2026-10-21T00:00:00.000Z',
              oauthMetadata: { authorizationEndpoint: 'https://mcp.linear.app/authorize' },
              clientRegistration: {
                clientId: 'dcr-client-42',
                clientSecret: 'dcr-SHOULD-NOT-LEAK',
              },
              // Hypothetical daemon-regression fields — token-shaped.
              accessToken: 'at_CONNECTOR_LEAK',
              refreshToken: 'rt_CONNECTOR_LEAK',
            },
          ],
        }),
      });
    });

    afterAll(async () => {
      await scrubGateway.close();
    });

    it('strips clientRegistration.clientSecret and token-shaped fields from connectors.list', async () => {
      const { body } = await postRpcOn(scrubGateway, 'connectors.list');
      const json = JSON.stringify(body);
      expect(json).not.toContain('dcr-SHOULD-NOT-LEAK');
      expect(json).not.toContain('"clientSecret"');
      expect(json).not.toContain('at_CONNECTOR_LEAK');
      expect(json).not.toContain('rt_CONNECTOR_LEAK');
      expect(json).not.toContain('"accessToken"');
      expect(json).not.toContain('"refreshToken"');
      // Non-secret registry metadata the UI renders survives.
      expect(json).toContain('"id":"mcp-1"');
      expect(json).toContain('"name":"Linear MCP"');
      expect(json).toContain('"url":"https://mcp.linear.app/sse"');
      expect(json).toContain('"clientId":"dcr-client-42"');
      const result = body.result as Array<Record<string, unknown>>;
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Linear MCP');
    });
  });

  // Phase 3 M6-A T4 (§5.4(b) scrubber counterpart for the ONE new M6 allowlist
  // entry): task.getPendingRequest returns the persisted card-context record
  // — daemon-side it is already redacted + length-capped and drops tool
  // input/file paths (§6.4). A hypothetical daemon regression packing a
  // secret-shaped field into the record (or echoing a page-pasted key into
  // question text) must hit the universal scrubber at the boundary while the
  // card fields the UI renders survive intact.
  describe('task.getPendingRequest responses carry no secret material (M6-A T4)', () => {
    let scrubGateway: GatewayHandle;

    beforeAll(async () => {
      scrubGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: createFakeRpc({
          'task.getPendingRequest': {
            pendingRequest: {
              kind: 'question',
              requestId: 'questionreq_1',
              // Realistic persisted question text: the daemon redacted the
              // pasted key at PARK time (§6.4 — `redact` replaces matches
              // with the four-char prefix + [REDACTED]); the browser sees
              // the marker, never the raw key.
              question: 'A CAPTCHA blocks the site. The form asked for: sk-a[REDACTED]',
              header: 'Human assistance required',
              options: [{ label: "I'll complete it — please wait", apiKey: 'sk-ant-OPTION-LEAK' }],
              multiSelect: false,
              createdAt: '2026-10-23T00:00:00.000Z',
              // Hypothetical daemon-regression fields — secret-shaped.
              apiKey: 'sk-ant-RECORD-TOP-LEAK',
              sessionToken: 'sk-session-RECORD-LEAK-FIELD',
            },
          },
        }),
      });
    });

    afterAll(async () => {
      await scrubGateway.close();
    });

    it('strips secret-shaped fields anywhere inside the record, keeps card context intact', async () => {
      const { body } = await postRpcOn(scrubGateway, 'task.getPendingRequest', {
        taskId: 'tsk_1',
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('sk-ant-RECORD-TOP-LEAK');
      expect(json).not.toContain('sk-ant-OPTION-LEAK');
      expect(json).not.toContain('sk-session-RECORD-LEAK-FIELD');
      expect(json).not.toContain('"apiKey"');
      expect(json).not.toContain('"sessionToken"');
      // Card context the UI renders survives the scrub.
      expect(json).toContain('"kind":"question"');
      expect(json).toContain('"requestId":"questionreq_1"');
      expect(json).toContain('"Human assistance required"');
      expect(json).toContain('"I\'ll complete it');
      expect(json).toContain('"multiSelect":false');
      const result = body.result as {
        pendingRequest: Record<string, unknown>;
      };
      expect(result.pendingRequest.createdAt).toBe('2026-10-23T00:00:00.000Z');
    });

    it('keeps the daemon-side redaction marker in question text — a raw credential never rides the wire', async () => {
      // Paired redaction contract (§6.4): the daemon redacts credential
      // shapes BEFORE persist (agent-core task-assistance suite proves the
      // park write). This is the wire-level counterpart: the record reaches
      // the browser with the [REDACTED] marker only — no raw sk- key.
      const { body } = await postRpcOn(scrubGateway, 'task.getPendingRequest', {
        taskId: 'tsk_1',
      });
      const json = JSON.stringify(body);
      expect(json).toContain('sk-a[REDACTED]');
      expect(json).toMatch(/\[REDACTED\]/);
      const result = body.result as { pendingRequest: { question?: string } };
      expect(result.pendingRequest.question).toContain('[REDACTED]');
    });
  });

  describe('M2 secret-bearing request params never reach the host log (§5.4(d))', () => {
    let logGateway: GatewayHandle;
    const lines: LogLine[] = [];
    const LIVE_TEST_KEY = 'sk-provider-live-secret-key-0123456789';
    const LIVE_VALIDATE_KEY = 'sk-validate-live-secret-key-9876543210';

    beforeAll(async () => {
      logGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: createFakeRpc({
          'provider.testConnection': { success: true, models: [] },
          'provider.validateKey': { valid: true },
        }),
        logger: capturingLogger(lines),
        rateLimiterOptions: { limit: 10_000, windowMs: 1000 },
      });
    });

    afterAll(async () => {
      await logGateway.close();
    });

    it('provider.testConnection params (url + plaintext key) are not logged', async () => {
      const res = await fetch(`http://127.0.0.1:${logGateway.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'provider.testConnection',
          params: {
            providerId: 'litellm',
            url: 'http://127.0.0.1:4000',
            apiKey: LIVE_TEST_KEY,
          },
        }),
      });
      expect(res.status).toBe(200);
      assertNoSecretKeys(lines, [LIVE_TEST_KEY, LIVE_VALIDATE_KEY]);
    });

    it('provider.validateKey params (plaintext key) are not logged', async () => {
      const res = await fetch(`http://127.0.0.1:${logGateway.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'provider.validateKey',
          params: { providerId: 'anthropic', key: LIVE_VALIDATE_KEY },
        }),
      });
      expect(res.status).toBe(200);
      assertNoSecretKeys(lines, [LIVE_TEST_KEY, LIVE_VALIDATE_KEY]);
    });

    it('provider.validateCredentials params (plaintext credential document) are not logged', async () => {
      const res = await fetch(`http://127.0.0.1:${logGateway.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'provider.validateCredentials',
          params: {
            providerId: 'bedrock',
            credentials: JSON.stringify({ authType: 'apiKey', apiKey: LIVE_VALIDATE_KEY }),
          },
        }),
      });
      expect(res.status).toBe(200);
      assertNoSecretKeys(lines, [LIVE_TEST_KEY, LIVE_VALIDATE_KEY]);
    });

    it('denied M2 requests log the method name only — never params', async () => {
      const res = await fetch(`http://127.0.0.1:${logGateway.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'secrets.getApiKey',
          params: { provider: 'anthropic', key: LIVE_VALIDATE_KEY },
        }),
      });
      expect(res.status).toBe(403);
      assertNoSecretKeys(lines, [LIVE_TEST_KEY, LIVE_VALIDATE_KEY]);
    });
  });
});

describe('gateway log redaction (§5.4: tokens never reach log output)', () => {
  let gateway: GatewayHandle;
  const lines: LogLine[] = [];

  beforeAll(async () => {
    gateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist: null,
      rpc: createFakeRpc({ 'task.list': [] }),
      logger: capturingLogger(lines),
      rateLimiterOptions: { limit: 10_000, windowMs: 1000 },
    });
  });

  afterAll(async () => {
    await gateway.close();
  });

  function assertNoToken(): void {
    for (const line of lines) {
      expect(line.text, `log line leaked the token: ${line.text}`).not.toContain(TOKEN);
      expect(line.text, `log line leaked a token fragment: ${line.text}`).not.toContain(
        TOKEN_FRAGMENT,
      );
    }
  }

  it('normal /rpc call logs nothing containing the token', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.list' }),
    });
    expect(res.status).toBe(200);
    assertNoToken();
  });

  it('401 responses (missing and wrong token) log nothing containing the token', async () => {
    let res = await fetch(`http://127.0.0.1:${gateway.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.list' }),
    });
    expect(res.status).toBe(401);
    res = await fetch(`http://127.0.0.1:${gateway.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer wrong-token` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.list' }),
    });
    expect(res.status).toBe(401);
    assertNoToken();
  });

  it('/client-log payloads carrying the token are redacted before logging', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        level: 'info',
        message: `debug dump: Authorization: Bearer ${TOKEN}`,
        context: `headers={ "Authorization": "Bearer ${TOKEN}" }`,
      }),
    });
    expect(res.status).toBe(200);
    const clientLines = lines.filter((line) => line.text.includes('[client]'));
    expect(clientLines.length).toBeGreaterThanOrEqual(1);
    for (const line of clientLines) {
      expect(line.text).toContain('[REDACTED]');
      expect(line.text).not.toContain(TOKEN);
    }
  });

  it('truncation cannot strand a token fragment when the redacted span straddles the cap', async () => {
    // 4000-char message cap: the token starts at char 3992, so a
    // slice-first implementation would cut it exactly after the 9-char
    // 'unit-test' prefix and leave a live fragment in the log.
    const filler = 'x'.repeat(3991);
    const res = await fetch(`http://127.0.0.1:${gateway.port}/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ level: 'info', message: filler + TOKEN }),
    });
    expect(res.status).toBe(200);
    const last = lines.at(-1);
    expect(last).toBeDefined();
    expect(last?.text).not.toContain(TOKEN);
    expect(last?.text).not.toContain(TOKEN_FRAGMENT);
  });

  it('WS auth messages (valid and invalid) log nothing containing the token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/events`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // The real token itself travels through this first frame — it must
        // never land in a log line.
        ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
      });
      ws.on('message', (data) => {
        if (data.toString('utf8').includes('auth-ok')) {
          resolve();
        } else {
          reject(new Error('unexpected first message'));
        }
      });
      ws.on('error', reject);
    });
    ws.close();
    const bad = new WebSocket(`ws://127.0.0.1:${gateway.port}/events`);
    await new Promise<void>((resolve) => {
      bad.on('open', () => {
        bad.send(JSON.stringify({ type: 'auth', token: 'not-the-token' }));
      });
      bad.on('close', () => resolve());
      bad.on('error', () => resolve());
    });
    // Give any (potential) async log writes a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertNoToken();
  });
});
