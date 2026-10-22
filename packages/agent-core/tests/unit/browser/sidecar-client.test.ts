import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import {
  fetchDevBrowserServerInfo,
  fetchDevBrowserPageList,
  openDevBrowserPage,
} from '../../../src/browser/sidecar-client.js';

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

interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  auth: string | null;
}

/** Sidecar stub that answers with the given JSON body and asserts the bearer token. */
function sidecarStub(
  expectedToken: string,
  status: number,
  body: unknown,
  captured: CapturedRequest[] = [],
): http.RequestListener {
  return (req, res) => {
    captured.push({
      method: req.method,
      path: req.url,
      auth: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
    });
    if (req.headers['authorization'] !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

describe('dev-browser sidecar client (Phase 3 M1 — daemon preview bridge)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchDevBrowserServerInfo returns info and sends the bearer token', async () => {
    const captured: CapturedRequest[] = [];
    const server = await listenZero(
      sidecarStub(
        'tok-1',
        200,
        { wsEndpoint: 'ws://127.0.0.1:53123/devtools/browser/abc', browserReady: true },
        captured,
      ),
    );
    const { port } = await addressOf(server);
    try {
      const info = await fetchDevBrowserServerInfo(port, 'tok-1');
      expect(info).toEqual({
        wsEndpoint: 'ws://127.0.0.1:53123/devtools/browser/abc',
        browserReady: true,
      });
      expect(captured).toHaveLength(1);
      expect(captured[0].method).toBe('GET');
      expect(captured[0].path).toBe('/');
    } finally {
      await closeServer(server);
    }
  });

  it('treats an empty wsEndpoint as "browser not launched" via info.browserReady=false', async () => {
    const server = await listenZero(
      sidecarStub('tok', 200, { wsEndpoint: '', browserReady: false }),
    );
    const { port } = await addressOf(server);
    try {
      expect(await fetchDevBrowserServerInfo(port, 'tok')).toEqual({
        wsEndpoint: '',
        browserReady: false,
      });
    } finally {
      await closeServer(server);
    }
  });

  it('fetchDevBrowserPageList returns page names and sends the bearer token on GET /pages', async () => {
    const captured: CapturedRequest[] = [];
    const server = await listenZero(
      sidecarStub('tok-2', 200, { pages: ['task-1-main', 'task-2-side'] }, captured),
    );
    const { port } = await addressOf(server);
    try {
      expect(await fetchDevBrowserPageList(port, 'tok-2')).toEqual(['task-1-main', 'task-2-side']);
      expect(captured[0].method).toBe('GET');
      expect(captured[0].path).toBe('/pages');
    } finally {
      await closeServer(server);
    }
  });

  it('openDevBrowserPage POSTs the page body with auth and returns the response', async () => {
    const captured: CapturedRequest[] = [];
    const server = await listenZero(
      sidecarStub(
        'tok-3',
        200,
        {
          wsEndpoint: 'ws://127.0.0.1:54000/devtools/browser/x',
          name: 'task-9-main',
          targetId: 'T123',
          created: true,
        },
        captured,
      ),
    );
    const { port } = await addressOf(server);
    try {
      const info = await openDevBrowserPage(
        port,
        { name: 'task-9-main', viewport: { width: 1280, height: 720 } },
        'tok-3',
      );
      expect(info?.targetId).toBe('T123');
      expect(captured[0].method).toBe('POST');
      expect(captured[0].path).toBe('/pages');
    } finally {
      await closeServer(server);
    }
  });

  it('resolves to null on 401 token mismatch (stale sidecar guard)', async () => {
    const server = await listenZero(sidecarStub('the-real-token', 200, { wsEndpoint: 'ws://x' }));
    const { port } = await addressOf(server);
    try {
      expect(await fetchDevBrowserServerInfo(port, 'wrong-token')).toBeNull();
      expect(await fetchDevBrowserPageList(port, 'wrong-token')).toBeNull();
      expect(await openDevBrowserPage(port, { name: 'p' }, 'wrong-token')).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('resolves to null when the sidecar is unreachable (connection refused)', async () => {
    expect(await fetchDevBrowserServerInfo(59999, 'tok')).toBeNull();
    expect(await fetchDevBrowserPageList(59999, 'tok')).toBeNull();
    expect(await openDevBrowserPage(59999, { name: 'p' }, 'tok')).toBeNull();
  });

  it('resolves to null on non-OK status codes', async () => {
    const server = await listenZero(sidecarStub('tok', 500, { error: 'boom' }));
    const { port } = await addressOf(server);
    try {
      expect(await fetchDevBrowserServerInfo(port, 'tok')).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('resolves to null when the sidecar responds with malformed JSON', async () => {
    const server = await listenZero((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json');
    });
    const { port } = await addressOf(server);
    try {
      expect(await fetchDevBrowserServerInfo(port, 'tok')).toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});
