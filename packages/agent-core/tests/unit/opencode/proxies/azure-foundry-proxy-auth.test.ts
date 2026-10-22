/**
 * Azure Foundry proxy — bearer-token integration tests (Phase 3 M1 §5.3).
 *
 * Real provider credentials are NOT available in the dev environment, so the
 * upstream Azure endpoint is a stub http server on an ephemeral loopback
 * port; the proxy forwards our controlled requests to it and we assert the
 * exact request shape and passthrough semantics.
 *
 * Binds the real :9228 proxy port (freed by tests/globalSetup.ts), so this
 * file must not run concurrently with another file that binds 9228 (the
 * unit-level azure-foundry-proxy.test.ts mocks `http` and binds nothing).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import {
  ensureAzureFoundryProxy,
  stopAzureFoundryProxy,
  getAzureFoundryProxyBindAddress,
  PROXY_TOKEN_HEADER,
} from '../../../../src/opencode/proxies/azure-foundry-proxy.js';

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let upstream: http.Server | null = null;
let captured: CapturedRequest[] = [];
let upstreamResponses: Array<{ status: number; body: string }> = [];

const UPSTREAM_BODY_TEMPLATE = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  reasoning_effort: 'high',
  max_tokens: 2000,
};

async function listenEphemeral(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function proxyFetch(
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:9228${path}`, init);
  return { status: res.status, body: await res.text() };
}

describe('Azure Foundry proxy token auth (Phase 3 M1 §5.3)', () => {
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    captured = [];
    upstreamResponses = [{ status: 200, body: '{"ok":true,"upstream":1}' }];
    upstream = await listenEphemeral((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        captured.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body,
        });
        const next = upstreamResponses.shift() ?? { status: 200, body: '{"ok":true}' };
        res.writeHead(next.status, { 'Content-Type': 'application/json' });
        res.end(next.body);
      });
    });
    const addr = upstream.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await ensureAzureFoundryProxy(`http://127.0.0.1:${port}/openai/v1`);
  });

  afterAll(async () => {
    await closeServer(upstream);
    await stopAzureFoundryProxy();
    vi.restoreAllMocks();
  });

  it('returns 401 with a JSON error when no token is presented', async () => {
    const res = await proxyFetch('/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(UPSTREAM_BODY_TEMPLATE),
    });
    expect(res.status).toBe(401);
    const payload = JSON.parse(res.body) as { error?: string };
    expect(payload.error).toContain('Unauthorized');
  });

  it('returns 401 when a WRONG token is presented', async () => {
    const res = await proxyFetch('/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PROXY_TOKEN_HEADER]: 'wrong-token',
      },
      body: JSON.stringify(UPSTREAM_BODY_TEMPLATE),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error).toContain('invalid');
  });

  it('forwards upstream with the token verified and never leaks the token header', async () => {
    // Fresh token for this request (each ensure call registers a new one).
    const { token } = await ensureAzureFoundryProxy(
      `http://127.0.0.1:${
        typeof upstream!.address() === 'object' && upstream!.address()
          ? (upstream!.address() as { port: number }).port
          : 0
      }/openai/v1`,
    );

    captured = [];
    const res = await proxyFetch('/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer upstream-azure-key',
        [PROXY_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(UPSTREAM_BODY_TEMPLATE),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, upstream: 1 });

    expect(captured).toHaveLength(1);
    const seen = captured[0];
    // Byte-identical forwarding semantics: body transformed (reasoning_effort
    // stripped, max_tokens converted) — same as pre-token behavior.
    const seenBody = JSON.parse(seen.body) as Record<string, unknown>;
    expect(seenBody.model).toBe('gpt-4o');
    expect(seenBody.reasoning_effort).toBeUndefined();
    expect(seenBody.max_completion_tokens).toBe(2000);
    expect(seenBody.max_tokens).toBeUndefined();
    // Authorization (the real upstream credential) is forwarded untouched.
    expect(seen.headers.authorization).toBe('Bearer upstream-azure-key');
    // The proxy token header must NOT reach upstream.
    expect(seen.headers[PROXY_TOKEN_HEADER]).toBeUndefined();
    // targetBaseUrl (/openai/v1) + request path — unchanged joining behavior.
    expect(seen.path).toBe('/openai/v1/chat/completions');
    expect(seen.method).toBe('POST');
  });

  it('keeps /health unauthenticated for startup readiness probes', async () => {
    const res = await proxyFetch('/health', { method: 'GET' });
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { status?: string };
    expect(payload.status).toBe('ok');
  });

  it('binds loopback only (127.0.0.1) — scripted bind assertion', async () => {
    const bind = getAzureFoundryProxyBindAddress();
    expect(bind.address).toBe('127.0.0.1');
    expect(bind.port).toBe(9228);
    expect(typeof bind.port).toBe('number');
  });
});
