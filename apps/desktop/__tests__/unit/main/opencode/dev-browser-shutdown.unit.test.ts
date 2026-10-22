/**
 * Unit tests for the desktop's daemon-mediated dev-browser shutdown
 * (Phase 3 M2 T4, checkpoint §18.3.6).
 *
 * The desktop's own token never matches the daemon-owned sidecar's, so the
 * clean quit path must go through `devBrowser.shutdown` on the daemon RPC
 * and stay best-effort: any failure resolves `null` (never throws) and the
 * forced `stopDevBrowserServer` port-kill fallback in app-shutdown keeps
 * its unchanged, non-crashing semantics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpcCall, mockGetDaemonClient, mockForcedShutdown } = vi.hoisted(() => ({
  mockRpcCall: vi.fn(),
  mockGetDaemonClient: vi.fn(() => ({ call: mockRpcCall })),
  mockForcedShutdown: vi.fn(async () => {}),
}));

vi.mock('@main/daemon-bootstrap', () => ({
  getDaemonClient: mockGetDaemonClient,
}));

vi.mock('@accomplish_ai/agent-core/desktop-main', () => ({
  shutdownDevBrowserServer: mockForcedShutdown,
  DEV_BROWSER_PORT: 9224,
  DEV_BROWSER_CDP_PORT: 9225,
}));

import {
  stopDevBrowserServer,
  stopDevBrowserServerViaDaemon,
} from '@main/opencode/dev-browser-shutdown';

describe('stopDevBrowserServerViaDaemon (T4 clean-quit RPC)', () => {
  beforeEach(() => {
    mockRpcCall.mockReset();
    mockGetDaemonClient.mockClear();
    mockForcedShutdown.mockClear();
  });

  it('calls devBrowser.shutdown on the daemon client and reports stopped:true', async () => {
    mockRpcCall.mockResolvedValueOnce({ stopped: true });
    await expect(stopDevBrowserServerViaDaemon()).resolves.toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith('devBrowser.shutdown', undefined, {
      timeoutMs: 6000,
    });
  });

  it('reports stopped:false when the daemon finds no sidecar to stop', async () => {
    mockRpcCall.mockResolvedValueOnce({ stopped: false });
    await expect(stopDevBrowserServerViaDaemon()).resolves.toBe(false);
  });

  it('resolves null (never throws) when the daemon is unreachable', async () => {
    mockRpcCall.mockRejectedValueOnce(new Error('RPC timeout: devBrowser.shutdown (6000ms)'));
    await expect(stopDevBrowserServerViaDaemon()).resolves.toBeNull();
  });

  it('resolves null when not bootstrapped (getDaemonClient throws)', async () => {
    mockGetDaemonClient.mockImplementationOnce(() => {
      throw new Error('Daemon not bootstrapped. Call bootstrapDaemon() first.');
    });
    await expect(stopDevBrowserServerViaDaemon()).resolves.toBeNull();
  });

  it('resolves null when the response shape is unexpected (defensive)', async () => {
    mockRpcCall.mockResolvedValueOnce(null);
    await expect(stopDevBrowserServerViaDaemon()).resolves.toBeNull();
    mockRpcCall.mockResolvedValueOnce({ stopped: 'yes' });
    await expect(stopDevBrowserServerViaDaemon()).resolves.toBeNull();
  });

  it('the forced stopDevBrowserServer fallback is preserved byte-for-byte (M1 semantics)', async () => {
    // Same config as before T4: fixed ports, no token — the token-less 401 →
    // port-kill degrade path stays available as the fallback.
    await stopDevBrowserServer();
    expect(mockForcedShutdown).toHaveBeenCalledWith({
      devBrowserPort: 9224,
      devBrowserCdpPort: 9225,
    });
  });
});
