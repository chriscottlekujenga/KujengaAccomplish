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
