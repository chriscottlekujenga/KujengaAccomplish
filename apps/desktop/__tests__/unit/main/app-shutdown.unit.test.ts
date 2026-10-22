/**
 * Unit tests for the app-shutdown dev-browser teardown order
 * (Phase 3 M2 T4, checkpoint §18.3.6).
 *
 * Verifies the graceful RPC-first attempt (`devBrowser.shutdown` via the
 * daemon client) runs BEFORE the unchanged forced `stopDevBrowserServer`
 * fallback, and that a daemon-unreachable shutdown still completes without
 * crashing (M1's non-crashing semantics preserved byte-for-byte).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRpcCall,
  mockGetDaemonClient,
  mockShutdownDaemon,
  mockStopDevBrowserServer,
  mockStopViaDaemon,
  mockAppQuit,
  callOrder,
} = vi.hoisted(() => {
  const callOrder: string[] = [];
  return {
    callOrder,
    mockAppQuit: vi.fn(),
    mockRpcCall: vi.fn(),
    mockGetDaemonClient: vi.fn(() => ({
      call: mockRpcCall.mockImplementation(async (method: string) => {
        callOrder.push(`daemon:${method}`);
        return { stopped: true };
      }),
    })),
    mockShutdownDaemon: vi.fn(() => {
      callOrder.push('shutdownDaemon');
    }),
    mockStopDevBrowserServer: vi.fn(async () => {
      callOrder.push('desktop:stopDevBrowserServer');
    }),
    mockStopViaDaemon: vi.fn(async () => {
      callOrder.push('desktop:stopDevBrowserServerViaDaemon');
      return true;
    }),
  };
});

vi.mock('electron', () => ({
  app: { quit: mockAppQuit, on: vi.fn(), getPath: vi.fn(() => '/tmp') },
}));

vi.mock('@main/daemon-bootstrap', () => ({
  getDaemonClient: mockGetDaemonClient,
  shutdownDaemon: mockShutdownDaemon,
}));

vi.mock('@main/opencode', () => ({
  cleanupVertexServiceAccountKey: vi.fn(),
  stopDevBrowserServer: mockStopDevBrowserServer,
  stopDevBrowserServerViaDaemon: mockStopViaDaemon,
}));

vi.mock('@main/services/browserPreview', () => ({
  stopAllBrowserPreviewStreams: vi.fn(async () => {
    callOrder.push('desktop:stopAllBrowserPreviewStreams');
  }),
}));

vi.mock('@main/opencode/slack-auth', () => ({
  slackMcpOAuthFlow: { dispose: vi.fn() },
}));

vi.mock('@main/store/workspaceManager', () => ({
  close: vi.fn(),
}));

vi.mock('@main/providers/huggingface-local', () => ({
  stopHuggingFaceServer: vi.fn(async () => {}),
}));

vi.mock('@main/tray', () => ({
  destroyTray: vi.fn(),
}));

vi.mock('@main/analytics/analytics-service', () => ({
  flushAnalytics: vi.fn(),
}));

vi.mock('@main/analytics/mixpanel-service', () => ({
  flushMixpanel: vi.fn(),
}));

vi.mock('@main/analytics/events', () => ({
  trackAppClose: vi.fn(async () => {}),
}));

import { shutdownApp } from '@main/app-shutdown';

describe('shutdownApp dev-browser teardown order (T4 clean-quit fix)', () => {
  beforeEach(() => {
    callOrder.length = 0;
    mockRpcCall.mockClear();
    mockStopDevBrowserServer.mockClear();
    mockStopViaDaemon.mockClear();
    mockShutdownDaemon.mockClear();
  });

  it('attempts the daemon devBrowser.shutdown RPC BEFORE the forced desktop fallback', async () => {
    await shutdownApp(null);
    expect(mockStopViaDaemon).toHaveBeenCalledTimes(1);
    expect(mockStopDevBrowserServer).toHaveBeenCalledTimes(1);
    const viaDaemonIdx = callOrder.indexOf('desktop:stopDevBrowserServerViaDaemon');
    const forcedIdx = callOrder.indexOf('desktop:stopDevBrowserServer');
    expect(viaDaemonIdx).toBeGreaterThanOrEqual(0);
    expect(forcedIdx).toBeGreaterThan(viaDaemonIdx);
    // The helper → daemon-client call chain itself is pinned by
    // opencode/dev-browser-shutdown.unit.test.ts; this pins the ORDER only.
  });

  it('still runs the forced fallback when the daemon RPC reports nothing to stop', async () => {
    mockStopViaDaemon.mockImplementationOnce(async () => {
      callOrder.push('desktop:stopDevBrowserServerViaDaemon');
      return false;
    });
    await shutdownApp(null);
    // Fallback is unconditional by design (harmless no-op when graceful won).
    expect(mockStopDevBrowserServer).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf('desktop:stopDevBrowserServer')).toBeGreaterThan(
      callOrder.indexOf('desktop:stopDevBrowserServerViaDaemon'),
    );
  });

  it('completes the full shutdown without crashing when the daemon is unreachable', async () => {
    mockStopViaDaemon.mockImplementationOnce(async () => {
      callOrder.push('desktop:stopDevBrowserServerViaDaemon');
      // getDaemonClient() would throw pre-bootstrap; the helper resolves null.
      return null;
    });
    await expect(shutdownApp(null)).resolves.toBeUndefined();
    expect(mockStopDevBrowserServer).toHaveBeenCalledTimes(1);
    // The rest of the teardown still ran (non-crash preservation): socket
    // closed, quit requested.
    expect(callOrder).toContain('shutdownDaemon');
    expect(mockAppQuit).toHaveBeenCalled();
  });

  it('shutdown completes when the RPC attempt itself is rejected (race timeout)', async () => {
    mockStopViaDaemon.mockImplementationOnce(async () => {
      callOrder.push('desktop:stopDevBrowserServerViaDaemon');
      throw new Error('Daemon dev-browser shutdown (graceful) timed out after 6000ms');
    });
    await expect(shutdownApp(null)).resolves.toBeUndefined();
    expect(mockStopDevBrowserServer).toHaveBeenCalledTimes(1);
    expect(callOrder).toContain('shutdownDaemon');
  });
});
