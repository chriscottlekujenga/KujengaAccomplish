/**
 * Unit tests for the `devBrowser.*` RPC route registration.
 *
 * Phase 3 M1: preview-bridge pair (`getPreviewInfo`/`openPreviewPage`).
 * Phase 3 M2 T4: adds `captureFrame` (on-demand screenshot v1) and
 * `shutdown` (graceful sidecar teardown for the desktop quit path). Verifies
 * all four are registered with the documented payload contracts and that
 * handlers delegate to DevBrowserService. Trust-boundary guard: the host
 * gateway policy (apps/host/src/policy.ts) must allowlist exactly the three
 * browser-facing methods (`openPreviewPage`, `captureFrame`, `shutdown`) and
 * keep `getPreviewInfo` — which returns the raw CDP endpoint — internal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerRpcMethods, type RouteServices } from '../../src/daemon-routes.js';

type RpcHandler = (params: unknown, clientId?: string) => Promise<unknown>;

function buildServices() {
  const registered = new Map<string, RpcHandler>();
  const devBrowserService = {
    getPreviewInfo: vi.fn(async () => ({
      wsEndpoint: 'ws://127.0.0.1:53123/devtools/browser/abc',
      pages: ['task-1-main'],
    })),
    openPreviewPage: vi.fn(async () => ({ targetId: 'T1' })),
    captureFrame: vi.fn(async () => ({ data: 'ZmFrZQ==', width: 800, height: 600 })),
    shutdown: vi.fn(async () => ({ stopped: true })),
  };
  const services = {
    rpc: {
      registerMethod: vi.fn((method: string, handler: RpcHandler) => {
        registered.set(method, handler);
      }),
      notify: vi.fn(),
      setClientType: vi.fn(),
      setUiPresence: vi.fn(),
    },
    taskService: {},
    healthService: {},
    storageService: { getStorage: vi.fn(() => ({})) },
    schedulerService: {},
    accomplishRuntime: { onUsageUpdate: vi.fn() },
    whatsappService: {},
    openAiOauthManager: {},
    secretsService: {},
    settingsService: { on: vi.fn() },
    workspaceService: { on: vi.fn() },
    connectorService: {},
    legacyImportService: {},
    googleAccountService: { on: vi.fn() },
    skillsService: { on: vi.fn() },
    devBrowserService,
  } as unknown as RouteServices;
  return { services, registered, devBrowserService };
}

describe('devBrowser.* daemon RPC routes (Phase 3 M1 preview bridge; T4 capture/shutdown)', () => {
  let registered: Map<string, RpcHandler>;
  let devBrowserService: {
    getPreviewInfo: ReturnType<typeof vi.fn>;
    openPreviewPage: ReturnType<typeof vi.fn>;
    captureFrame: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const built = buildServices();
    registered = built.registered;
    devBrowserService = built.devBrowserService;
    registerRpcMethods(built.services);
  });

  it("registers 'devBrowser.getPreviewInfo'", () => {
    expect(registered.has('devBrowser.getPreviewInfo')).toBe(true);
  });

  it("registers 'devBrowser.openPreviewPage'", () => {
    expect(registered.has('devBrowser.openPreviewPage')).toBe(true);
  });

  it("registers 'devBrowser.captureFrame'", () => {
    expect(registered.has('devBrowser.captureFrame')).toBe(true);
  });

  it("registers 'devBrowser.shutdown'", () => {
    expect(registered.has('devBrowser.shutdown')).toBe(true);
  });

  it('getPreviewInfo delegates to DevBrowserService with no params', async () => {
    const handler = registered.get('devBrowser.getPreviewInfo');
    expect(handler).toBeDefined();
    await expect(handler?.(undefined, 'client-1')).resolves.toEqual({
      wsEndpoint: 'ws://127.0.0.1:53123/devtools/browser/abc',
      pages: ['task-1-main'],
    });
    expect(devBrowserService.getPreviewInfo).toHaveBeenCalledTimes(1);
  });

  it('openPreviewPage validates and forwards the page request', async () => {
    const handler = registered.get('devBrowser.openPreviewPage');
    expect(handler).toBeDefined();
    await expect(
      handler?.({ name: 'task-7-main', viewport: { width: 1280, height: 720 } }),
    ).resolves.toEqual({ targetId: 'T1' });
    expect(devBrowserService.openPreviewPage).toHaveBeenCalledWith({
      name: 'task-7-main',
      viewport: { width: 1280, height: 720 },
    });
  });

  it('openPreviewPage rejects empty page names (zod validation)', async () => {
    const handler = registered.get('devBrowser.openPreviewPage');
    await expect(handler?.({ name: '' })).rejects.toThrow(/Invalid payload/);
    expect(devBrowserService.openPreviewPage).not.toHaveBeenCalled();
  });

  it('openPreviewPage rejects non-object params', async () => {
    const handler = registered.get('devBrowser.openPreviewPage');
    await expect(handler?.(null)).rejects.toThrow(/Invalid payload/);
  });

  it('captureFrame validates taskId and forwards pageName optionality', async () => {
    const handler = registered.get('devBrowser.captureFrame');
    await expect(handler?.({ taskId: 't1', pageName: 'search' })).resolves.toEqual({
      data: 'ZmFrZQ==',
      width: 800,
      height: 600,
    });
    expect(devBrowserService.captureFrame).toHaveBeenCalledWith({
      taskId: 't1',
      pageName: 'search',
    });
    await expect(handler?.({ taskId: 't1' })).resolves.not.toBeNull();
    expect(devBrowserService.captureFrame).toHaveBeenCalledWith({ taskId: 't1' });
  });

  it('captureFrame rejects missing/empty taskId (zod validation)', async () => {
    const handler = registered.get('devBrowser.captureFrame');
    await expect(handler?.(undefined)).rejects.toThrow(/Invalid payload/);
    await expect(handler?.({ taskId: '' })).rejects.toThrow(/Invalid payload/);
    await expect(handler?.({ taskId: 't1', pageName: '' })).rejects.toThrow(/Invalid payload/);
    expect(devBrowserService.captureFrame).not.toHaveBeenCalled();
  });

  it('shutdown delegates and returns the { stopped } verdict', async () => {
    const handler = registered.get('devBrowser.shutdown');
    await expect(handler?.(undefined)).resolves.toEqual({ stopped: true });
    expect(devBrowserService.shutdown).toHaveBeenCalledTimes(1);
  });

  it('sanitizes daemon-side errors before they cross the socket', async () => {
    const handler = registered.get('devBrowser.getPreviewInfo');
    devBrowserService.getPreviewInfo.mockRejectedValueOnce(new Error('secret: /home/chris/data'));
    await expect(handler?.(undefined)).rejects.toThrow('~/...');
  });
});

describe('trust boundary — devBrowser gateway allowlist surface (Phase 3 M2 T4)', () => {
  const policyPath = path.resolve(__dirname, '../../../host/src/policy.ts');
  const readPolicy = (): string => readFileSync(policyPath, 'utf8');

  it('allowlists exactly the three browser-facing devBrowser methods', () => {
    const policy = readPolicy();
    expect(policy).toMatch(/'devBrowser\.openPreviewPage',/);
    expect(policy).toMatch(/'devBrowser\.captureFrame',/);
    expect(policy).toMatch(/'devBrowser\.shutdown',/);
  });

  it('keeps `devBrowser.getPreviewInfo` internal (raw CDP endpoint never crosses the gateway)', () => {
    const policy = readPolicy();
    expect(policy).not.toMatch(/'devBrowser\.getPreviewInfo'/);
  });
});
