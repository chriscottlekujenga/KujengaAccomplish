/**
 * Unit tests for the browserPreview service start/stop flow (Phase 3 M1).
 *
 * Verifies the preview stream wires the daemon RPC resolutions into a CDP
 * session in the correct order — the page must be opened FIRST (it triggers
 * the sidecar's lazy Chrome launch) and only then can the ephemeral CDP
 * wsEndpoint be resolved — and that any failure degrades to a status:'error'
 * update with the CDP client disconnected (never crashes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockCdpConnect, mockCdpOnEvent, mockCdpSendCommand, mockCdpDisconnect } =
  vi.hoisted(() => ({
    mockSend: vi.fn(),
    mockCdpConnect: vi.fn(async () => {}),
    mockCdpOnEvent: vi.fn(() => vi.fn()),
    mockCdpSendCommand: vi.fn(async () => ({ sessionId: 'sess-1' })),
    mockCdpDisconnect: vi.fn(async () => {}),
  }));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      { isDestroyed: vi.fn(() => false), webContents: { send: mockSend } },
    ]),
  },
}));

// ── Daemon RPC mock — routes by method name ──────────────────────────────────

const mockRpcCall = vi.fn();
vi.mock('@main/daemon-bootstrap', () => ({
  getDaemonClient: vi.fn(() => ({ call: mockRpcCall })),
}));

vi.mock('@main/services/cdp-client', () => ({
  CdpClient: class {
    connect = mockCdpConnect;
    onEvent = mockCdpOnEvent;
    sendCommand = mockCdpSendCommand;
    disconnect = mockCdpDisconnect;
  },
}));

vi.mock('@main/logging', () => ({
  getLogCollector: vi.fn(() => ({
    log: vi.fn(),
    logBrowser: vi.fn(),
    addLog: vi.fn(),
    getLogs: vi.fn(() => []),
    exportLogs: vi.fn(() => Promise.resolve({ success: true, path: '/tmp/logs.txt' })),
  })),
}));

import { startBrowserPreviewStream, stopBrowserPreviewStream } from '@main/services/browserPreview';

const WS_ENDPOINT = 'ws://127.0.0.1:53123/devtools/browser/abc';

describe('browserPreview service over daemon RPC (Phase 3 M1)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockCdpConnect.mockReset().mockResolvedValue(undefined);
    mockCdpOnEvent.mockClear();
    mockCdpSendCommand.mockReset().mockResolvedValue({ sessionId: 'sess-1' });
    mockCdpDisconnect.mockReset().mockResolvedValue(undefined);
    mockRpcCall.mockReset();
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === 'devBrowser.openPreviewPage') {
        return { targetId: 'T-1' };
      }
      if (method === 'devBrowser.getPreviewInfo') {
        return { wsEndpoint: WS_ENDPOINT, pages: ['task-1-main'] };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
  });

  it('opens the page before resolving the ephemeral wsEndpoint, then attaches', async () => {
    await startBrowserPreviewStream('task-1', 'main');

    const openIdx = mockRpcCall.mock.calls.findIndex((c) => c[0] === 'devBrowser.openPreviewPage');
    const infoIdx = mockRpcCall.mock.calls.findIndex((c) => c[0] === 'devBrowser.getPreviewInfo');
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(infoIdx).toBeGreaterThan(openIdx);
    expect(mockRpcCall).toHaveBeenCalledWith(
      'devBrowser.openPreviewPage',
      { name: 'task-1-main', viewport: { width: 1280, height: 720 } },
      { timeoutMs: 10_000 },
    );

    expect(mockCdpConnect).toHaveBeenCalledWith(WS_ENDPOINT);
    expect(mockCdpSendCommand).toHaveBeenCalledWith('Target.attachToTarget', {
      targetId: 'T-1',
      flatten: true,
    });
    expect(mockCdpSendCommand).toHaveBeenCalledWith(
      'Page.startScreencast',
      expect.objectContaining({ format: 'jpeg', quality: 50, everyNthFrame: 3 }),
      'sess-1',
    );
  });

  it('emits streaming status on success', async () => {
    await startBrowserPreviewStream('task-1', 'main');
    const statuses = mockSend.mock.calls
      .filter((c) => c[0] === 'browser:status')
      .map((c) => (c[1] as { status: string }).status);
    expect(statuses).toContain('starting');
    expect(statuses).toContain('streaming');
    expect(statuses).not.toContain('error');
  });

  it('degrades to status error (never throws) when the page cannot be opened', async () => {
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === 'devBrowser.openPreviewPage') {
        return null;
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });

    await expect(startBrowserPreviewStream('task-1', 'main')).resolves.toBeUndefined();

    const errorUpdate = mockSend.mock.calls
      .filter((c) => c[0] === 'browser:status')
      .map((c) => c[1])
      .find((p) => (p as { status: string }).status === 'error');
    expect(errorUpdate).toEqual(
      expect.objectContaining({ status: 'error', message: 'No targetId for page task-1-main' }),
    );
    expect(mockCdpDisconnect).toHaveBeenCalled();
    expect(mockCdpConnect).not.toHaveBeenCalled();
  });

  it('degrades to status error (never throws) when the daemon is unreachable', async () => {
    mockRpcCall.mockImplementation(async () => {
      throw new Error('Daemon not connected');
    });

    await expect(startBrowserPreviewStream('task-1', 'main')).resolves.toBeUndefined();

    const errorUpdate = mockSend.mock.calls
      .filter((c) => c[0] === 'browser:status')
      .map((c) => c[1])
      .find((p) => (p as { status: string }).status === 'error');
    expect(errorUpdate).toEqual(
      expect.objectContaining({ status: 'error', message: 'Daemon not connected' }),
    );
    expect(mockCdpDisconnect).toHaveBeenCalled();
  });

  it('stopBrowserPreviewStream stops the screencast and emits stopped', async () => {
    await startBrowserPreviewStream('task-1', 'main');
    await stopBrowserPreviewStream('task-1');
    expect(mockCdpSendCommand).toHaveBeenCalledWith('Page.stopScreencast', {}, 'sess-1');
    expect(mockCdpDisconnect).toHaveBeenCalled();
    const statuses = mockSend.mock.calls
      .filter((c) => c[0] === 'browser:status')
      .map((c) => (c[1] as { status: string }).status);
    expect(statuses[statuses.length - 1]).toBe('stopped');
  });
});
