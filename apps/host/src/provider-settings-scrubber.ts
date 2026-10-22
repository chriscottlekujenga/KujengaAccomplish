/**
 * UNIVERSAL response scrubber for the browser-facing RPC gateway.
 *
 * The gateway proxies JSON-RPC to the daemon and is the enforcement point
 * for the browser trust boundary (FIREFOX_MIGRATION_PLAN §7.3,
 * PHASE_3_IMPLEMENTATION_PLAN §5.4): every POST /rpc response loses any
 * field whose name looks like secret material, regardless of which method
 * produced it. Daemon-side type discipline already keeps plaintext keys in
 * secure storage and returns masked metadata (`keyPrefix`, `apiKeyPrefix`,
 * `hasApiKey`) — this scrubber is defense in depth, so a raw key stored by
 * a legacy import (or any future handler regression) can still not cross
 * the boundary.
 *
 * Convention (kept from the original provider-settings scrubber): secret
 * fields are REMOVED entirely, not masked — display-safe metadata survives,
 * and absence cannot be reassembled into the secret.
 *
 * Exceptions: some field names could in principle collide with non-secret
 * data the UI needs. Any such exception must be listed in
 * RESPONSE_SECRET_EXCEPTIONS as (method → field names) AND proven with a
 * test referencing the audit finding. Default is scrub.
 */

/**
 * Field names at ANY nesting depth whose value is treated as secret.
 * Exact-name matching only, so display-safe lookalikes (`keyPrefix`,
 * `apiKeyPrefix`, `accessKeyIdPrefix`, `inputTokens`, `totalTokens`)
 * intentionally survive. Exported so tests can pin the audited set.
 */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'apiKey',
  'secretKey',
  'secretAccessKey',
  'sessionToken',
  'password',
  'refreshToken',
  'accessToken',
  'serviceAccountJson',
  'token',
  // Phase 3 M2 T2 audit finding: MCP-DCR registration responses carry an
  // OAuth client secret, and desktop upserts the `clientRegistration` blob
  // into the connector row (connector-handlers.ts) — so a connectors.list/
  // getEnabled response can expose `clientRegistration.clientSecret`.
  'clientSecret',
]);

/**
 * (method → field names) pairs that must pass through the scrubber because
 * the audit proved they are NOT secrets and the UI requires them.
 *
 * M1 audit result (62-method sweep): ZERO exceptions — every allowlisted
 * read method returns either primitive/state data or masked metadata, and
 * no non-secret field in any response shape collides with a
 * SECRET_FIELD_NAMES entry. The map is therefore empty; it is deliberately
 * mutable so the exception mechanism can be exercised by tests (which
 * restore it) — any production addition demands a paired audit-reference
 * test here.
 */
export const RESPONSE_SECRET_EXCEPTIONS: Record<string, ReadonlySet<string>> = {};

/**
 * JSON.parse results cannot be cyclic, but a per-response depth bound keeps
 * the recursion defensive for non-JSON payloads. 32 covers any realistic
 * settings/task shape many times over (audit found max nesting of 5).
 */
const MAX_SCRUB_DEPTH = 32;

/**
 * Remove secret-looking fields from `value` at all nesting depths. Objects
 * and arrays are rebuilt recursively; primitives pass through unchanged.
 * Exact-name matching only — display-safe lookalikes survive.
 */
export function scrubSecretFields(value: unknown, depth = 0): unknown {
  return scrubWithExceptions(value, depth, EMPTY_KEEP);
}

/**
 * Universal gateway entry point: scrub an RPC response by method. Unknown
 * methods are scrubbed with the full field set (default = scrub); a method
 * with registered exceptions keeps those exact keys.
 */
export function scrubResponse(method: string, result: unknown): unknown {
  const exceptions = RESPONSE_SECRET_EXCEPTIONS[method];
  if (!exceptions || exceptions.size === 0) {
    return scrubSecretFields(result);
  }
  return scrubWithExceptions(result, 0, exceptions);
}

const EMPTY_KEEP: ReadonlySet<string> = new Set();

/** Recursive core; `keep` opts specific field names out of removal. */
function scrubWithExceptions(value: unknown, depth: number, keep: ReadonlySet<string>): unknown {
  if (depth > MAX_SCRUB_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubWithExceptions(item, depth + 1, keep));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_NAMES.has(key) && !keep.has(key)) {
        continue;
      }
      result[key] = scrubWithExceptions(entry, depth + 1, keep);
    }
    return result;
  }
  return value;
}
