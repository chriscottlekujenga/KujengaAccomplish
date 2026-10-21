/**
 * Early gateway bootstrap for the Firefox shell.
 *
 * Why this runs FIRST in the module graph (via gateway-bootstrap-init):
 *
 *   1. The session token travels in the URL fragment — but this app uses
 *      HashRouter, which interprets `#token=...` as a route path and
 *      rewrites it to `#/` during the first render pass. Capturing (and
 *      stripping) the fragment here happens before the router module is
 *      even evaluated, so the token can never be lost to routing.
 *   2. Stores register window.accomplish subscriptions at MODULE SCOPE
 *      (taskStore.ts `registerTaskSubscriptions`, daemonStore.ts
 *      `registerDaemonSubscriptions`). Without a window.accomplish they
 *      silently no-op — the UI would never receive task or daemon events.
 *      Installing the HTTP shim onto window.accomplish before any store
 *      module evaluates keeps those code paths byte-identical to Electron.
 *   3. Installs global error reporting that forwards browser errors to
 *      the host log (/client-log), so startup failures are diagnosable
 *      without opening devtools.
 *
 * When the Electron preload bridge is present (window.accomplish), this
 * module does nothing — the desktop shell is unchanged.
 */

import type { AccomplishAPI } from './accomplish';
import {
  createHttpAccomplishApi,
  isHttpGatewayAvailable,
  readGatewayToken,
} from './accomplish-http';

const CLIENT_LOG_ENDPOINT = '/client-log';

/** Session token for the current page (captured by bootstrap or read lazily). */
let bootToken: string | null = null;

export function getBootToken(): string | null {
  if (bootToken) {
    return bootToken;
  }
  return readGatewayToken();
}

/**
 * Best-effort client error report to the host log. Never throws — a broken
 * diagnostics channel must not shadow the original error.
 */
export function reportClientError(message: string, context?: unknown): void {
  try {
    const token = getBootToken();
    if (!token || !isLoopbackOrigin()) {
      return;
    }
    void fetch(`${window.location.origin}${CLIENT_LOG_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        level: 'error',
        message: message.slice(0, 4000),
        context:
          typeof context === 'string'
            ? context.slice(0, 2000)
            : JSON.stringify(context)?.slice(0, 2000),
      }),
    }).catch(() => {
      /* host unreachable — nothing to do */
    });
  } catch {
    /* never let diagnostics crash the app */
  }
}

function isLoopbackOrigin(): boolean {
  try {
    const hostname = window.location?.hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function installGlobalErrorReporting(): void {
  window.addEventListener('error', (event) => {
    reportClientError(event.message || 'window error', {
      source: 'window.onerror',
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(`Unhandled rejection: ${String(event.reason)}`, {
      source: 'unhandledrejection',
    });
  });
}

/**
 * Install the HTTP gateway API as window.accomplish when the page is served
 * by the host with a session token. Returns the installed API (or the
 * existing Electron bridge) for callers that need it.
 */
export function bootstrapGatewayApi(): AccomplishAPI | null {
  if (typeof window === 'undefined') {
    return null;
  }
  // The Electron preload bridge always wins — never shadow the desktop shell.
  if (window.accomplish) {
    return window.accomplish;
  }
  // Capture the token BEFORE anything else can rewrite the fragment.
  const token = readGatewayToken();
  if (!token || !isHttpGatewayAvailable()) {
    return null;
  }
  bootToken = token;
  window.accomplish = createHttpAccomplishApi({
    baseUrl: window.location.origin,
    token,
  });
  installGlobalErrorReporting();
  return window.accomplish;
}
