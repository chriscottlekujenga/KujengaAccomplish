import http from 'http';
import https from 'https';
import { createConsoleLogger } from '../../utils/logging.js';
import {
  generateServiceToken,
  verifyRawToken as verifyProxyHeaderToken,
} from '../../utils/service-token.js';
import {
  normalizeBaseUrl,
  transformRequestBody,
  isValidRequestPath,
  shouldTransformBody,
} from './azure-foundry-proxy-transform.js';

export { transformRequestBody } from './azure-foundry-proxy-transform.js';

const log = createConsoleLogger({ prefix: 'AzureFoundryProxy' });

/**
 * Dedicated auth header for the local proxy surface (Phase 3 M1 §5.3).
 *
 * Not `Authorization` — the upstream Azure credential travels there
 * (`options.apiKey` or the Entra-ID bearer header in the generated provider
 * config) and must be forwarded byte-identically. The proxy-token header is
 * stripped before the request goes upstream.
 */
export const PROXY_TOKEN_HEADER = 'x-accomplish-proxy-token';

const AZURE_FOUNDRY_PROXY_PORT = 9228;
const MAX_REQUEST_SIZE = 10 * 1024 * 1024;
/** Each `ensure` call may represent a different task — cap the active allowlist. */
const MAX_ACTIVE_PROXY_TOKENS = 64;

let server: http.Server | null = null;
let targetBaseUrl: string | null = null;
let serverStartupPromise: Promise<void> | null = null;
const activeProxyTokens = new Set<string>();

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
];

export interface AzureFoundryProxyInfo {
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
  return `http://127.0.0.1:${AZURE_FOUNDRY_PROXY_PORT}`;
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: Buffer,
  targetUrl: URL,
): void {
  const isHttps = targetUrl.protocol === 'https:';
  const body =
    rawBody.length > 0 && shouldTransformBody(req.headers['content-type'])
      ? transformRequestBody(rawBody)
      : rawBody;

  // Phase 3 M1 §5.3 — strip the local proxy auth header so upstream requests
  // are byte-identical to pre-token traffic.
  const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
  delete headers.host;
  delete headers[PROXY_TOKEN_HEADER];
  HOP_BY_HOP_HEADERS.forEach((header) => {
    delete headers[header];
  });

  // Always set content-length to the actual body length being forwarded.
  // When transfer-encoding was chunked, the hop-by-hop removal above deletes it,
  // so an explicit content-length is required even when the body was not transformed.
  headers['content-length'] = String(body.length);

  const proxy = (isHttps ? https : http).request(
    {
      method: req.method,
      headers,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
    },
    (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };
      // Remove hop-by-hop headers from the response to prevent logic errors in the proxy
      HOP_BY_HOP_HEADERS.forEach((header) => {
        delete responseHeaders[header];
      });

      res.writeHead(proxyRes.statusCode || 500, responseHeaders);
      proxyRes.pipe(res);
    },
  );

  proxy.on('error', (error) => {
    log.error('[Azure Foundry Proxy] Request error:', { error: error.message });
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Azure Foundry proxy request failed',
          details: error.message,
          hint: 'Check your Azure endpoint URL and network connectivity',
        }),
      );
    } else {
      res.end();
    }
  });

  if (body.length > 0) {
    proxy.write(body);
  }
  proxy.end();
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === '/health') {
    // Health stays unauthenticated: it reports loopback-internal state only
    // (status/target/port, no credentials) and exists for startup readiness
    // probes that never carry the task token.
    sendJson(res, 200, { status: 'ok', target: targetBaseUrl, port: AZURE_FOUNDRY_PROXY_PORT });
    return;
  }

  if (!targetBaseUrl) {
    sendJson(res, 503, {
      error: 'Azure Foundry proxy target not configured',
      hint: 'Configure Azure AI Foundry endpoint in Settings > Providers',
    });
    return;
  }

  // Phase 3 M1 §5.3 — unauthorized requests must not reach upstream.
  if (
    !verifyProxyHeaderToken(
      req.headers[PROXY_TOKEN_HEADER] as string | undefined,
      activeProxyTokens,
    )
  ) {
    sendJson(res, 401, { error: 'Unauthorized: missing or invalid x-accomplish-proxy-token' });
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');

  if (!isValidRequestPath(url.pathname)) {
    log.warn(`[Azure Foundry Proxy] Rejected invalid path: ${url.pathname}`);
    sendJson(res, 403, { error: 'Invalid request path. Only Azure OpenAI API paths are allowed.' });
    return;
  }

  const targetUrl = new URL(`${targetBaseUrl}${url.pathname}${url.search}`);
  const chunks: Buffer[] = [];
  let totalSize = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    totalSize += chunk.length;
    if (totalSize > MAX_REQUEST_SIZE) {
      aborted = true;
      log.warn(`[Azure Foundry Proxy] Request exceeded size limit: ${totalSize} bytes`);
      sendJson(res, 413, { error: 'Request too large. Maximum size is 10MB.' });
      req.destroy();
      return;
    }
    chunks.push(Buffer.from(chunk));
  });

  req.on('end', () => {
    if (aborted) return;
    forwardRequest(req, res, Buffer.concat(chunks), targetUrl);
  });

  req.on('error', (error) => {
    log.error('[Azure Foundry Proxy] Incoming request error:', { error: error.message });
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request', details: error.message }));
    } else {
      res.end();
    }
  });
}

async function startProxyServer(): Promise<void> {
  const newServer = http.createServer(proxyRequest);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      newServer.close();
      reject(new Error('Azure Foundry proxy server startup timeout'));
    }, 5000);
    newServer.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `Port ${AZURE_FOUNDRY_PROXY_PORT} is already in use. Please close other applications using this port or restart the app.`,
            )
          : error,
      );
    });
    newServer.listen(AZURE_FOUNDRY_PROXY_PORT, '127.0.0.1', () => {
      clearTimeout(timeout);
      log.info(`[Azure Foundry Proxy] Listening on port ${AZURE_FOUNDRY_PROXY_PORT}`);
      server = newServer;
      resolve();
    });
  });
}

export async function ensureAzureFoundryProxy(baseURL: string): Promise<AzureFoundryProxyInfo> {
  targetBaseUrl = normalizeBaseUrl(baseURL);
  if (!server) {
    if (!serverStartupPromise) {
      serverStartupPromise = startProxyServer().finally(() => {
        serverStartupPromise = null;
      });
    }
    await serverStartupPromise;
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
    port: AZURE_FOUNDRY_PROXY_PORT,
    token,
  };
}

/** Loopback-bind verification for tests (Phase 3 M1 §5.3). */
export function getAzureFoundryProxyBindAddress(): { address: string | null; port: number } {
  const addr = server?.address();
  if (addr && typeof addr === 'object') {
    return { address: addr.address, port: addr.port };
  }
  return { address: null, port: AZURE_FOUNDRY_PROXY_PORT };
}

export async function stopAzureFoundryProxy(): Promise<void> {
  if (!server) {
    return;
  }
  activeProxyTokens.clear();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      log.warn('[Azure Foundry Proxy] Shutdown timeout, forcing close');
      server = null;
      targetBaseUrl = null;
      resolve();
    }, 3000);
    server!.close((err) => {
      clearTimeout(timeout);
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        log.error('[Azure Foundry Proxy] Error during shutdown:', {
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
      } else {
        log.info('[Azure Foundry Proxy] Server stopped');
        resolve();
      }
    });
    server = null;
    targetBaseUrl = null;
  });
}

export function isAzureFoundryProxyRunning(): boolean {
  return server !== null && server.listening;
}
