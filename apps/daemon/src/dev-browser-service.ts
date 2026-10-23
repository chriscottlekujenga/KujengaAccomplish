/**
 * DevBrowserService — authoritative preview-info source for `devBrowser.*`
 * RPCs (Phase 3 M1 — Electron desktop preview bridge fix).
 *
 * The dev-browser sidecar is daemon-owned: `ensureDevBrowserServer` (called
 * from createOnBeforeTaskStart) spawns it with the daemon's bearer token and
 * Chrome launches lazily on the first POST /pages. This service probes the
 * sidecar live with the SAME in-process token (`getDevBrowserToken()`), so
 * its answers are authoritative — the desktop never talks to :9224/:9225
 * directly and the token never leaves the daemon process. Only loopback
 * URLs (wsEndpoint) and page names cross the RPC boundary.
 *
 * Every method resolves to null-shaped results (never throws) when the
 * sidecar is unreachable or rejects the token, so callers degrade the way
 * the old Electron HTTP flow did.
 */
import {
  resolveDevBrowserRelayPort,
  fetchDevBrowserPageList,
  fetchDevBrowserServerInfo,
  getDevBrowserToken,
  logger,
  openDevBrowserPage,
  shutdownDevBrowserServer,
} from '@accomplish_ai/agent-core';
import { CdpClient } from './cdp-client.js';

export interface DevBrowserServiceConfig {
  /** Defaults to the resolved relay port (see resolveDevBrowserRelayPort); overridable in tests. */
  devBrowserPort?: number;
}

export interface DevBrowserPreviewInfo {
  /** Browser-level CDP WebSocket endpoint, or null when unavailable. */
  wsEndpoint: string | null;
  /** Tracked page names, or null when the sidecar is unavailable. */
  pages: string[] | null;
}

export interface DevBrowserPageResult {
  targetId: string;
}

/** `devBrowser.captureFrame` result — base64 JPEG + CSS content size. */
export interface DevBrowserFrameResult {
  data: string;
  width: number | null;
  height: number | null;
}

const DEFAULT_PAGE_NAME = 'main';
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
/** Matches the desktop screencast quality (browserPreview.ts SCREENCAST_QUALITY). */
const SCREENSHOT_QUALITY = 50;

export class DevBrowserService {
  private readonly config: DevBrowserServiceConfig;

  constructor(config: DevBrowserServiceConfig = {}) {
    this.config = config;
  }

  /** Same in-process token the sidecar was spawned with. */
  private get token(): string {
    return getDevBrowserToken();
  }

  private get port(): number {
    return this.config.devBrowserPort ?? resolveDevBrowserRelayPort();
  }

  /**
   * GET / + GET /pages merged into one read. `wsEndpoint` is null when the
   * browser has not launched yet ('' from the sidecar is treated the same).
   */
  async getPreviewInfo(): Promise<DevBrowserPreviewInfo> {
    const [info, pages] = await Promise.all([
      fetchDevBrowserServerInfo(this.port, this.token),
      fetchDevBrowserPageList(this.port, this.token),
    ]);
    return {
      wsEndpoint: info?.wsEndpoint ? info.wsEndpoint : null,
      pages: pages ?? null,
    };
  }

  /**
   * POST /pages — ensure (create or reuse) the named page. Returns null when
   * the sidecar is unavailable or the request fails; the desktop treats that
   * exactly like the old fetch-timeout/HTTP-error path.
   */
  async openPreviewPage(params: {
    name: string;
    viewport?: { width: number; height: number };
  }): Promise<DevBrowserPageResult | null> {
    const page = await openDevBrowserPage(
      this.port,
      {
        name: params.name,
        ...(params.viewport ? { viewport: params.viewport } : {}),
      },
      this.token,
    );
    if (!page?.targetId) {
      return null;
    }
    return { targetId: page.targetId };
  }

