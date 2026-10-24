/**
 * Unit tests for DevBrowserService captureFrame/shutdown (Phase 3 M2 T4 —
 * browser-preview on-demand screenshot v1 + the graceful sidecar teardown).
 *
 * The sidecar is stubbed with a local HTTP server on an ephemeral port (same
 * pattern as dev-browser-service.test.ts) and the CDP browser half is stubbed
 * with a local WebSocket server (`ws` devDependency) that answers the exact
 * commands the minimal daemon CdpClient sends. Test traffic never touches the
 * real :9224/:9225 loops. For `shutdown`'s happy path the "sidecar" is a
 * detached CHILD node process: the real agent-core machinery (graceful POST
 * /shutdown, then the forced port-kill fallback) runs against it without the
 * port-kill ever facing the vitest process (an in-process stub listening on
 * the service port would make `killProcessOnPort` SIGTERM the test runner).
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import { logger } from '@accomplish_ai/agent-core';
import { DevBrowserService } from '../../src/dev-browser-service.js';

const TOKEN = 'daemon-sidecar-token';
const FAKE_JPEG_B64 = Buffer.from('fake-jpeg-bytes').toString('base64');
const UNBOUND_PORT = 59997; // nothing listens here in the test env
const UNBOUND_WS_PORT = 59996;

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

function portOf(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('unexpected server address');
  }
  return addr.port;
}

interface CdpStubHandle {
  received: string[];
  /** Params of every Target.attachToTarget — the capture's target identity. */
  attachTargetIds: string[];
  port: number;
  close: () => Promise<void>;
}

