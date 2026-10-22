/**
 * Unit tests for the `devBrowser.*` RPC route registration (Phase 3 M1).
 *
 * Verifies the two preview-bridge methods are registered on the daemon RPC
 * server with the documented payload contracts and that the handlers
 * delegate to DevBrowserService. Trust-boundary guard: the host gateway
 * policy (apps/host/src/policy.ts) must stay default-deny for `devBrowser.*`
 * — the file is asserted as text here so an accidental allowlist edit
 * regresses this suite.
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

describe('devBrowser.* daemon RPC routes (Phase 3 M1 preview bridge)', () => {
  let registered: Map<string, RpcHandler>;
  let devBrowserService: {
    getPreviewInfo: ReturnType<typeof vi.fn>;
    openPreviewPage: ReturnType<typeof vi.fn>;
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

  it('sanitizes daemon-side errors before they cross the socket', async () => {
    const handler = registered.get('devBrowser.getPreviewInfo');
    devBrowserService.getPreviewInfo.mockRejectedValueOnce(new Error('secret: /home/chris/data'));
    await expect(handler?.(undefined)).rejects.toThrow('~/...');
  });
});

describe('trust boundary — devBrowser methods must stay off the browser allowlist', () => {
  it('apps/host/src/policy.ts contains no devBrowser methods', () => {
    const policyPath = path.resolve(__dirname, '../../../host/src/policy.ts');
    const policy = readFileSync(policyPath, 'utf8');
    expect(policy).not.toMatch(/devBrowser\./);
  });
});
