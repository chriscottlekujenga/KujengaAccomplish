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
  DEV_BROWSER_PORT,
  fetchDevBrowserPageList,
  fetchDevBrowserServerInfo,
  getDevBrowserToken,
  openDevBrowserPage,
} from '@accomplish_ai/agent-core';

export interface DevBrowserServiceConfig {
  /** Defaults to DEV_BROWSER_PORT; overridable in tests. */
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
    return this.config.devBrowserPort ?? DEV_BROWSER_PORT;
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
}