/** Stub CDP browser: answers the three commands the capture flow sends. */
async function listenCdpStub(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<CdpStubHandle> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const received: string[] = [];
  const attachTargetIds: string[] = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      received.push(msg.method);
      if (msg.method === 'Target.attachToTarget' && typeof msg.params?.targetId === 'string') {
        attachTargetIds.push(msg.params.targetId);
      }
      if (msg.method in overrides) {
        const override = overrides[msg.method];
        const isError =
          override !== null && typeof override === 'object' && 'error' in (override as object);
        ws.send(
          JSON.stringify(
            isError ? { id: msg.id, error: override } : { id: msg.id, result: override ?? {} },
          ),
        );
        return;
      }
      const respond = (result: unknown): void => {
        ws.send(JSON.stringify({ id: msg.id, result }));
      };
      if (msg.method === 'Target.attachToTarget') {
        respond({ sessionId: 'sess-1' });
      } else if (msg.method === 'Page.getLayoutMetrics') {
        respond({ cssContentSize: { width: 800, height: 600 } });
      } else if (msg.method === 'Page.captureScreenshot') {
        respond({ data: FAKE_JPEG_B64 });
      } else {
        respond({});
      }
    });
  });
  const port = await new Promise<number>((resolve) => {
    wss.on('listening', () => {
      const addr = wss.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('unexpected cdp stub address');
      }
      resolve(addr.port);
    });
  });
  return {
    received,
    attachTargetIds,
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

interface SidecarStubOptions {
  wsEndpoint: string;
  targetId?: string;
  /** 401 every request — a stale foreign-token sidecar. */
  rejectToken?: boolean;
  /**
   * M6-A T5: model the sidecar's REAL registry semantics
   * (BrowserPageService.ensurePage dedupes BY NAME): the first ensure of a
   * name mints a fresh targetId with `created:true`; repeats of the SAME
   * name return the SAME targetId with `created:false`. Distinct names mint
   * distinct targetIds. Mutually exclusive with a fixed options.targetId.
   */
  registry?: RegistryStubState;
}

/** Observable registry stub state (M6-A T5 page-identity tests). */
interface RegistryStubState {
  /** Every requested POST /pages name, in request order (with repeats). */
  ensuredNames: string[];
  /** name → {targetId, created-first-mint} — one entry per distinct name. */
  pages: Map<string, { targetId: string; created: boolean }>;
}

/** Minimal sidecar stub: GET /, GET /pages, POST /pages, POST /shutdown. */
function sidecarStub(expectedToken: string, options: SidecarStubOptions): http.RequestListener {
  return (req, res) => {
    if (options.rejectToken || req.headers['authorization'] !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const url = req.url ?? '';
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ wsEndpoint: options.wsEndpoint, browserReady: !!options.wsEndpoint }),
      );
      return;
    }
    if (url === '/pages' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ pages: options.registry ? [...options.registry.pages.keys()] : [] }),
      );
      return;
    }
    if (url === '/pages' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { name: string; viewport?: unknown };
        let targetId: string;
        let created: boolean;
        if (options.registry) {
          options.registry.ensuredNames.push(body.name);
          const existing = options.registry.pages.get(body.name);
          if (existing) {
            targetId = existing.targetId;
            created = false;
          } else {
            targetId = `T${options.registry.pages.size + 1}`;
            created = true;
            options.registry.pages.set(body.name, { targetId, created });
          }
        } else {
          targetId = options.targetId ?? 'T1';
          created = true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            wsEndpoint: options.wsEndpoint,
            name: body.name,
            viewport: body.viewport,
            targetId,
            created,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

describe('DevBrowserService.captureFrame (stub sidecar + stub CDP WS server)', () => {
  let cdp: CdpStubHandle | null = null;
  let sidecar: http.Server | null = null;
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
    cdp = null;
    sidecar = null;
    vi.restoreAllMocks();
  });

  /** Boots stub CDP + stub sidecar and points a fresh service at the stub. */
  async function startStack(
    cdpOverrides: Partial<Record<string, unknown>> = {},
    sidecarOptions: Partial<SidecarStubOptions> = {},
  ): Promise<DevBrowserService> {
    cdp = await listenCdpStub(cdpOverrides);
    cleanups.push(cdp.close);
    sidecar = await listenZero(
      sidecarStub(TOKEN, {
        wsEndpoint: sidecarOptions.wsEndpoint ?? `ws://127.0.0.1:${cdp.port}/devtools/browser/abc`,
        targetId: sidecarOptions.targetId,
        rejectToken: sidecarOptions.rejectToken,
        registry: sidecarOptions.registry,
      }),
    );
    cleanups.push(() => closeServer(sidecar as http.Server));
    return new DevBrowserService({ devBrowserPort: portOf(sidecar as http.Server) });
  }

  it('returns { data, width, height } on the happy path (default page name)', async () => {
    const service = await startStack();
    const stub = cdp as CdpStubHandle;
    await expect(service.captureFrame({ taskId: 'task-1' })).resolves.toEqual({
      data: FAKE_JPEG_B64,
      width: 800,
      height: 600,
    });
    // CDP protocol: attach (flatten) drives the capture commands, in-session.
    expect(stub.received).toEqual([
      'Target.attachToTarget',
      'Page.getLayoutMetrics',
      'Page.captureScreenshot',
    ]);
  });

  it('targets `${taskId}-${pageName}` when pageName is provided', async () => {
    const service = await startStack();
    await expect(service.captureFrame({ taskId: 'task-9', pageName: 'search' })).resolves.toEqual({
      data: FAKE_JPEG_B64,
      width: 800,
      height: 600,
    });
  });

  it('returns null when no sidecar is running (never throws)', async () => {
    const service = new DevBrowserService({ devBrowserPort: UNBOUND_PORT });
    await expect(service.captureFrame({ taskId: 'task-1' })).resolves.toBeNull();
    await expect(service.captureFrame({ taskId: 'task-1', pageName: 'other' })).resolves.toBeNull();
  });

  it('returns null when the wsEndpoint is still empty (Chrome not launched yet)', async () => {
    // Sidecar reachable, page opened, but GET / reports no CDP endpoint yet —
    // the openPreviewPage-first ordering must not trust an empty endpoint.
    const service = await startStack({}, { wsEndpoint: '' });
    await expect(service.captureFrame({ taskId: 'task-1' })).resolves.toBeNull();
  });

  it('returns null when the sidecar serves no targetId', async () => {
    const service = await startStack({}, { targetId: '' });
    await expect(service.captureFrame({ taskId: 'task-1' })).resolves.toBeNull();
  });

  it('returns null when the CDP endpoint refuses the WebSocket connection', async () => {
    const service = await startStack(
      {},
      { wsEndpoint: `ws://127.0.0.1:${UNBOUND_WS_PORT}/devtools/browser/abc` },
    );
    await expect(service.captureFrame({ taskId: 'task-1' })).resolves.toBeNull();
  });

  it('returns null when the CDP attach is rejected', async () => {
    const service = await startStack({
      'Target.attachToTarget': {
        code: -32000,
        message: 'Inspected target navigated or closed',
      },
    });
    await expect(service.captureFrame({ taskId: 'task-1' })).resolves.toBeNull();
  });

  it('returns null when captureScreenshot errors', async () => {
    const service = await startStack({
      'Page.captureScreenshot': { code: -32000, message: 'Compositing surface busy' },
    });
    await expect(service.captureFrame({ taskId: 'task-1' })).resolves.toBeNull();
  });

  it('never includes token material in the frame result', async () => {
    const service = await startStack();
    const result = (await service.captureFrame({ taskId: 'task-1' })) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['data', 'height', 'width']);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('preview-seam page identity (M6-A T5 — active-page selection across both registry writers)', () => {
  /**
   * The T0 root cause: the dev-browser-mcp tool child and the preview both
   * write the sidecar page registry, and pre-fix they handed it DIFFERENT
   * keys (`default-main` vs `<taskId>-main`) — two tabs, preview capturing
   * the blank one. The fix threads ACCOMPLISH_TASK_ID into the generated
   * mcp.dev-browser-mcp.environment (agent-core generator tests + the
   * task-config-builder chain test pin that), so after the fix BOTH writers
   * compose the SAME key `<taskId>-main`. These tests pin the invariant on
   * the daemon side against a registry-faithful stub (name-keyed dedupe,
   * exactly BrowserPageService.ensurePage semantics).
   */
  let cdp: CdpStubHandle | null = null;
  let sidecar: http.Server | null = null;
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
    cdp = null;
    sidecar = null;
    vi.restoreAllMocks();
  });

  async function startRegistryStack(): Promise<{
    service: DevBrowserService;
    registry: RegistryStubState;
  }> {
    const registry: RegistryStubState = { ensuredNames: [], pages: new Map() };
    cdp = await listenCdpStub();
    cleanups.push(cdp.close);
    sidecar = await listenZero(
      sidecarStub(TOKEN, {
        wsEndpoint: `ws://127.0.0.1:${cdp.port}/devtools/browser/abc`,
        registry,
      }),
    );
    cleanups.push(() => closeServer(sidecar as http.Server));
    return {
      service: new DevBrowserService({ devBrowserPort: portOf(sidecar as http.Server) }),
      registry,
    };
  }

  it('captures the frame from the ONE page both writers share under `<taskId>-main`', async () => {
    const { service, registry } = await startRegistryStack();
    const stub = cdp as CdpStubHandle;

    // Writer 1 — the preview poll (shim parity): ensure + capture.
    await expect(service.captureFrame({ taskId: 'tsk_t5' })).resolves.toEqual({
      data: FAKE_JPEG_B64,
      width: 800,
      height: 600,
    });

    // Writer 2 — the agent child, post-fix: ACCOMPLISH_TASK_ID is threaded
    // via the generated mcp environment, so its getFullPageName() composes
    // the SAME key the preview just ensured, and ensurePage DEDUPES it.
    await service.openPreviewPage({ name: 'tsk_t5-main' });

    // One registry entry, one identity, zero second tabs.
    expect(registry.ensuredNames).toEqual(['tsk_t5-main', 'tsk_t5-main']);
    expect(registry.pages.size).toBe(1);
    expect(registry.pages.get('tsk_t5-main')).toEqual({ targetId: 'T1', created: true });

    // Screenshot delivery follows the shared identity: every CDP attach
    // in both captures targeted the registry's own targetId — the capture
    // shows exactly the page the agent drives (incl. after navigation).
    await service.captureFrame({ taskId: 'tsk_t5' });
    expect(stub.attachTargetIds).toEqual(['T1', 'T1']);
    // The third ensure (the second poll's openPreviewPage) still deduped.
    expect(registry.ensuredNames).toEqual(['tsk_t5-main', 'tsk_t5-main', 'tsk_t5-main']);
    expect(registry.pages.size).toBe(1);
  });

  it('a DIFFERENT registry key still mints its own tab (stub fidelity for the pre-fix split)', async () => {
    // Negative control: the stub must model name-keyed minting faithfully.
    // Pre-fix, the child wrote `default-main` while the preview wrote
    // `tsk_t5-main` — the split below is the exact two-tab signature the
    // identity-threading fix removes.
    const { service, registry } = await startRegistryStack();

    await service.openPreviewPage({ name: 'tsk_t5-main' });
    await service.openPreviewPage({ name: 'default-main' });

    expect(registry.pages.size).toBe(2);
    expect(registry.pages.get('tsk_t5-main')?.targetId).toBe('T1');
    expect(registry.pages.get('default-main')?.targetId).toBe('T2');
  });

  it('a legit secondary page stays isolated from the main capture (multi-page tasks)', async () => {
    const { service, registry } = await startRegistryStack();
    const stub = cdp as CdpStubHandle;

    await service.captureFrame({ taskId: 'tsk_t5' });
    // The agent legitimately opens a second page mid-task — untouched.
    await service.openPreviewPage({ name: 'tsk_t5-docs' });
    const second = await service.captureFrame({ taskId: 'tsk_t5' });

    expect(second).toEqual({ data: FAKE_JPEG_B64, width: 800, height: 600 });
    // Both main captures attached ONLY ever the main page's targetId.
    expect(stub.attachTargetIds).toEqual(['T1', 'T1']);
    expect(registry.pages.size).toBe(2);
    expect(registry.pages.get('tsk_t5-docs')).toEqual({ targetId: 'T2', created: true });
  });
});

describe('preview-seam identity diagnostics (M6-A T5 §5 — failed Firefox acceptance)', () => {
  /**
   * The production failure signature: the daemon ran pre-T5 code (rebuilt dist
   * never loaded), the MCP child fell back to `default-main`, and the sidecar
   * registry held a `default-*` page BESIDE the captured `<taskId>-main` —
   * the captured tab stayed blank all task long while frames flowed (green
   * Live indicator, white screen). These tests pin the journald diagnostics:
   * the one-shot divergence WARN (read-only GET /pages, once per task) and
   * the per-tick DEBUG identity trail. Neither carries frame data.
   */
  let cdp: CdpStubHandle | null = null;
  let sidecar: http.Server | null = null;
  let registry: RegistryStubState;
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
    cdp = null;
    sidecar = null;
    vi.restoreAllMocks();
  });

  async function startSeamStack(extraRegistryNames: string[] = []): Promise<DevBrowserService> {
    registry = { ensuredNames: [], pages: new Map() };
    // Pre-seed foreign entries: the post-restart leftover shape (older task
    // pages are fine) vs the divergence fingerprint (a `default-*` entry).
    for (const name of extraRegistryNames) {
      registry.pages.set(name, {
        targetId: `T_PRE_${registry.pages.size}`,
        created: true,
      });
    }
    cdp = await listenCdpStub();
    cleanups.push(cdp.close);
    sidecar = await listenZero(
      sidecarStub(TOKEN, {
        wsEndpoint: `ws://127.0.0.1:${cdp.port}/devtools/browser/abc`,
        registry,
      }),
    );
    cleanups.push(() => closeServer(sidecar as http.Server));
    return new DevBrowserService({ devBrowserPort: portOf(sidecar as http.Server) });
  }

  it('logs a loud one-shot divergence WARN when the registry holds a default-* page beside the captured key', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const service = await startSeamStack(['default-main', 'task_older-main']);

      await service.captureFrame({ taskId: 'tsk_diag' });
      // The one-shot /pages check is fire-and-forget (best-effort, never
      // blocks the capture) — wait for its WARN before asserting.
      await vi.waitFor(() => {
        expect(
          warnSpy.mock.calls
            .map((call) => String(call[0]))
            .filter((m) => m.includes('identity divergence')),
        ).toHaveLength(1);
      });

      const divergenceWarns = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((m) => m.includes('identity divergence'));
      expect(divergenceWarns).toHaveLength(1);
      expect(divergenceWarns[0]).toContain('blank-page fingerprint');
      // Context identifies the seam without frame data.
      const warnCtx = warnSpy.mock.calls.find((call) =>
        String(call[0]).includes('identity divergence'),
      )?.[1] as Record<string, unknown>;
      expect(warnCtx.capturedFullPageName).toBe('tsk_diag-main');
      expect(warnCtx.divergentRegistryPages).toEqual(['default-main']);
      expect(JSON.stringify(warnCtx)).not.toContain('http');
      // Older-task leftovers are context, not a divergence: only default-* listed.
      expect(warnCtx.divergentRegistryPages).not.toContain('task_older-main');

      // One-shot per task: a second capture repeats neither the check nor the warn.
      await service.captureFrame({ taskId: 'tsk_diag' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((m) => m.includes('identity divergence')),
      ).toHaveLength(1);

      // Per-tick DEBUG identity trail carries delivery facts, no frame bytes.
      const trail = debugSpy.mock.calls.map((call) => String(call[0]));
      expect(trail.filter((m) => m.includes('captureFrame delivered'))).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it('stays silent when the registry has no default-* divergence (leftover task pages are normal)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const service = await startSeamStack(['task_older-main', 'tsk_diag-docs']);

      await service.captureFrame({ taskId: 'tsk_diag' });

      expect(
        warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((m) => m.includes('identity divergence')),
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('DevBrowserService.shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { stopped: false } when nothing answers with our token', async () => {
    const service = new DevBrowserService({ devBrowserPort: UNBOUND_PORT });
    await expect(service.shutdown()).resolves.toEqual({ stopped: false });
  });

  it('returns { stopped: false } for a token-mismatching (stale) sidecar', async () => {
    const server = await listenZero(sidecarStub('a-foreign-token', { wsEndpoint: 'ws://x' }));
    try {
      const service = new DevBrowserService({ devBrowserPort: portOf(server) });
      await expect(service.shutdown()).resolves.toEqual({ stopped: false });
    } finally {
      await closeServer(server);
    }
  });

  it('stops a live sidecar gracefully and reports { stopped: true } (real machinery)', async () => {
    // The "sidecar" is a detached CHILD process so agent-core's shutdown
    // (POST /shutdown, then killProcessOnPort fallback) can never SIGTERM the
    // vitest process that would be listening otherwise.
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "const http = require('http');",
          'const srv = http.createServer((req, res) => {',
          "  if (req.url === '/shutdown' && req.method === 'POST') {",
          "    res.writeHead(200, {'Content-Type':'application/json'});",
          '    res.end(JSON.stringify({ ok: true }));',
          '    setTimeout(() => process.exit(0), 50);',
          '    return;',
          '  }',
          "  res.writeHead(200, {'Content-Type':'application/json'});",
          "  res.end(JSON.stringify({ wsEndpoint: 'ws://127.0.0.1:9/devtools/browser/x', browserReady: false }));",
          '});',
          "srv.listen(0, '127.0.0.1', () => console.log(srv.address().port));",
        ].join('\n'),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const childPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('child sidecar did not report its port')),
        2500,
      );
      child.stdout?.on('data', (data: Buffer) => {
        const port = parseInt(data.toString().trim(), 10);
        if (Number.isFinite(port) && port > 0) {
          clearTimeout(timer);
          resolve(port);
        }
      });
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('child sidecar exited before reporting its port'));
      });
    }).finally(() => {
      child.stdout?.destroy();
    });
    try {
      const service = new DevBrowserService({ devBrowserPort: childPort });
      await expect(service.shutdown()).resolves.toEqual({ stopped: true });
      // The child exits itself after answering /shutdown (graceful path) — a
      // follow-up probe finds nothing, so the desktop's forced-port-kill
      // fallback would be a harmless no-op here.
      await expect(service.shutdown()).resolves.toEqual({ stopped: false });
    } finally {
      if (child.exitCode === null && !child.killed) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });
});
