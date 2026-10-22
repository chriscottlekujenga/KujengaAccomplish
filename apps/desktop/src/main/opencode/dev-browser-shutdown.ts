import {
  shutdownDevBrowserServer,
  DEV_BROWSER_PORT,
  DEV_BROWSER_CDP_PORT,
} from '@accomplish_ai/agent-core/desktop-main';
import { getLogCollector } from '../logging';
import { getDaemonClient } from '../daemon-bootstrap';

function logOC(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) {
  try {
    const l = getLogCollector();
    if (l?.log) {
      l.log(level, 'opencode', msg, data);
    }
  } catch (_e) {
    /* best-effort logging */
  }
}

/**
 * Sends a shutdown request to the local dev-browser MCP server.
 *
 * Phase 4b of the OpenCode SDK cutover port: extracted from the deleted
 * `electron-options.ts`. The dev-browser MCP server itself is now spawned
 * by the daemon when a task that uses it starts; this shutdown helper is
 * called from `app-shutdown.ts` so quitting the desktop also releases the
 * port the MCP server holds.
 */
export async function stopDevBrowserServer(): Promise<void> {
  logOC('INFO', '[Browser] Sending shutdown request to dev-browser server...');
  await shutdownDevBrowserServer({
    devBrowserPort: DEV_BROWSER_PORT,
    devBrowserCdpPort: DEV_BROWSER_CDP_PORT,
  });
}

/**
 * Clean quit first (Phase 3 M2 T4, checkpoint §18.3.6): ask the daemon to
 * stop its own dev-browser sidecar. The desktop's direct HTTP handshake
 * (`stopDevBrowserServer`) always degrades to the forced port-kill because
 * this process's per-pid dev-browser token never matches the daemon-owned
 * sidecar's token (401 → orphan Chrome); the daemon holds the matching
 * token, so `devBrowser.shutdown` performs the real graceful teardown.
 *
 * Best-effort: resolves `null` when the daemon is not reachable (bootstrap
 * never ran / socket already closed / RPC timeout) — the forced
 * `stopDevBrowserServer` fallback still runs either way.
 */
export async function stopDevBrowserServerViaDaemon(): Promise<boolean | null> {
  logOC('INFO', '[Browser] Sending dev-browser shutdown request via daemon RPC...');
  try {
    const result = (await getDaemonClient().call('devBrowser.shutdown', undefined, {
      timeoutMs: 6000,
    })) as { stopped?: boolean } | null;
    return typeof result?.stopped === 'boolean' ? result.stopped : null;
  } catch (err) {
    logOC('INFO', '[Browser] Daemon dev-browser shutdown unavailable (falling back)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
