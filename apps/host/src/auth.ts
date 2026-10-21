/**
 * Gateway authentication and request-origin validation.
 *
 * Threat model (FIREFOX_MIGRATION_PLAN §7): the gateway listens on the
 * loopback interface, but loopback binding alone does not protect a local
 * HTTP server — any web page in the user's browser can attempt
 * DNS-rebinding (rebinding a domain to 127.0.0.1 and then issuing requests
 * with a hostile Host header) or issue direct cross-origin requests. The
 * gateway therefore enforces three independent layers on every request:
 *
 *   1. Bearer token — timing-safe comparison; delivered to the page via the
 *      launch URL fragment, never via query strings or cookies.
 *   2. Host header validation — defeats DNS rebinding.
 *   3. Origin validation when the header is present — defeats direct
 *      cross-origin requests from other pages. Absent Origin (curl, tests,
 *      same-origin GET navigations) is permitted; the token still applies.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

/**
 * Generate a per-session gateway token (256-bit, base64url).
 */
export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time string comparison. Both sides are hashed first so inputs of
 * different lengths cannot leak length information through an early exit.
 * Empty inputs never compare equal — an empty presented token must never
 * authenticate, whatever the configuration state.
 */
export function timingSafeTokenEquals(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(' ', 2);
  if (scheme?.toLowerCase() !== 'bearer' || !value) {
    return null;
  }
  return value.trim();
}

/**
 * Hostnames the gateway is allowed to serve. Port is appended by callers
 * because it is only known after listen (0 = ephemeral).
 */
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Validate the Host header — the DNS-rebinding defense.
 *
 * The header must be exactly `<hostname>:<port>` for one of the loopback
 * hostnames and the port the gateway actually listens on. Browsers always
 * send an explicit port for non-default ports, so strict equality is safe.
 */
export function isAllowedHostHeader(host: string | undefined, port: number): boolean {
  if (!host) {
    return false;
  }
  const normalized = host.trim().toLowerCase();
  for (const hostname of LOOPBACK_HOSTNAMES) {
    if (normalized === `${hostname}:${port}`) {
      return true;
    }
  }
  return false;
}

/**
 * Validate the Origin header when present — the cross-origin defense.
 *
 * Absent Origin is permitted (non-browser clients, same-origin GETs);
 * everything else must match the gateway's own HTTP origin exactly.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) {
    return true;
  }
  const normalized = origin.trim().toLowerCase().replace(/\/$/, '');
  for (const hostname of LOOPBACK_HOSTNAMES) {
    if (normalized === `http://${hostname}:${port}`) {
      return true;
    }
  }
  return false;
}
