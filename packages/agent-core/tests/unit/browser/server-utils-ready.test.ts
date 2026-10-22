import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import {
  isDevBrowserServerReady,
  waitForDevBrowserServer,
  buildBrowserSpawnEnvironment,
} from '../../../src/browser/server-utils.js';

function listenZero(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function addressOf(server: http.Server): Promise<{ address: string; port: number }> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('unexpected server address');
  }
  return { address: addr.address, port: addr.port };
}

describe('isDevBrowserServerReady with sidecar token (Phase 3 M1 §5.3)', () => {
  it('returns false on 401 (stale sidecar with a foreign token)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = await listenZero((req, res) => {
      let authHeader = req.headers['authorization'];
      if (typeof authHeader !== 'string') {
        authHeader = '';
      }
      if (authHeader === 'Bearer expected-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ wsEndpoint: '', browserReady: false }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
    });
    const { port } = await addressOf(server);

    try {
      // No token at all → 401 → not ready.
      expect(await isDevBrowserServerReady(port)).toBe(false);
      // Wrong token → 401 → not ready.
      expect(await isDevBrowserServerReady(port, 'wrong-token')).toBe(false);
      // Right token → 200 → ready.
      expect(await isDevBrowserServerReady(port, 'expected-token')).toBe(true);
    } finally {
      await closeServer(server);
      vi.restoreAllMocks();
    }
  });

  it('waitForDevBrowserServer succeeds once the token-bearing probe is accepted', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const server = await listenZero((req, res) => {
      res.writeHead(200);
      res.end();
    });
    const { port } = await addressOf(server);
    try {
      const ready = await waitForDevBrowserServer(port, 5000, 100, 'any-token');
      expect(ready).toBe(true);
    } finally {
      await closeServer(server);
      vi.restoreAllMocks();
    }
  });
});

describe('buildBrowserSpawnEnvironment token injection', () => {
  afterEach(() => {
    delete process.env.ACCOMPLISH_DEV_BROWSER_TOKEN;
    vi.restoreAllMocks();
  });

  it('injects the provided token into the spawn env', () => {
    const env = buildBrowserSpawnEnvironment(undefined, 'tok-xyz');
    expect(env.ACCOMPLISH_DEV_BROWSER_TOKEN).toBe('tok-xyz');
  });

  it('falls back to the per-process token when none is provided', () => {
    delete process.env.ACCOMPLISH_DEV_BROWSER_TOKEN;
    const env = buildBrowserSpawnEnvironment(undefined, undefined);
    expect(typeof env.ACCOMPLISH_DEV_BROWSER_TOKEN).toBe('string');
    expect((env.ACCOMPLISH_DEV_BROWSER_TOKEN as string).length).toBe(43);
  });

  it('still prepends the bundled Node bin dir to PATH', () => {
    const env = buildBrowserSpawnEnvironment('/some/node/bin', 'tok');
    expect(env.PATH).toContain('/some/node/bin');
    expect(env.NODE_BIN_PATH).toBe('/some/node/bin');
    expect(env.ACCOMPLISH_DEV_BROWSER_TOKEN).toBe('tok');
  });
});
