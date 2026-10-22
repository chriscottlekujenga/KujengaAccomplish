/**
 * Authenticated HTTP client for the dev-browser sidecar (:9224).
 *
 * Phase 3 M1 §5.3 — the sidecar requires a bearer token on every request.
 * These helpers let the daemon answer `devBrowser.*` preview RPCs
 * authoritatively while the token stays inside the daemon process: only
 * loopback URLs (wsEndpoint) and page names ever cross the RPC boundary —
 * never the token and never via the gateway.
 *
 * Every function resolves to `null` on failure (sidecar down, 401 token
 * mismatch, timeout) so callers degrade gracefully instead of throwing.
 */

import { getDevBrowserToken } from './dev-browser-token.js';

interface BearerFetchInit extends RequestInit {
  devBrowserToken?: string;
}

function authHeaders(devBrowserToken?: string): Record<string, string> {
  return { Authorization: `Bearer ${devBrowserToken ?? getDevBrowserToken()}` };
}

async function bearerFetch(url: string, init: BearerFetchInit): Promise<Response | null> {
  const { devBrowserToken, ...rest } = init;
  try {
    const res = await fetch(url, {
      ...rest,
      headers: {
        ...(rest.headers as Record<string, string> | undefined),
        ...authHeaders(devBrowserToken),
      },
      signal: rest.signal,
    });
    if (res.status === 401) {
      // Server is up but rejects our token: a stale sidecar from a previous
      // daemon lifetime (or a foreign process squatting the port). The
      // self-heal path in start-server.mjs kills it when ensureDevBrowserServer
      // next runs (task bootstrap); until then report as unavailable.
      return null;
    }
    if (!res.ok) {
      return null;
    }
    return res;
  } catch {
    return null;
  }
}

async function fetchJsonOrNull<T>(url: string, init: BearerFetchInit): Promise<T | null> {
  const res = await bearerFetch(url, init);
  if (!res) {
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface DevBrowserServerInfo {
  wsEndpoint: string;
  browserReady: boolean;
}

export interface DevBrowserPageRequest {
  name: string;
  viewport?: { width: number; height: number };
  initialUrl?: string;
  launchIntent?: 'background-normal' | 'browser-tool-open' | 'foreground';
}

export interface DevBrowserPageInfo {
  wsEndpoint: string;
  name: string;
  targetId: string;
  created: boolean;
}

/** Default per-request timeouts: reads are cheap; page-open may launch Chrome. */
const INFO_TIMEOUT_MS = 3000;
const OPEN_PAGE_TIMEOUT_MS = 15000;

/**
 * GET / — server info including the browser-level CDP WebSocket endpoint.
 * `wsEndpoint` is '' while Chrome has not been launched yet (lazy launch on
 * the first POST /pages).
 */
export async function fetchDevBrowserServerInfo(
  port: number,
  devBrowserToken?: string,
): Promise<DevBrowserServerInfo | null> {
  return fetchJsonOrNull<DevBrowserServerInfo>(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    devBrowserToken,
  });
}

/** GET /pages — names of pages the sidecar tracks (e.g. `taskId-pageName`). */
export async function fetchDevBrowserPageList(
  port: number,
  devBrowserToken?: string,
): Promise<string[] | null> {
  const body = await fetchJsonOrNull<{ pages: string[] }>(`http://127.0.0.1:${port}/pages`, {
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    devBrowserToken,
  });
  return body?.pages ?? null;
}

/**
 * POST /pages — ensure (create or reuse) a named page. This is the call that
 * triggers the lazy Chrome launch, so the default timeout is generous.
 */
export async function openDevBrowserPage(
  port: number,
  page: DevBrowserPageRequest,
  devBrowserToken?: string,
): Promise<DevBrowserPageInfo | null> {
  return fetchJsonOrNull<DevBrowserPageInfo>(`http://127.0.0.1:${port}/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(page),
    signal: AbortSignal.timeout(OPEN_PAGE_TIMEOUT_MS),
    devBrowserToken,
  });
}
