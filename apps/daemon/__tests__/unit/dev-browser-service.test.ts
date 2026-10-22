/**
 * Unit tests for DevBrowserService (Phase 3 M1 — dev-browser preview bridge).
 *
 * The service probes the daemon-owned dev-browser sidecar over authenticated
 * HTTP and is the authoritative answerer for the `devBrowser.*` preview RPCs.
 * These tests stub the sidecar with a local http server on an ephemeral port,
 * so test traffic never touches the real :9224.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { DevBrowserService } from '../../src/dev-browser-service.js';

const TOKEN = 'daemon-sidecar-token';

// The service resolves its bearer token via getDevBrowserToken() — env wins
// over the memoized per-process fallback, so pin it for the whole file.
beforeAll(() => {
  process.env.ACCOMPLISH_DEV_BROWSER_TOKEN = TOKEN;
});

afterAll(() => {
  delete process.env.ACCOMPLISH_DEV_BROWSER_TOKEN;
});

function listenZero(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function portOf(server: http.Server): Promise<number> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('unexpected server address');
  }
  return addr.port;
}

/** Minimal sidecar stub mimicking GET /, GET /pages and POST /pages. */
function sidecarStub(
  expectedToken: string,
  responses: { wsEndpoint: string; pages: string[]; targetId?: string },
): http.RequestListener {
  return (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const path = req.url ?? '';
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ wsEndpoint: responses.wsEndpoint, browserReady: !!responses.wsEndpoint }),
      );
      return;
    }
    if (path === '/pages' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pages: responses.pages }));
      return;
    }
    if (path === '/pages' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { name: string };
        if (responses.targetId === undefined) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'browser unavailable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            wsEndpoint: responses.wsEndpoint,
            name: body.name,
            targetId: responses.targetId,
            created: true,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

describe('DevBrowserService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getPreviewInfo merges GET / and GET /pages with the provided token', async () => {
    const server = await listenZero(
      sidecarStub(TOKEN, {
        wsEndpoint: 'ws://127.0.0.1:53123/devtools/browser/abc',
        pages: ['task-1-main', 'task-1-side'],
        targetId: 'T1',
      }),
    );
    const port = await portOf(server);
    const service = new DevBrowserService({ devBrowserPort: port });
    try {
      await expect(service.getPreviewInfo()).resolves.toEqual({
        wsEndpoint: 'ws://127.0.0.1:53123/devtools/browser/abc',
        pages: ['task-1-main', 'task-1-side'],
      });
    } finally {
      await closeServer(server);
    }
  });

  it('getPreviewInfo reports null wsEndpoint while the browser has not launched', async () => {
    const server = await listenZero(
      sidecarStub(TOKEN, { wsEndpoint: '', pages: [], targetId: undefined }),
    );
    const port = await portOf(server);
    const service = new DevBrowserService({ devBrowserPort: port });
    try {
      await expect(service.getPreviewInfo()).resolves.toEqual({
        wsEndpoint: null,
        pages: [],
      });
    } finally {
      await closeServer(server);
    }
  });

  it('openPreviewPage returns the targetId from POST /pages', async () => {
    const server = await listenZero(
      sidecarStub(TOKEN, { wsEndpoint: 'ws://x', pages: [], targetId: 'T42' }),
    );
    const port = await portOf(server);
    const service = new DevBrowserService({ devBrowserPort: port });
    try {
      await expect(
        service.openPreviewPage({
          name: 'task-9-main',
          viewport: { width: 1280, height: 720 },
        }),
      ).resolves.toEqual({ targetId: 'T42' });
    } finally {
      await closeServer(server);
    }
  });

  it('degrades to nulls when the sidecar is unreachable', async () => {
    const service = new DevBrowserService({ devBrowserPort: 59998 });
    await expect(service.getPreviewInfo()).resolves.toEqual({
      wsEndpoint: null,
      pages: null,
    });
    await expect(service.openPreviewPage({ name: 'task-1-main' })).resolves.toBeNull();
  });

  it('degrades to nulls on a token mismatch (stale sidecar)', async () => {
    // Sidecar expects a different token than the one the service holds.
    const server = await listenZero(
      sidecarStub('a-foreign-token', {
        wsEndpoint: 'ws://x',
        pages: ['leak'],
        targetId: 'T1',
      }),
    );
    const port = await portOf(server);
    const service = new DevBrowserService({ devBrowserPort: port });
    try {
      await expect(service.getPreviewInfo()).resolves.toEqual({
        wsEndpoint: null,
        pages: null,
      });
      await expect(service.openPreviewPage({ name: 'task-1-main' })).resolves.toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('degrades to null when the sidecar fails to create the page', async () => {
    const server = await listenZero(
      sidecarStub(TOKEN, { wsEndpoint: 'ws://x', pages: [], targetId: undefined }),
    );
    const port = await portOf(server);
    const service = new DevBrowserService({ devBrowserPort: port });
    try {
      await expect(service.openPreviewPage({ name: 'task-1-main' })).resolves.toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});
