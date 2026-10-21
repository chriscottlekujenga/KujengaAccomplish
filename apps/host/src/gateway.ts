/**
 * Browser Gateway — loopback HTTP + WebSocket bridge to the daemon.
 *
 * Serves the web UI (static files), proxies authorized JSON-RPC calls to the
 * daemon, and streams daemon notifications to authenticated WebSocket
 * clients. Replaces the Electron `BrowserWindow` + preload bridge for the
 * Firefox migration (FIREFOX_MIGRATION_PLAN §6).
 *
 * Security model (§7), enforced on every request:
 *   1. Loopback-only bind (127.0.0.1).
 *   2. Host header validation — DNS-rebinding defense.
 *   3. Origin validation when the header is present.
 *   4. Bearer token (timing-safe) on every API endpoint — the token travels
 *      in the launch URL fragment and is never accepted from query strings.
 *   5. Explicit RPC method allowlist + secrets blocklist (policy.ts).
 *   6. Per-token rate limiting; strict CSP + nosniff on served responses.
 *
 * WebSocket clients authenticate with a first message
 * (`{ "type": "auth", "token": ... }`) because browsers cannot set
 * Authorization headers on WebSocket connections.
 */

import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  extractBearerToken,
  isAllowedHostHeader,
  isAllowedOrigin,
  timingSafeTokenEquals,
} from './auth.js';
import { HOST_VERSION, resolveAppPath } from './config.js';
import { getCliStatus } from './cli-status.js';
import { pickFiles, pickFolder } from './file-picker.js';
import { noopLogger, type HostLogger } from './logger.js';
import { checkMethodPolicy } from './policy.js';
import { scrubSecretFields } from './provider-settings-scrubber.js';
import { isDaemonServiceActive, isDaemonServiceEnabled } from './daemon-service.js';
import { TokenRateLimiter, DEFAULT_RATE_LIMIT, type RateLimiterOptions } from './rate-limit.js';

/** Custom JSON-RPC error code: method exists but is not authorized here. */
const METHOD_NOT_AUTHORIZED = -32003;

/** Classify an accomplish:// URL the way the Electron protocol handler did. */
export function deepLinkEvent(url: string): 'mcp-callback' | 'auth-callback' | null {
  if (url.startsWith('accomplish://callback/mcp')) {
    return 'mcp-callback';
  }
  if (url.startsWith('accomplish://callback')) {
    return 'auth-callback';
  }
  return null;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const WS_AUTH_TIMEOUT_MS = 5_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Mirrors the CSP the Electron shell injected via onHeadersReceived. */
const CSP_HEADER =
  "default-src 'self' https:; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; connect-src 'self' ws:; font-src 'self' https: data:; " +
  "worker-src 'self' blob:";

export interface RpcProxy {
  call(method: string, params?: unknown): Promise<unknown>;
}

/** Native pickers (zenity) — injectable for tests. */
export interface GatewayPickers {
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<unknown[]>;
}

export interface GatewayOptions {
  /** 0 = ephemeral port (resolved on the returned handle). */
  port: number;
  token: string;
  webDist: string | null;
  rpc: RpcProxy;
  version?: string;
  logger?: HostLogger;
  rateLimiterOptions?: RateLimiterOptions;
  /** Allowlist/blocklist overrides — tests use these to prove invariants. */
  policySets?: { allow?: ReadonlySet<string>; block?: ReadonlySet<string> };
  /** Injectable so tests never actually launch a browser helper. */
  openExternalImpl?: (url: string) => Promise<void>;
  /** Native file/folder pickers (Phase 2). */
  pickers?: GatewayPickers;
  /** Repo root for CLI resolution (defaults to resolveAppPath()). */
  appPath?: string;
  /** Injectable CLI status (tests). */
  cliStatusImpl?: () => Promise<import('./cli-status.js').CliStatus>;
  /** Injectable systemd status probe (tests). */
  autostartStatusImpl?: () => { enabled: boolean; active: boolean };
  maxBodyBytes?: number;
  maxWsMessageBytes?: number;
  wsAuthTimeoutMs?: number;
}

export interface GatewayHandle {
  port: number;
  server: Server;
  broadcastNotification(method: string, params: unknown): void;
  broadcastControl(event: string, params?: unknown): void;
  close(): Promise<void>;
}

interface AuthedSocket {
  ws: WebSocket;
  authed: boolean;
  authTimer: NodeJS.Timeout | null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function jsonRpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false }> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!overflowed) {
          overflowed = true;
          resolveBody({ ok: false });
        }
        // Keep draining without buffering so the 413 response can be
        // delivered on the same connection.
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflowed) {
        resolveBody({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
      }
    });
    req.on('error', () => {
      resolveBody({ ok: false });
    });
  });
}

