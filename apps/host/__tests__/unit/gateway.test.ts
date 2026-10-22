/**
 * Gateway security tests — the Phase 1 auth matrix.
 *
 * Covers every layer of FIREFOX_MIGRATION_PLAN §7: bearer token (never via
 * query strings), Host header validation (DNS rebinding), Origin
 * validation, explicit method authorization (allowlist + blocklist),
 * per-token rate limiting, request-size caps, and static-file hardening
 * (CSP, nosniff, path traversal).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createGateway, type GatewayHandle } from '../../src/gateway.js';
import { RPC_METHOD_BLOCKLIST } from '../../src/policy.js';
import { createFakeRpc } from './fake-rpc.js';

const TOKEN = 'unit-test-gateway-token';

function makeWebDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-webdist-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>ui</body></html>');
  writeFileSync(path.join(dir, 'app.js'), 'console.log("app");');
  return dir;
}

describe('gateway security', () => {
  let gateway: GatewayHandle;
  let throttledGateway: GatewayHandle;
  let rpc: ReturnType<typeof createFakeRpc>;
  let webDist: string;
  let openExternalSpy: (url: string) => Promise<void>;
  const openExternalCalls: string[] = [];

  beforeAll(async () => {
    rpc = createFakeRpc({
      'task.list': [],
      'task.start': { id: 'tsk_1', status: 'running' },
    });
    webDist = makeWebDist();
    openExternalSpy = async (url: string) => {
      openExternalCalls.push(url);
    };
    gateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist,
      rpc,
      openExternalImpl: openExternalSpy,
    });
  });

  afterAll(async () => {
    await gateway.close();
    if (throttledGateway) {
      await throttledGateway.close();
    }
    rmSync(webDist, { recursive: true, force: true });
  });

  function rpcBody(id: string | number = 1, method = 'task.list', params?: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method, params });
  }

  async function postRpc(
    body: string,
    headers: Record<string, string> = {},
    port = gateway.port,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  describe('health endpoint', () => {
    it('responds without a token and reports version and platform', async () => {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; version: string; platform: string };
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe('string');
      expect(typeof body.platform).toBe('string');
    });
  });

  describe('bearer token auth', () => {
    it('rejects requests without a token', async () => {
      const { status } = await postRpc(rpcBody());
      expect(status).toBe(401);
    });

    it('rejects invalid tokens', async () => {
      const { status } = await postRpc(rpcBody(), { Authorization: 'Bearer wrong-token' });
      expect(status).toBe(401);
    });

    it('never accepts the token via query string', async () => {
      const res = await fetch(
        `http://127.0.0.1:${gateway.port}/rpc?token=${encodeURIComponent(TOKEN)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rpcBody(),
        },
      );
      expect(res.status).toBe(401);
    });

    it('proxies authorized methods with a valid token', async () => {
      const { status, body } = await postRpc(rpcBody('req-1', 'task.list'), {
        Authorization: `Bearer ${TOKEN}`,
      });
      expect(status).toBe(200);
      expect(body).toEqual({ jsonrpc: '2.0', id: 'req-1', result: [] });
      expect(rpc.calls.at(-1)?.method).toBe('task.list');
    });
  });

  describe('JSON-RPC handling', () => {
    it('echoes the request id', async () => {
      const { body } = await postRpc(rpcBody(42, 'task.list'), {
        Authorization: `Bearer ${TOKEN}`,
      });
      expect(body.id).toBe(42);
    });

    it('passes daemon-side errors through as JSON-RPC error bodies', async () => {
      const error = new Error('no provider configured') as Error & { code: number };
      error.code = -32001;
      const failingRpc = createFakeRpc({ 'task.start': error });
      const failGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: failingRpc,
      });
      const { status, body } = await postRpc(
        rpcBody(9, 'task.start'),
        {
          Authorization: `Bearer ${TOKEN}`,
        },
        failGateway.port,
      );
      expect(status).toBe(200);
      const errorBody = body.error as { code: number; message: string };
      expect(errorBody.code).toBe(-32001);
      expect(errorBody.message).toBe('no provider configured');
      await failGateway.close();
    });

    it('rejects malformed JSON with a parse error', async () => {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32700);
    });

    it('rejects requests without a method', async () => {
      const { status, body } = await postRpc(JSON.stringify({ jsonrpc: '2.0', id: 1 }), {
        Authorization: `Bearer ${TOKEN}`,
      });
      expect(status).toBe(400);
      const errorBody = (body as { error: { code: number } }).error;
      expect(errorBody.code).toBe(-32600);
    });
  });

  describe('method authorization', () => {
    it('rejects methods outside the allowlist', async () => {
      const { status } = await postRpc(rpcBody(1, 'secrets.clear', { provider: 'x' }), {
        Authorization: `Bearer ${TOKEN}`,
      });
      expect(status).toBe(403);
    });

    it('rejects allowlisted-but-blocked secret reads even if policy drifts', async () => {
      const hostileGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: createFakeRpc(),
        policySets: {
          // Simulate an allowlist mistake: every blocklisted method allowed.
          allow: new Set(RPC_METHOD_BLOCKLIST),
        },
      });
      for (const method of ['secrets.getApiKey', 'connectors.getTokens', 'gwsAccount.getToken']) {
        const { status } = await postRpc(
          rpcBody(1, method, {}),
          {
            Authorization: `Bearer ${TOKEN}`,
          },
          hostileGateway.port,
        );
        expect(status).toBe(403);
      }
      await hostileGateway.close();
    });

    // Phase 3 M2 T1a: every newly allowlisted method is reachable for an
    // authenticated browser and hard-401s without the bearer token — the
    // §5.4(d) authorization-test counterpart to the M1 matrix above.
    describe('M2 expansion authorization matrix', () => {
      const M2_METHODS = [
        'provider.testConnection',
        'provider.fetchModels',
        'provider.validateKey',
        'provider.validateCredentials',
        'provider.setActive',
        'provider.setConnected',
        'provider.removeConnected',
        'provider.updateModel',
        'provider.setDebugMode',
        'secrets.listApiKeys',
        'secrets.deleteApiKey',
        'secrets.storeBedrockCredentials',
        'settings.getOpenAiBaseUrl',
        'settings.setOpenAiBaseUrl',
        'settings.getOllamaConfig',
        'settings.setOllamaConfig',
        'settings.getLiteLLMConfig',
        'settings.setLiteLLMConfig',
        'settings.getLMStudioConfig',
        'settings.setLMStudioConfig',
        'settings.getAzureFoundryConfig',
        'settings.setAzureFoundryConfig',
        'settings.setNimConfig',
      ];

      for (const method of M2_METHODS) {
        it(`proxies ${method} for an authenticated caller`, async () => {
          const { status } = await postRpc(rpcBody(1, method, { providerId: 'openai' }), {
            Authorization: `Bearer ${TOKEN}`,
          });
          expect(status).toBe(200);
        });

        it(`requires the bearer token for ${method} (401 without auth)`, async () => {
          const { status } = await postRpc(rpcBody(1, method, { providerId: 'openai' }));
          expect(status).toBe(401);
        });
      }

      it('blocklist still wins over an allowlist mistake for plaintext secret reads', async () => {
        const hostileGateway = await createGateway({
          port: 0,
          token: TOKEN,
          webDist: null,
          rpc: createFakeRpc(),
          policySets: { allow: new Set([...RPC_METHOD_BLOCKLIST, 'provider.validateKey']) },
        });
        for (const method of ['secrets.getApiKey', 'secrets.getAllApiKeys']) {
          const { status } = await postRpc(
            rpcBody(1, method, { provider: 'anthropic' }),
            {
              Authorization: `Bearer ${TOKEN}`,
            },
            hostileGateway.port,
          );
          expect(status).toBe(403);
        }
        await hostileGateway.close();
      });
    });
  });

  describe('Host and Origin validation', () => {
    function rawRequest(
      port: number,
      headers: Record<string, string>,
    ): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString();
            });
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body: data });
            });
          },
        );
        req.on('error', reject);
        req.end(rpcBody());
      });
    }

    it('rejects a rebound Host header (DNS-rebinding payload)', async () => {
      const { status } = await rawRequest(gateway.port, {
        Host: 'evil.example.com:443',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      });
      expect(status).toBe(403);
    });

    it('rejects the right host on the wrong port', async () => {
      const { status } = await rawRequest(gateway.port, {
        Host: '127.0.0.1:9999',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      });
      expect(status).toBe(403);
    });

    it('rejects a cross-origin Origin header even with a valid token', async () => {
      const { status } = await postRpc(rpcBody(), {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'http://evil.example.com',
      });
      expect(status).toBe(403);
    });

    it('accepts same-origin Origin with a valid token', async () => {
      const { status } = await postRpc(rpcBody(), {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${gateway.port}`,
      });
      expect(status).toBe(200);
    });
  });

  describe('rate limiting', () => {
    it('throttles bursts beyond the per-token limit', async () => {
      throttledGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: createFakeRpc(),
        rateLimiterOptions: { limit: 3, windowMs: 60_000 },
      });
      const send = () =>
        postRpc(
          rpcBody(1, 'task.list'),
          { Authorization: `Bearer ${TOKEN}` },
          throttledGateway.port,
        );
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(429);
    });
  });

  describe('open-external endpoint', () => {
    it('opens valid http(s) URLs through the injected opener', async () => {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/open-external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ url: 'https://example.com/docs' }),
      });
      expect(res.status).toBe(200);
      expect(openExternalCalls).toContain('https://example.com/docs');
    });

    it('rejects non-http schemes', async () => {
      for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not-a-url']) {
        const res = await fetch(`http://127.0.0.1:${gateway.port}/open-external`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ url }),
        });
        expect(res.status).toBe(400);
      }
      expect(openExternalCalls).not.toContain('file:///etc/passwd');
    });
  });

  describe('static file serving', () => {
    it('serves index.html with CSP and nosniff headers', async () => {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
    });

    it('serves assets with correct content types', async () => {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');
    });

    it('falls back to index.html for extension-less SPA routes', async () => {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/execution/tsk_123`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('404s missing asset paths instead of serving HTML', async () => {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/assets/missing-abc.js`);
      expect(res.status).toBe(404);
    });

    it('never serves files outside the web dist (traversal attempts)', async () => {
      // Extensionless escapes resolve to the SPA fallback — the response
      // must be the UI shell, never the target file.
      const htmlRes = await fetch(`http://127.0.0.1:${gateway.port}/../../etc/passwd`);
      const htmlBody = await htmlRes.text();
      expect(htmlRes.headers.get('content-type')).toContain('text/html');
      expect(htmlBody).toContain('ui');
      expect(htmlBody).not.toContain('root:');

      const encodedHtmlRes = await fetch(`http://127.0.0.1:${gateway.port}/..%2f..%2fetc%2fpasswd`);
      const encodedHtmlBody = await encodedHtmlRes.text();
      expect(encodedHtmlBody).toContain('ui');
      expect(encodedHtmlBody).not.toContain('root:');

      // Escapes that keep a file extension must 404 — containment holds.
      const fileRes = await fetch(
        `http://127.0.0.1:${gateway.port}/..%2f..%2f..%2fetc%2fsecret.js`,
      );
      expect(fileRes.status).toBe(404);
    });
  });

  describe('request size caps', () => {
    it('rejects oversized request bodies', async () => {
      const smallCapGateway = await createGateway({
        port: 0,
        token: TOKEN,
        webDist: null,
        rpc: createFakeRpc(),
        maxBodyBytes: 64,
      });
      const res = await fetch(`http://127.0.0.1:${smallCapGateway.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: rpcBody(1, 'task.list', { big: 'x'.repeat(500) }),
      });
      expect(res.status).toBe(413);
      await smallCapGateway.close();
    });
  });
});
