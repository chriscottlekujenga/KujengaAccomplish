/**
 * Browser Preview utility functions — IPC helpers and sidecar resolution helpers.
 * Extracted from browserPreview.ts for ENG-695.
 *
 * Phase 3 M1 — the dev-browser sidecar is daemon-owned and bearer-token
 * secured. This module no longer talks to :9224/:9225 directly; it resolves
 * preview state over the daemon RPC (`devBrowser.getPreviewInfo` /
 * `devBrowser.openPreviewPage`) so the sidecar token never crosses IPC.
 * Only loopback URLs and page names cross the daemon socket.
 */

import { BrowserWindow } from 'electron';
import { getDaemonClient } from '../daemon-bootstrap';

export const COMMAND_TIMEOUT_MS = 10_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export type PreviewStatus = 'starting' | 'streaming' | 'loading' | 'ready' | 'stopped' | 'error';

export function sendToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function emitStatusUpdate(
  taskId: string,
  pageName: string,
  status: PreviewStatus,
  message?: string,
): void {
  sendToRenderer('browser:status', { taskId, pageName, status, message, timestamp: Date.now() });
}

export function emitFrameCapture(
  taskId: string,
  pageName: string,
  data: string,
  width?: number,
  height?: number,
): void {
  sendToRenderer('browser:frame', {
    taskId,
    pageName,
    frame: data,
    width,
    height,
    timestamp: Date.now(),
  });
}

export function emitNavigationEvent(taskId: string, pageName: string, url: string): void {
  sendToRenderer('browser:navigate', { taskId, pageName, url, timestamp: Date.now() });
}

/** Shape of the daemon's `devBrowser.getPreviewInfo` result (nulls = unavailable). */
export interface DevBrowserPreviewInfo {
  wsEndpoint: string | null;
  pages: string[] | null;
}

/**
 * Ensure (create or reuse) the page for this task and return its CDP targetId.
 *
 * Mirrors the old POST http://127.0.0.1:9224/pages contract: same 10s deadline
 * (now the RPC client timeout) and same thrown errors, which callers catch to
 * degrade preview to status:'error' without crashing. Also triggers the
 * sidecar's lazy Chrome launch when the browser has not started yet.
 */
export async function resolveTargetId(taskId: string, pageName: string): Promise<string> {
  const fullPageName = `${taskId}-${pageName}`;
  const result = await getDaemonClient().call(
    'devBrowser.openPreviewPage',
    { name: fullPageName, viewport: DEFAULT_VIEWPORT },
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  if (!result?.targetId) {
    throw new Error(`No targetId for page ${fullPageName}`);
  }
  return result.targetId;
}

/**
 * Resolve the browser-level CDP WebSocket endpoint.
 *
 * The daemon derives it authoritatively from the sidecar's GET / (the CDP
 * port is ephemeral since Phase 3 M1 — DevToolsActivePort discovery), so the
 * fixed :9225 /json/version fetch is gone. `wsEndpoint` is null while Chrome
 * has not launched; callers treat that like the old connection-refused error.
 */
export async function resolveBrowserWsEndpoint(): Promise<string> {
  const info: DevBrowserPreviewInfo = await getDaemonClient().call(
    'devBrowser.getPreviewInfo',
    undefined,
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  if (!info.wsEndpoint) {
    throw new Error('CDP endpoint missing webSocketDebuggerUrl');
  }
  return info.wsEndpoint;
}
/**
 * Auto-start a preview when the dev-browser server is already running with an active session.
 * Called opportunistically from the task lifecycle.
 * Contributed by dhruvawani17 (PR #489) for ENG-695.
 *
 * @param taskId - The task ID to start the preview for
 * @param startBrowserPreviewStream - Callback to start the preview stream
 */
export async function autoStartScreencast(
  taskId: string,
  startBrowserPreviewStream: (taskId: string, pageName: string) => Promise<void>,
): Promise<void> {
  try {
    const data = await getDaemonClient()
      .call('devBrowser.getPreviewInfo', undefined, { timeoutMs: COMMAND_TIMEOUT_MS })
      .catch(() => null);

    if (!data?.pages) {
      return;
    }
    const taskPrefix = `${taskId}-`;
    const taskPages = data.pages.filter((p: string) => p.startsWith(taskPrefix));

    if (taskPages.length > 0) {
      const pageName = taskPages[0].substring(taskPrefix.length);
      await startBrowserPreviewStream(taskId, pageName);
    }
  } catch {
    // Daemon/sidecar not ready yet — will be triggered later via IPC
  }
}
