/**
 * WhatsAppSendApi surface tests (Phase 3 M1 §5.3).
 *
 * The API's only consumer is the whatsapp MCP tool (Node fetch, no Origin
 * header); the browser UI must not call this API directly. Confirms:
 *  - loopback bind (127.0.0.1),
 *  - 401 without / wrong token,
 *  - 403 for any Origin-bearing request,
 *  - OPTIONS (replaced bare-204 preflight): 204 only with a valid token and
 *    no disallowed Origin.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { WhatsAppSendApi } from '../../../src/whatsapp/whatsapp-send-api.js';
import { RateLimiter } from '../../../src/rate-limiter.js';
import type { WhatsAppDaemonService } from '../../../src/whatsapp-service.js';

const TOKEN = 'whatsapp-test-token';

function minimalFakeWhatsappService(): WhatsAppDaemonService {
  // Only getConfig() is reached for the authenticated /chats probe; rejected
  // requests never reach a route handler.
  return {
    getConfig: () => null,
  } as unknown as WhatsAppDaemonService;
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: data });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('WhatsAppSendApi auth and bind (Phase 3 M1 §5.3)', () => {
  let rateLimiter: RateLimiter | null = null;
  const api = new WhatsAppSendApi(minimalFakeWhatsappService(), TOKEN);
  // When :9230 is occupied (e.g. a live daemon in the environment), the
  // factory falls back to an OS-assigned port and reports it — the tests
  // exercise whichever port the API actually bound.
  let port = 0;

  afterEach(() => {
    rateLimiter?.dispose();
    rateLimiter = null;
    api.stop();
    vi.restoreAllMocks();
  });

  it('binds loopback only (127.0.0.1) — scripted bind assertion', async () => {
    rateLimiter = new RateLimiter(60_000, 60);
    await api.start(9230);
    port = api.getPort() ?? 0;
    expect(api.getBindAddress()).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });

  it('returns 401 without / wrong token', async () => {
    rateLimiter = new RateLimiter(60_000, 60);
    await api.start(9230);
    const port = api.getPort() ?? 0;

    const noToken = await request(port, 'POST', '/chats', { 'Content-Type': 'application/json' });
    expect(noToken.statusCode).toBe(401);

    const wrongToken = await request(
      port,
      'POST',
      '/chats',
      { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      '{}',
    );
    expect(wrongToken.statusCode).toBe(401);
    expect(JSON.parse(wrongToken.body).error).toBe('Unauthorized');
  });

  it('returns 403 for ANY Origin-bearing request (browser UI must not call this API directly)', async () => {
    rateLimiter = new RateLimiter(60_000, 60);
    await api.start(9230);
    const port = api.getPort() ?? 0;

    const res = await request(
      port,
      'POST',
      '/send',
      { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      '{}',
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('origin not allowed');
  });

  it('replaced bare-204 preflight: OPTIONS without token → 403, with token + no Origin → 204', async () => {
    rateLimiter = new RateLimiter(60_000, 60);
    await api.start(9230);
    const port = api.getPort() ?? 0;

    const withoutToken = await request(port, 'OPTIONS', '/send', {});
    expect(withoutToken.statusCode).toBe(403);

    const withToken = await request(port, 'OPTIONS', '/send', {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(withToken.statusCode).toBe(204);
  });

  it('accepts an authenticated origin-less MCP-tool request', async () => {
    rateLimiter = new RateLimiter(60_000, 60);
    await api.start(9230);
    const port = api.getPort() ?? 0;

    const res = await request(
      port,
      'POST',
      '/chats',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      '{}',
    );
    // Route reached (not_connected fake service response) — passes auth.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(false);
    expect(JSON.parse(res.body).error).toBe('not_connected');
  });
});
