import crypto from 'node:crypto';
import http from 'node:http';
import { RateLimiter } from './rate-limiter.js';
import { log } from './logger.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

export interface Route {
  method: string;
  path: string;
  handler: (
    data: Record<string, unknown>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>;
}

export interface HttpServerOptions {
  authToken: string;
  rateLimiter: RateLimiter;
  routes: Route[];
  serviceName: string;
  /** Fixed port to listen on. If 0 or omitted, the OS assigns a random port. */
  port?: number;
  /**
   * Origins allowed to call this API from a browser context (Phase 3 M1 §5.3).
   *
   * The WhatsApp API's only consumer is the whatsapp MCP tool — a plain Node
   * child that never attaches an Origin header; the browser UI must not call
   * this API directly. With the default empty list, EVERY request bearing an
   * Origin header is rejected (403); origin-less requests proceed to the
   * Bearer-token check. Replace the default by passing explicit origins if a
   * browser consumer is ever introduced deliberately.
   */
  allowedOrigins?: string[];
}

/**
 * Validate the Origin header when present — the cross-origin defense
 * (mirrors the host gateway's isAllowedOrigin, but the side-service surfaces
 * have no browser-UI consumers, so the default allowlist is empty).
 */
export function validateOrigin(
  req: http.IncomingMessage,
  allowedOrigins: readonly string[],
): boolean {
  const origin = req.headers['origin'];
  if (origin === undefined) {
    // Absent Origin is permitted (non-browser clients: Node fetch, curl).
    return true;
  }
  const normalized = origin.trim().toLowerCase().replace(/\/$/, '');
  return allowedOrigins.some(
    (allowed) => allowed.trim().toLowerCase().replace(/\/$/, '') === normalized,
  );
}

/** Constant-time Bearer-token check; pure predicate (no response writes). */
function tokenMatches(authToken: string, req: http.IncomingMessage): boolean {
  const authHeader = req.headers['authorization'];
  const expected = `Bearer ${authToken}`;
  if (
    !authHeader ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return false;
  }
  return true;
}

function validateAuthToken(
  authToken: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (tokenMatches(authToken, req)) {
    return true;
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

async function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<string | null> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      return null;
    }
  }
  return body;
}

function parseJsonBody(body: string, res: http.ServerResponse): Record<string, unknown> | null {
  try {
    return JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return null;
  }
}

export function createHttpServer(
  options: HttpServerOptions,
): Promise<{ server: http.Server; port: number }> {
  const { authToken, rateLimiter, routes, serviceName, port: requestedPort } = options;
  // Empty list by default: browser contexts are never authorized callers of
  // these loopback side services (Phase 3 M1 §5.3).
  const allowedOrigins = options.allowedOrigins ?? [];

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // Phase 3 M1 §5.3 — replaces the previous bare-204 CORS preflight: an
      // OPTIONS request responds 204 ONLY when the token is valid and the
      // Origin (if any) is allowlisted; otherwise 403.
      if (req.method === 'OPTIONS') {
        const originAllowed = validateOrigin(req, allowedOrigins);
        const tokenValid = originAllowed ? tokenMatches(authToken, req) : false;
        if (originAllowed && tokenValid) {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
        }
        return;
      }

      if (!validateOrigin(req, allowedOrigins)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: origin not allowed' }));
        return;
      }

      const clientIp = req.socket.remoteAddress || 'unknown';
      if (!rateLimiter.isAllowed(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      if (!validateAuthToken(authToken, req, res)) {
        return;
      }

      const route = routes.find((r) => r.method === req.method && r.path === req.url);
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const body = await readBody(req, res);
      if (body === null) {
        return;
      }

      const data = parseJsonBody(body, res);
      if (data === null) {
        return;
      }

      try {
        await route.handler(data, req, res);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        log.error(`[${serviceName}] Unhandled error in ${route.method} ${route.path}:`, error);
      }
    });

    server.listen(requestedPort ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      log.info(`[${serviceName}] Listening on port ${port}`);
      resolve({ server, port });
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && requestedPort) {
        // Port already in use — fall back to OS-assigned port
        log.warn(`[${serviceName}] Port ${requestedPort} in use, falling back to random port`);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          const port = addr && typeof addr === 'object' ? addr.port : 0;
          log.info(`[${serviceName}] Listening on fallback port ${port}`);
          resolve({ server, port });
        });
      } else {
        reject(new Error(`[${serviceName}] Failed to start: ${error.message}`));
      }
    });
  });
}
