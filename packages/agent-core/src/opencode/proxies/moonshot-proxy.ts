import http from 'http';
import { createConsoleLogger } from '../../utils/logging.js';
import { generateServiceToken } from '../../utils/service-token.js';
import { normalizeBaseUrl } from './moonshot-validation.js';
import { MOONSHOT_PROXY_PORT } from './moonshot-transform.js';
import { createProxyRequestHandler } from './moonshot-request-handler.js';

export { transformMoonshotRequestBody } from './moonshot-transform.js';
export { PROXY_TOKEN_HEADER } from './azure-foundry-proxy.js';

const log = createConsoleLogger({ prefix: 'MoonshotProxy' });

/** Each `ensure` call may represent a different task — cap the active allowlist. */
const MAX_ACTIVE_PROXY_TOKENS = 64;

let server: http.Server | null = null;
let targetBaseUrl: string | null = null;
const activeProxyTokens = new Set<string>();

export interface MoonshotProxyInfo {
  baseURL: string;
  targetBaseURL: string;
  port: number;
  /**
   * Bearer token the proxy requires in the `x-accomplish-proxy-token` header.
   * The caller must thread it into the generated provider config
   * (`options.headers`) so only opencode serve traffic reaches upstream.
   */
  token: string;
}

function getProxyBaseUrl(): string {
  return `http://127.0.0.1:${MOONSHOT_PROXY_PORT}`;
}

export async function ensureMoonshotProxy(baseURL: string): Promise<MoonshotProxyInfo> {
  targetBaseUrl = normalizeBaseUrl(baseURL);

  if (!server) {
    const handler = createProxyRequestHandler(() => targetBaseUrl, activeProxyTokens);
    server = http.createServer(handler);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Moonshot proxy server startup timeout'));
      }, 5000);

      server!.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        server = null;
        if (error.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${MOONSHOT_PROXY_PORT} is already in use. ` +
                'Please close other applications using this port or restart the app.',
            ),
          );
        } else {
          reject(error);
        }
      });

      server!.listen(MOONSHOT_PROXY_PORT, '127.0.0.1', () => {
        clearTimeout(timeout);
        log.info(`[Moonshot Proxy] Listening on port ${MOONSHOT_PROXY_PORT}`);
        resolve();
      });
    });
  }

  // Phase 3 M1 §5.3 — generate a fresh token per task bootstrap (the caller
  // writes it into the generated provider config so opencode serve traffic
  // authenticates) and keep it in the active allowlist.
  const token = generateServiceToken();
  activeProxyTokens.add(token);
  while (activeProxyTokens.size > MAX_ACTIVE_PROXY_TOKENS) {
    const oldest = activeProxyTokens.values().next().value;
    if (oldest === undefined) {
      break;
    }
    activeProxyTokens.delete(oldest);
  }

  return {
    baseURL: getProxyBaseUrl(),
    targetBaseURL: targetBaseUrl,
    port: MOONSHOT_PROXY_PORT,
    token,
  };
}

/** Loopback-bind verification for tests (Phase 3 M1 §5.3). */
export function getMoonshotProxyBindAddress(): { address: string | null; port: number } {
  const addr = server?.address();
  if (addr && typeof addr === 'object') {
    return { address: addr.address, port: addr.port };
  }
  return { address: null, port: MOONSHOT_PROXY_PORT };
}

export async function stopMoonshotProxy(): Promise<void> {
  if (!server) {
    return;
  }
  activeProxyTokens.clear();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      log.warn('[Moonshot Proxy] Shutdown timeout, forcing close');
      server = null;
      targetBaseUrl = null;
      resolve();
    }, 3000);

    server!.close((err) => {
      clearTimeout(timeout);
      server = null;
      targetBaseUrl = null;
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        log.error(`[Moonshot Proxy] Error during shutdown: ${err}`);
        reject(err);
      } else {
        log.info('[Moonshot Proxy] Server stopped');
        resolve();
      }
    });
  });
}

export function isMoonshotProxyRunning(): boolean {
  return server !== null && server.listening;
}
