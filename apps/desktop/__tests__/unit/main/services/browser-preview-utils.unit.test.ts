/**
 * Unit tests for the browser preview resolution utils (Phase 3 M1).
 *
 * The dev-browser sidecar is daemon-owned and bearer-token secured, so the
 * desktop resolves targetIds/wsEndpoints/page lists over the daemon RPC
 * (`devBrowser.openPreviewPage` / `devBrowser.getPreviewInfo`) instead of
 * hitting :9224/:9225 directly. These tests mock the daemon client and
 * verify:
 *  - the new RPC calls (method name, payload, 10s deadline preserved),
 *  - error translation into the same thrown messages the preview service
 *    has always caught (graceful degradation to status:'error'),
 *  - autoStartScreencast's silent fallback when the daemon/sidecar is down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Electron mock (utils use BrowserWindow.getAllWindows for emit helpers) ──

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

// ── Daemon client mock ───────────────────────────────────────────────────────

const mockRpcCall = vi.fn();
vi.mock('@main/daemon-bootstrap', () => ({
  getDaemonClient: vi.fn(() => ({ call: mockRpcCall })),
}));

import {
  resolveTargetId,
  resolveBrowserWsEndpoint,
  autoStartScreencast,
  COMMAND_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
} from '@main/services/browser-preview-utils';

describe('browser preview utils over daemon RPC (Phase 3 M1)', () => {
  beforeEach(() => {
    mockRpcCall.mockReset();
  });

  describe('resolveTargetId', () => {
    it('calls devBrowser.openPreviewPage with the full page name and default viewport', async () => {
      mockRpcCall.mockResolvedValueOnce({ targetId: 'T-123' });
      const targetId = await resolveTargetId('task-1', 'main');
      expect(targetId).toBe('T-123');
      expect(mockRpcCall).toHaveBeenCalledWith(
        'devBrowser.openPreviewPage',
        { name: 'task-1-main', viewport: DEFAULT_VIEWPORT },
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      expect(mockRpcCall).toHaveBeenCalledTimes(1);
    });

    it('keeps the 10s deadline (COMMAND_TIMEOUT_MS) as the RPC timeout', async () => {
      mockRpcCall.mockResolvedValueOnce({ targetId: 'T-1' });
      await resolveTargetId('task-1', 'main');
      const opts = mockRpcCall.mock.calls[0][2] as { timeoutMs: number };
      expect(opts.timeoutMs).toBe(10_000);
    });

    it('throws the legacy "No targetId" error when the RPC result is null', async () => {
      mockRpcCall.mockResolvedValueOnce(null);
      await expect(resolveTargetId('task-1', 'main')).rejects.toThrow(
        'No targetId for page task-1-main',
      );
    });

    it('throws the legacy "No targetId" error when the result lacks targetId', async () => {
      mockRpcCall.mockResolvedValueOnce({ wsEndpoint: 'ws://x' });
      await expect(resolveTargetId('task-1', 'main')).rejects.toThrow(
        'No targetId for page task-1-main',
      );
    });

    it('propagates RPC failures (daemon down) for the preview service to catch', async () => {
      mockRpcCall.mockRejectedValueOnce(new Error('Daemon not connected'));
      await expect(resolveTargetId('task-1', 'main')).rejects.toThrow('Daemon not connected');
    });
  });

  describe('resolveBrowserWsEndpoint', () => {
    it('calls devBrowser.getPreviewInfo and returns the loopback CDP ws endpoint', async () => {
      mockRpcCall.mockResolvedValueOnce({
        wsEndpoint: 'ws://127.0.0.1:53123/devtools/browser/abc',
        pages: [],
      });
      const ws = await resolveBrowserWsEndpoint();
      expect(ws).toBe('ws://127.0.0.1:53123/devtools/browser/abc');
      expect(mockRpcCall).toHaveBeenCalledWith('devBrowser.getPreviewInfo', undefined, {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    });

    it('throws the legacy endpoint error when wsEndpoint is null (browser not launched)', async () => {
      mockRpcCall.mockResolvedValueOnce({ wsEndpoint: null, pages: null });
      await expect(resolveBrowserWsEndpoint()).rejects.toThrow(
        'CDP endpoint missing webSocketDebuggerUrl',
      );
    });

    it('propagates RPC failures (daemon down)', async () => {
      mockRpcCall.mockRejectedValueOnce(new Error('RPC timeout: devBrowser.getPreviewInfo'));
      await expect(resolveBrowserWsEndpoint()).rejects.toThrow(
        'RPC timeout: devBrowser.getPreviewInfo',
      );
    });
  });

  describe('autoStartScreencast', () => {
    it('starts the first page matching the task prefix', async () => {
      mockRpcCall.mockResolvedValueOnce({
        wsEndpoint: 'ws://x',
        pages: ['task-7-main', 'task-8-x'],
      });
      const start = vi.fn(async () => {});
      await autoStartScreencast('task-7', start);
      expect(start).toHaveBeenCalledWith('task-7', 'main');
      expect(mockRpcCall).toHaveBeenCalledWith('devBrowser.getPreviewInfo', undefined, {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    });

    it('does nothing when no page matches the task prefix', async () => {
      mockRpcCall.mockResolvedValueOnce({ wsEndpoint: 'ws://x', pages: ['task-8-x'] });
      const start = vi.fn(async () => {});
      await autoStartScreencast('task-7', start);
      expect(start).not.toHaveBeenCalled();
    });

    it('does nothing when the RPC reports null pages (unavailable)', async () => {
      mockRpcCall.mockResolvedValueOnce({ wsEndpoint: null, pages: null });
      const start = vi.fn(async () => {});
      await autoStartScreencast('task-7', start);
      expect(start).not.toHaveBeenCalled();
    });

    it('silently falls back when the RPC call rejects (daemon/sidecar down)', async () => {
      mockRpcCall.mockRejectedValueOnce(new Error('Daemon not connected'));
      const start = vi.fn(async () => {});
      await expect(autoStartScreencast('task-7', start)).resolves.toBeUndefined();
      expect(start).not.toHaveBeenCalled();
    });

    it('silently falls back when startBrowserPreviewStream itself fails', async () => {
      mockRpcCall.mockResolvedValueOnce({ wsEndpoint: 'ws://x', pages: ['task-7-main'] });
      const start = vi.fn(async () => {
        throw new Error('CDP connect failed');
      });
      await expect(autoStartScreencast('task-7', start)).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledWith('task-7', 'main');
    });
  });
});