/**
 * Launch a URL with the desktop's file/URL opener. Linux uses xdg-open;
 * macOS keeps `open` so dev on a Mac behaves.
 */
function defaultOpenExternal(url: string): Promise<void> {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolveOpen, rejectOpen) => {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', rejectOpen);
    // Opener handoff is asynchronous; do not wait for the helper to exit.
    resolveOpen();
  });
}

function isValidExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export async function createGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const logger = options.logger ?? noopLogger;
  const version = options.version ?? HOST_VERSION;
  const platform = process.platform;
  const rateLimiter = new TokenRateLimiter(options.rateLimiterOptions ?? DEFAULT_RATE_LIMIT);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxWsMessageBytes = options.maxWsMessageBytes ?? MAX_WS_MESSAGE_BYTES;
  const wsAuthTimeoutMs = options.wsAuthTimeoutMs ?? WS_AUTH_TIMEOUT_MS;
  const openExternalImpl = options.openExternalImpl ?? defaultOpenExternal;
  const webDist = options.webDist ? resolve(options.webDist) : null;
  const pickers: GatewayPickers = options.pickers ?? {
    pickFolder: () => pickFolder(),
    pickFiles: () => pickFiles(),
  };

  let listeningPort = options.port;
  const sockets = new Set<AuthedSocket>();
  const wss = new WebSocketServer({ noServer: true });

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      logger.error('Unhandled gateway error', { error: String(err) });
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(null, -32603, 'Internal error'));
      } else {
        res.destroy();
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/events') {
      socket.destroy();
      return;
    }
    if (!isAllowedHostHeader(req.headers.host, listeningPort)) {
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, listeningPort)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleWsConnection(ws);
    });
  });

  function broadcast(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const entry of sockets) {
      if (entry.authed && entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(payload);
      }
    }
  }

  function handleWsConnection(ws: WebSocket): void {
    const entry: AuthedSocket = { ws, authed: false, authTimer: null };
    sockets.add(entry);
    entry.authTimer = setTimeout(() => {
      if (!entry.authed) {
        ws.close(4401, 'authentication required');
      }
    }, wsAuthTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(4400, 'binary messages not supported');
        return;
      }
      const raw = data.toString('utf8');
      if (raw.length > maxWsMessageBytes) {
        ws.close(1009, 'message too large');
        return;
      }
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        message = parsed as Record<string, unknown>;
      } catch {
        ws.close(4400, 'invalid JSON');
        return;
      }

      if (!entry.authed) {
        if (message.type === 'auth' && typeof message.token === 'string') {
          if (timingSafeTokenEquals(message.token, options.token)) {
            entry.authed = true;
            if (entry.authTimer) {
              clearTimeout(entry.authTimer);
              entry.authTimer = null;
            }
            ws.send(JSON.stringify({ type: 'auth-ok' }));
          } else {
            ws.close(4401, 'invalid token');
          }
        } else {
          ws.close(4401, 'authentication required');
        }
        return;
      }

      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      ws.close(4400, 'unsupported message type');
    });

    ws.on('close', () => {
      if (entry.authTimer) {
        clearTimeout(entry.authTimer);
        entry.authTimer = null;
      }
      sockets.delete(entry);
    });
  }

  function checkTransportHeaders(req: IncomingMessage): number | null {
    if (!isAllowedHostHeader(req.headers.host, listeningPort)) {
      return 403;
    }
    if (!isAllowedOrigin(req.headers.origin, listeningPort)) {
      return 403;
    }
    return null;
  }

  function authorize(req: IncomingMessage): boolean {
    const presented = extractBearerToken(req.headers.authorization);
    if (!presented) {
      return false;
    }
    return timingSafeTokenEquals(presented, options.token);
  }

  function serveStatic(res: ServerResponse, pathname: string, isHead: boolean): void {
    if (!webDist) {
      sendJson(res, 404, jsonRpcError(null, -32601, 'Not found'));
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 404, jsonRpcError(null, -32601, 'Not found'));
      return;
    }
    relative = normalize(relative);
    if (relative === '..' || relative.startsWith(`..${sep}`)) {
      sendJson(res, 404, jsonRpcError(null, -32601, 'Not found'));
      return;
    }
    const filePath = resolve(join(webDist, relative));
    if (filePath !== webDist && !filePath.startsWith(webDist + sep)) {
      sendJson(res, 404, jsonRpcError(null, -32601, 'Not found'));
      return;
    }
    const hasExtension = extname(filePath) !== '';
    const candidates = hasExtension
      ? [filePath]
      : [join(filePath, 'index.html'), join(webDist, 'index.html')];
    for (const candidate of candidates) {
      if (serveFile(res, candidate, isHead)) {
        return;
      }
    }
    sendJson(res, 404, jsonRpcError(null, -32601, 'Not found'));
  }

  function serveFile(res: ServerResponse, filePath: string, isHead: boolean): boolean {
    let size: number;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return false;
      }
      size = stat.size;
    } catch {
      return false;
    }
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Content-Length': String(size),
      'X-Content-Type-Options': 'nosniff',
    };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = CSP_HEADER;
      headers['Cache-Control'] = 'no-store';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    res.writeHead(200, headers);
    if (isHead) {
      res.end();
    } else {
      const stream = createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', () => {
        res.destroy();
      });
    }
    return true;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transportError = checkTransportHeaders(req);
    if (transportError !== null) {
      sendJson(res, transportError, jsonRpcError(null, METHOD_NOT_AUTHORIZED, 'Forbidden'));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, version, platform });
      return;
    }

    if (method === 'POST' && url.pathname === '/rpc') {
      await handleRpc(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/open-external') {
      await handleOpenExternal(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/pick-folder') {
      await handlePicker(req, res, async () => ({ path: await pickers.pickFolder() }));
      return;
    }

    if (method === 'POST' && url.pathname === '/pick-files') {
      await handlePicker(req, res, async () => ({ files: await pickers.pickFiles() }));
      return;
    }

    if (method === 'POST' && url.pathname === '/deep-link') {
      await handleDeepLink(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/client-log') {
      await handleClientLog(req, res);
      return;
    }

    if (method === 'GET' && url.pathname === '/cli-status') {
      await handleCliStatus(req, res);
      return;
    }

    if (method === 'GET' && url.pathname === '/autostart-status') {
      await handleAutostartStatus(req, res);
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      serveStatic(res, url.pathname, method === 'HEAD');
      return;
    }

    sendJson(res, 405, jsonRpcError(null, -32601, 'Method not allowed'));
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The token is only ever accepted from the Authorization header —
    // never from query strings, which would leak into logs/history.
    if (urlHasTokenQueryParam(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    if (!authorize(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    const rate = rateLimiter.check(options.token);
    if (!rate.allowed) {
      sendJson(res, 429, jsonRpcError(null, -32603, 'Too many requests'));
      return;
    }

    const body = await readBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 413, jsonRpcError(null, -32603, 'Payload too large'));
      return;
    }
    let request: { id?: string | number | null; method?: unknown; params?: unknown };
    try {
      const parsed: unknown = JSON.parse(body.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      request = parsed as { id?: string | number | null; method?: unknown; params?: unknown };
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
    if (typeof request.method !== 'string' || request.method.length === 0) {
      sendJson(res, 400, jsonRpcError(id, -32600, 'Invalid Request'));
      return;
    }

    const decision = checkMethodPolicy(request.method, options.policySets);
    if (!decision.allowed) {
      const message =
        decision.reason === 'blocked' ? 'Method not authorized (blocked)' : 'Method not authorized';
      logger.warn('RPC method denied', { method: request.method, reason: decision.reason });
      sendJson(res, 403, jsonRpcError(id, METHOD_NOT_AUTHORIZED, message));
      return;
    }

    try {
      const result = await options.rpc.call(request.method, request.params);
      // provider.getSettings crosses the browser trust boundary — scrub
      // any secret-looking fields before the response leaves.
      const payload =
        request.method === 'provider.getSettings' ? scrubSecretFields(result) : result;
      sendJson(res, 200, { jsonrpc: '2.0', id, result: payload });
    } catch (err) {
      const error = err as Error & { code?: number };
      sendJson(res, 200, jsonRpcError(id, error.code ?? -32603, error.message || 'Internal error'));
    }
  }

  /**
   * Shared handler for native-picker endpoints: token + rate limit, then
   * the injected picker with desktop-handler-style error passthrough.
   */
  async function handlePicker(
    req: IncomingMessage,
    res: ServerResponse,
    run: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    if (!authorize(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    const rate = rateLimiter.check(options.token);
    if (!rate.allowed) {
      sendJson(res, 429, jsonRpcError(null, -32603, 'Too many requests'));
      return;
    }
    try {
      sendJson(res, 200, await run());
    } catch (err) {
      sendJson(res, 200, jsonRpcError(null, -32603, (err as Error).message || 'Picker failed'));
    }
  }

  /**
   * Deep-link entry: `accomplish://callback/...` URLs forwarded by the
   * .desktop launcher. Mirrors the Electron protocol-handler dispatch —
   * `callback/mcp*` is the MCP OAuth callback, other `callback*` hosts are
   * generic auth callbacks. Everything else is rejected.
   */
  async function handleDeepLink(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    const rate = rateLimiter.check(options.token);
    if (!rate.allowed) {
      sendJson(res, 429, jsonRpcError(null, -32603, 'Too many requests'));
      return;
    }
    const body = await readBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 413, jsonRpcError(null, -32603, 'Payload too large'));
      return;
    }
    let url: unknown;
    try {
      const parsed: unknown = JSON.parse(body.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      url = (parsed as { url?: unknown }).url;
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    if (typeof url !== 'string' || !url.startsWith('accomplish://callback')) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'Not an accomplish:// callback URL'));
      return;
    }
    const event = deepLinkEvent(url);
    if (!event) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'Not an accomplish:// callback URL'));
      return;
    }
    broadcast({ type: 'control', event, params: { url } });
    logger.info('Deep link forwarded', { event });
    sendJson(res, 200, { accepted: true });
  }

  /**
   * Client diagnostics channel — browser-side errors/logs land in the host
   * log so startup failures are diagnosable without manual console access.
   * Fire-and-forget semantics; every field is size-capped.
   */
  async function handleClientLog(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    const rate = rateLimiter.check(options.token);
    if (!rate.allowed) {
      sendJson(res, 429, jsonRpcError(null, -32603, 'Too many requests'));
      return;
    }
    const body = await readBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 413, jsonRpcError(null, -32603, 'Payload too large'));
      return;
    }
    let entry: { level?: unknown; message?: unknown; context?: unknown };
    try {
      const parsed: unknown = JSON.parse(body.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      entry = parsed as typeof entry;
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    const level = entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info';
    const message = String(entry.message ?? '').slice(0, 4000);
    const context = typeof entry.context === 'string' ? entry.context.slice(0, 2000) : undefined;
    logger[level](`[client] ${message}`, context ? { context } : undefined);
    sendJson(res, 200, { recorded: true });
  }

  /**
   * OpenCode CLI status — host-side equivalent of the Electron
   * `opencode:check` handler, resolved the same way the daemon resolves it.
   */
  async function handleCliStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    const status = options.cliStatusImpl
      ? await options.cliStatusImpl()
      : await getCliStatus(options.appPath ?? resolveAppPath());
    sendJson(res, 200, status);
  }

  /** systemd autostart status for the settings UI. */
  function handleAutostartStatus(req: IncomingMessage, res: ServerResponse): void {
    if (!authorize(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    const status = options.autostartStatusImpl
      ? options.autostartStatusImpl()
      : {
          enabled: isDaemonServiceEnabled({
            dataDir: '',
            nodeBin: '',
            daemonEntryPath: '',
            appPath: '',
          }),
          active: isDaemonServiceActive({
            dataDir: '',
            nodeBin: '',
            daemonEntryPath: '',
            appPath: '',
          }),
        };
    sendJson(res, 200, status);
  }

  async function handleOpenExternal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req)) {
      sendJson(res, 401, jsonRpcError(null, -32603, 'Unauthorized'));
      return;
    }
    const rate = rateLimiter.check(options.token);
    if (!rate.allowed) {
      sendJson(res, 429, jsonRpcError(null, -32603, 'Too many requests'));
      return;
    }
    const body = await readBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 413, jsonRpcError(null, -32603, 'Payload too large'));
      return;
    }
    let url: unknown;
    try {
      const parsed: unknown = JSON.parse(body.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      url = (parsed as { url?: unknown }).url;
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    if (typeof url !== 'string' || !isValidExternalUrl(url)) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'Only http(s) URLs may be opened'));
      return;
    }
    try {
      await openExternalImpl(url);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, jsonRpcError(null, -32603, `Failed to open URL: ${String(err)}`));
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        listeningPort = address.port;
      }
      logger.info('Gateway listening', { port: listeningPort });
      resolveListen();
    });
  });

  return {
    port: listeningPort,
    server,
    broadcastNotification(method: string, params: unknown): void {
      broadcast({ type: 'notification', method, params });
    },
    broadcastControl(event: string, params?: unknown): void {
      broadcast({ type: 'control', event, ...(params !== undefined ? { params } : {}) });
    },
    async close(): Promise<void> {
      for (const entry of sockets) {
        entry.ws.close(1000, 'gateway shutting down');
        if (entry.authTimer) {
          clearTimeout(entry.authTimer);
          entry.authTimer = null;
        }
      }
      sockets.clear();
      await new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => {
          resolveClose();
        });
      });
      wss.close();
    },
  };
}

function urlHasTokenQueryParam(req: IncomingMessage): boolean {
  const raw = req.url ?? '';
  const query = raw.slice(raw.indexOf('?') + 1);
  return /(^|&)token=/.test(query);
}