  /**
   * `devBrowser.captureFrame { taskId, pageName? }` — on-demand screenshot v1
   * (Phase 3 M2 T4). Resolves the task's page target and the ephemeral CDP
   * endpoint exactly like the desktop's resolveTargetId/resolveBrowserWsEndpoint
   * pair (openPreviewPage FIRST — it triggers the sidecar's lazy Chrome
   * launch; the wsEndpoint is empty until then, the ordering lesson from
   * browserPreview.ts), then speaks minimal CDP (Target.attachToTarget +
   * Page.getLayoutMetrics + Page.captureScreenshot) and returns
   * `{ data, width, height }` or null. Null — never a throw — when the
   * sidecar, browser, or page is unavailable so the shim's poll loop
   * tolerates sidecar relaunches; every response is token-free.
   */
  async captureFrame(params: {
    taskId: string;
    pageName?: string;
  }): Promise<DevBrowserFrameResult | null> {
    const normalizedPageName =
      typeof params.pageName === 'string' && params.pageName.trim()
        ? params.pageName.trim()
        : DEFAULT_PAGE_NAME;
    const fullPageName = `${params.taskId}-${normalizedPageName}`;
    try {
      const page = await this.openPreviewPage({
        name: fullPageName,
        viewport: DEFAULT_VIEWPORT,
      });
      const info = await fetchDevBrowserServerInfo(this.port, this.token);
      if (!page?.targetId || !info?.wsEndpoint) {
        return null;
      }
      return await this.captureCdpFrame(info.wsEndpoint, page.targetId);
    } catch (err) {
      logger.warn('[DevBrowser] captureFrame failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** CDP connect → attach → layout metrics → JPEG capture. */
  private async captureCdpFrame(
    wsEndpoint: string,
    targetId: string,
  ): Promise<DevBrowserFrameResult | null> {
    const cdp = new CdpClient();
    try {
      await cdp.connect(wsEndpoint);
      const attachResult = (await cdp.sendCommand('Target.attachToTarget', {
        targetId,
        flatten: true,
      })) as { sessionId?: string };
      const sessionId = attachResult.sessionId;
      if (!sessionId) {
        return null;
      }
      // content size first (modern); the deprecated device-pixel-size twin
      // is the fallback. Both are document CSS boxes — display-only in v1.
      const metrics = (await cdp.sendCommand('Page.getLayoutMetrics', undefined, sessionId)) as {
        cssContentSize?: { width?: number; height?: number };
        contentSize?: { width?: number; height?: number };
      } | null;
      const size = metrics?.cssContentSize ?? metrics?.contentSize ?? null;
      const shot = (await cdp.sendCommand(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: SCREENSHOT_QUALITY },
        sessionId,
      )) as { data?: string } | null;
      if (!shot?.data) {
        return null;
      }
      return {
        data: shot.data,
        width: typeof size?.width === 'number' ? size.width : null,
        height: typeof size?.height === 'number' ? size.height : null,
      };
    } finally {
      await cdp.disconnect().catch(() => {});
    }
  }

  /**
   * `devBrowser.shutdown {}` — gracefully stops the daemon-owned dev-browser
   * sidecar (Phase 3 M2 T4; the clean fix for the desktop quit-time fallback,
   * checkpoint §18.3.6). The desktop's own shutdown path cannot perform the
   * HTTP /shutdown handshake because its per-process token never matches the
   * sidecar's daemon token; the daemon holds BOTH, so it calls agent-core's
   * `shutdownDevBrowserServer` (graceful POST /shutdown, then the forced
   * port-kill fallback) with the in-process token. `stopped` is false when
   * nothing answers with our token (sidecar down / stale foreign sidecar) —
   * the caller keeps its own forced teardown for that legacy case.
   */
  async shutdown(): Promise<{ stopped: boolean }> {
    const info = await fetchDevBrowserServerInfo(this.port, this.token);
    if (!info) {
      return { stopped: false };
    }
    await shutdownDevBrowserServer({
      devBrowserPort: this.port,
      devBrowserToken: this.token,
    });
    return { stopped: true };
  }
}
