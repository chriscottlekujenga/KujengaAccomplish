import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import {
  transformMoonshotRequestBody,
  ensureMoonshotProxy,
  stopMoonshotProxy,
  isMoonshotProxyRunning,
  getMoonshotProxyBindAddress,
} from '../../../../src/opencode/proxies/moonshot-proxy.js';
import { PROXY_TOKEN_HEADER } from '../../../../src/opencode/proxies/azure-foundry-proxy.js';

describe('Moonshot Proxy', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Clean up any running proxy
    await stopMoonshotProxy();
  });

  describe('transformMoonshotRequestBody', () => {
    it('should remove top-level enable_thinking flag', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [{ role: 'user', content: 'Hello' }],
          enable_thinking: true,
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.enable_thinking).toBeUndefined();
    });

    it('should remove top-level reasoning flag', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [{ role: 'user', content: 'Hello' }],
          reasoning: true,
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.reasoning).toBeUndefined();
    });

    it('should remove top-level reasoning_effort flag', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [{ role: 'user', content: 'Hello' }],
          reasoning_effort: 'high',
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.reasoning_effort).toBeUndefined();
    });

    it('should convert max_completion_tokens to max_tokens', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [{ role: 'user', content: 'Hello' }],
          max_completion_tokens: 1000,
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.max_completion_tokens).toBeUndefined();
      expect(parsed.max_tokens).toBe(1000);
    });

    it('should not overwrite existing max_tokens', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [{ role: 'user', content: 'Hello' }],
          max_completion_tokens: 1000,
          max_tokens: 500,
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      // When max_tokens already exists, max_completion_tokens is NOT converted
      // Both remain in the request (the API will use max_tokens)
      expect(parsed.max_completion_tokens).toBe(1000);
      expect(parsed.max_tokens).toBe(500);
    });

    it('should add reasoning_content to assistant messages without it', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
          ],
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.messages[1].reasoning_content).toBeDefined();
    });

    it('should preserve existing reasoning_content', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!', reasoning_content: 'I thought about this' },
          ],
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.messages[1].reasoning_content).toBe('I thought about this');
    });

    it('should not add reasoning_content to non-assistant messages', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'system', content: 'You are helpful' },
          ],
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.messages[0].reasoning_content).toBeUndefined();
      expect(parsed.messages[1].reasoning_content).toBeUndefined();
    });

    it('should return original buffer for invalid JSON', () => {
      const body = Buffer.from('not valid json');

      const result = transformMoonshotRequestBody(body);

      expect(result.toString()).toBe('not valid json');
    });

    it('should handle empty messages array', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [],
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.messages).toEqual([]);
    });

    it('should handle nested messages in subobjects', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          nested: {
            messages: [{ role: 'assistant', content: 'Nested message' }],
          },
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.nested.messages[0].reasoning_content).toBeDefined();
    });

    it('should handle multiple transformations together', () => {
      const body = Buffer.from(
        JSON.stringify({
          model: 'kimi',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
          ],
          enable_thinking: true,
          reasoning_effort: 'high',
          max_completion_tokens: 2000,
        }),
      );

      const result = transformMoonshotRequestBody(body);
      const parsed = JSON.parse(result.toString());

      expect(parsed.enable_thinking).toBeUndefined();
      expect(parsed.reasoning_effort).toBeUndefined();
      expect(parsed.max_completion_tokens).toBeUndefined();
      expect(parsed.max_tokens).toBe(2000);
      expect(parsed.messages[1].reasoning_content).toBeDefined();
    });
  });

  describe('ensureMoonshotProxy', () => {
    it('should start proxy server and return proxy info', async () => {
      const result = await ensureMoonshotProxy('https://api.moonshot.cn');

      expect(result.baseURL).toBe('http://127.0.0.1:9229');
      expect(result.targetBaseURL).toBe('https://api.moonshot.cn');
      expect(result.port).toBe(9229);
    });

    it('should reuse existing proxy server', async () => {
      const result1 = await ensureMoonshotProxy('https://api.moonshot.cn');
      const result2 = await ensureMoonshotProxy('https://api.moonshot.cn/v2');

      expect(result1.baseURL).toBe(result2.baseURL);
      expect(result2.targetBaseURL).toBe('https://api.moonshot.cn/v2');
    });

    it('should normalize URL by removing trailing slash', async () => {
      const result = await ensureMoonshotProxy('https://api.moonshot.cn/');

      expect(result.targetBaseURL).toBe('https://api.moonshot.cn');
    });

    it('should throw for invalid URL', async () => {
      await expect(ensureMoonshotProxy('not-a-url')).rejects.toThrow('Invalid URL format');
    });

    it('should throw for unsupported protocol', async () => {
      await expect(ensureMoonshotProxy('ftp://api.moonshot.cn')).rejects.toThrow(
        'Invalid protocol: ftp:',
      );
    });
  });

  describe('stopMoonshotProxy', () => {
    it('should stop running proxy', async () => {
      await ensureMoonshotProxy('https://api.moonshot.cn');
      expect(isMoonshotProxyRunning()).toBe(true);

      await stopMoonshotProxy();

      expect(isMoonshotProxyRunning()).toBe(false);
    });

    it('should not throw when proxy not running', async () => {
      await stopMoonshotProxy();

      expect(isMoonshotProxyRunning()).toBe(false);
    });
  });

  describe('isMoonshotProxyRunning', () => {
    it('should return false initially', () => {
      expect(isMoonshotProxyRunning()).toBe(false);
    });

    it('should return true after starting proxy', async () => {
      await ensureMoonshotProxy('https://api.moonshot.cn');

      expect(isMoonshotProxyRunning()).toBe(true);
    });
  });

  // ─── Bearer-token auth (Phase 3 M1 §5.3) ─────────────────────────────────
  // Real provider credentials are NOT available here; the upstream is a stub
  // http server on an ephemeral loopback port and the proxy is verified
  // against it end-to-end.
  describe('proxy token auth (x-accomplish-proxy-token)', () => {
    interface CapturedRequest {
      method: string;
      path: string;
      headers: http.IncomingHttpHeaders;
      body: string;
    }

    let upstream: http.Server | null = null;
    let captured: CapturedRequest[] = [];
    let upstreamPort: number;

    beforeEach(async () => {
      captured = [];
      upstream = await new Promise<http.Server>((resolve) => {
        const u = http.createServer((req, res) => {
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true,"upstream":1}');
          });
        });
        u.listen(0, '127.0.0.1', () => resolve(u));
      });
      upstreamPort =
        typeof upstream.address() === 'object' && upstream.address()
          ? (upstream.address() as { port: number }).port
          : 0;
      await ensureMoonshotProxy(`http://127.0.0.1:${upstreamPort}/v1`);
    });

    afterEach(async () => {
      await closeUpstream();
      await stopMoonshotProxy();
    });

    async function closeUpstream(): Promise<void> {
      if (!upstream) {
        return;
      }
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      upstream = null;
    }

    async function moonshotFetch(
      path: string,
      init: RequestInit,
    ): Promise<{ status: number; body: string }> {
      const res = await fetch(`http://127.0.0.1:9229${path}`, init);
      return { status: res.status, body: await res.text() };
    }

    it('returns 401 with a JSON error when no token is presented', async () => {
      const res = await moonshotFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'kimi', messages: [{ role: 'user', content: 'Hello' }] }),
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).error).toContain('Unauthorized');
    });

    it('returns 401 when a WRONG token is presented', async () => {
      const res = await moonshotFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [PROXY_TOKEN_HEADER]: 'wrong-token' },
        body: JSON.stringify({ model: 'kimi', messages: [{ role: 'user', content: 'Hello' }] }),
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).error).toContain('invalid');
    });

    it('forwards upstream with token verified and never leaks the token header', async () => {
      const { token } = await ensureMoonshotProxy(`http://127.0.0.1:${upstreamPort}/v1`);

      captured = [];
      const res = await moonshotFetch('/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer upstream-moonshot-key',
          [PROXY_TOKEN_HEADER]: token,
        },
        body: JSON.stringify({
          model: 'kimi',
          messages: [{ role: 'user', content: 'Hello' }],
          enable_thinking: true,
          max_completion_tokens: 2000,
        }),
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, upstream: 1 });

      expect(captured).toHaveLength(1);
      const seen = captured[0];
      // Body transform unchanged by the token mechanism.
      const seenBody = JSON.parse(seen.body) as Record<string, unknown>;
      expect(seenBody.model).toBe('kimi');
      expect(seenBody.enable_thinking).toBeUndefined();
      expect(seenBody.max_tokens).toBe(2000);
      expect(seenBody.max_completion_tokens).toBeUndefined();
      // Upstream credential forwarded untouched; local token stripped.
      expect(seen.headers.authorization).toBe('Bearer upstream-moonshot-key');
      expect(seen.headers[PROXY_TOKEN_HEADER]).toBeUndefined();
      expect(seen.path).toBe('/v1/chat/completions');
      expect(seen.method).toBe('POST');
    });

    it('keeps /health unauthenticated for startup readiness probes', async () => {
      const res = await moonshotFetch('/health', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe('ok');
    });

    it('binds loopback only (127.0.0.1) — scripted bind assertion', () => {
      const bind = getMoonshotProxyBindAddress();
      expect(bind.address).toBe('127.0.0.1');
      expect(bind.port).toBe(9229);
    });
  });
});
