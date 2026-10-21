/**
 * Response scrubber for provider settings served to browsers.
 *
 * `provider.getSettings` is designed to carry only masked metadata
 * (keyPrefix etc.) — raw keys live in secure storage — but the gateway is
 * the enforcement point for the browser trust boundary (FIREFOX_MIGRATION_
 * PLAN §7.3), so any field that even looks like secret material is removed
 * before the response leaves. Masked fields (keyPrefix, apiKeyPrefix,
 * hasApiKey) are display-safe by design and survive.
 */

const SECRET_FIELD_NAMES = new Set([
  'apiKey',
  'secretKey',
  'secretAccessKey',
  'sessionToken',
  'password',
  'refreshToken',
  'accessToken',
  'serviceAccountJson',
]);

const MAX_SCRUB_DEPTH = 6;

export function scrubSecretFields(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecretFields(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_NAMES.has(key)) {
        continue;
      }
      result[key] = scrubSecretFields(entry, depth + 1);
    }
    return result;
  }
  return value;
}
