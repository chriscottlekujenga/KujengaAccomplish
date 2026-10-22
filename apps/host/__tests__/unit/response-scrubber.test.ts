/**
 * Universal response-scrubber tests (Phase 3 M1 §5.4).
 *
 * Driven by the 62-method allowlist audit (see the PR report): every field
 * name in SECRET_FIELD_NAMES must be removed at all nesting depths —
 * including arrays and objects-in-arrays — from every POST /rpc response,
 * while display-safe masked metadata survives. Default = scrub; any
 * exception requires an audit reference and a paired test.
 */

import { describe, expect, it } from 'vitest';
import {
  RESPONSE_SECRET_EXCEPTIONS,
  SECRET_FIELD_NAMES,
  scrubResponse,
  scrubSecretFields,
} from '../../src/provider-settings-scrubber.js';

/** One representative plaintext value per audited secret field name. */
const SECRET_VALUES: Record<string, string> = {
  apiKey: 'sk-live-aa11bb22cc33dd44',
  secretKey: 'wJalrXUtnFEMIfnKEY',
  secretAccessKey: 'AKIAIOSFODNN7SECRET',
  sessionToken: 'FwoGZXIvIgGaSessionTokenValue',
  password: Buffer.from('cGFzc3dvcmQtdmFsdWUtMTIzNA==', 'base64').toString('utf8'),
  refreshToken: 'rt_refresh_1234567890abcdef',
  accessToken: 'ya29.a0AfB_accessTokenValue',
  serviceAccountJson: '{"private_key":"-----BEGIN PRIVATE KEY-----"}',
  token: 'ghp_bearerTokenValue123456',
  // T2 audit finding: MCP-DCR registration issues an OAuth client secret,
  // and desktop upserts `clientRegistration` into connector rows — so
  // connectors.list/getEnabled responses can carry it inside
  // clientRegistration.
  clientSecret: 'dcr_client_secret_LIVE_VALUE',
};

/** Nests `payload` under `levels` additional object wrappers. */
function nestDeep(payload: unknown, levels: number): unknown {
  let value = payload;
  for (let i = 0; i < levels; i++) {
    value = { level: i, inner: value };
  }
  return value;
}

describe('universal response scrubber — SECRET_FIELD_NAMES coverage', () => {
  it('exposes exactly the audited secret field names', () => {
    expect([...SECRET_FIELD_NAMES].sort()).toEqual(Object.keys(SECRET_VALUES).sort());
  });

  for (const [field, value] of Object.entries(SECRET_VALUES)) {
    it(`removes "${field}" from top-level objects`, () => {
      const scrubbed = scrubSecretFields({ [field]: value, keep: 'yes' }) as Record<
        string,
        unknown
      >;
      expect(scrubbed[field]).toBeUndefined();
      expect(scrubbed.keep).toBe('yes');
      expect(JSON.stringify(scrubbed)).not.toContain(value);
      expect(JSON.stringify(scrubbed)).not.toContain(`"${field}"`);
    });

    it(`removes "${field}" nested 9 levels deep (beyond the legacy depth-6 guard)`, () => {
      const deep = scrubSecretFields(nestDeep({ [field]: value, keep: 1 }, 9));
      expect(JSON.stringify(deep)).not.toContain(value);
      expect(JSON.stringify(deep)).not.toContain(`"${field}"`);
      expect(JSON.stringify(deep)).toContain('"keep"');
    });

    it(`scrubs keyed fields inside plain arrays while scalars pass unchanged`, () => {
      // Bare strings in arrays have no key name — the audit contract is
      // key-name-based ("any key named ..."), so scalars pass through while
      // keyed fields anywhere in the structure are removed.
      const scrubbed = scrubSecretFields({ list: [value, 'plain', 7] }) as {
        list: unknown[];
      };
      expect(scrubbed.list).toEqual([value, 'plain', 7]);
      const mixed = scrubSecretFields({
        list: [{ [field]: value, keep: 'x' }, 'scalar', 7],
      }) as { list: unknown[] };
      expect(JSON.stringify(mixed)).not.toContain(value);
      expect(mixed.list).toEqual([{ keep: 'x' }, 'scalar', 7]);
    });

    it(`removes "${field}" from objects inside arrays`, () => {
      const scrubbed = scrubSecretFields({
        list: [{ [field]: value, keep: 'x' }, 'scalar', 7],
      }) as { list: unknown[] };
      const first = scrubbed.list[0] as Record<string, unknown>;
      expect(first[field]).toBeUndefined();
      expect(first.keep).toBe('x');
      expect(scrubbed.list[1]).toBe('scalar');
      expect(scrubbed.list[2]).toBe(7);
      expect(JSON.stringify(scrubbed)).not.toContain(value);
    });

    it(`scrubs "${field}" through the universal response entry for unknown methods`, () => {
      const result = scrubResponse('some.unaudited.method', {
        data: [{ [field]: value, keep: true }],
      });
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(`"${field}"`);
    });
  }

  it('scrubs the M2 T4 browser-preview responses but keeps their documented payload fields (§5.4a)', () => {
    // devBrowser.captureFrame → { data, width, height } | null: the base64
    // JPEG + CSS size is the whole payload — and if a compromised sidecar
    // ever smuggled token-shaped fields into a frame result, the universal
    // scrubber removes them before the response crosses the gateway.
    const frame = {
      data: 'ZmFrZS1qcGVnLWJ5dGVz',
      width: 800,
      height: 600,
      token: 'ghp_bearerTokenValue123456',
      accessToken: 'ya29.a0AfB_accessTokenValue',
      apiKey: 'sk-live-aa11bb22cc33dd44',
    };
    const scrubbed = scrubResponse('devBrowser.captureFrame', frame) as Record<string, unknown>;
    expect(scrubbed.data).toBe('ZmFrZS1qcGVnLWJ5dGVz');
    expect(scrubbed.width).toBe(800);
    expect(scrubbed.height).toBe(600);
    expect(JSON.stringify(scrubbed)).not.toContain('ghp_bearerTokenValue123456');
    expect(JSON.stringify(scrubbed)).not.toContain('ya29.a0AfB_accessTokenValue');
    expect(JSON.stringify(scrubbed)).not.toContain('sk-live-aa11bb22cc33dd44');
    // null degradation (sidecar/browser/page absent) passes through as null.
    expect(scrubResponse('devBrowser.captureFrame', null)).toBeNull();

    // devBrowser.openPreviewPage → { targetId } | null; devBrowser.shutdown →
    // { stopped } — boolean only; both survive the scrubber verbatim.
    expect(scrubResponse('devBrowser.openPreviewPage', { targetId: 'T1' })).toEqual({
      targetId: 'T1',
    });
    expect(scrubResponse('devBrowser.shutdown', { stopped: true })).toEqual({ stopped: true });
    // Even hypothetical token material inside those shapes is removed.
    const hostilePage = scrubResponse('devBrowser.openPreviewPage', {
      targetId: 'T1',
      wsEndpoint: 'ws://127.0.0.1:9225/devtools/browser/abc',
      token: 'ghp_bearerTokenValue123456',
    }) as Record<string, unknown>;
    expect(hostilePage.targetId).toBe('T1');
    expect(JSON.stringify(hostilePage)).not.toContain('ghp_bearerTokenValue123456');
  });

  it('keeps display-safe masked metadata that the UI renders', () => {
    // audit: provider.getSettings returns keyPrefix/apiKeyPrefix/hasApiKey
    // by design — these lookalikes are exact-name distinct from secrets.
    const scrubbed = scrubSecretFields({
      credentials: { type: 'api_key', keyPrefix: 'abcd', hasApiKey: true },
      nested: { apiKeyPrefix: 'ef01', accessKeyIdPrefix: 'AKIA', keyPrefix: 'zz' },
      usage: { inputTokens: 10, totalTokens: 30 },
    }) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).toContain('"keyPrefix":"abcd"');
    expect(JSON.stringify(scrubbed)).toContain('"apiKeyPrefix":"ef01"');
    expect(JSON.stringify(scrubbed)).toContain('"accessKeyIdPrefix":"AKIA"');
    expect(JSON.stringify(scrubbed)).toContain('"hasApiKey":true');
    expect(JSON.stringify(scrubbed)).toContain('"inputTokens":10');
  });

  it('passes primitives, null, and arrays of primitives through unchanged', () => {
    expect(scrubSecretFields('plain')).toBe('plain');
    expect(scrubSecretFields(42)).toBe(42);
    expect(scrubSecretFields(null)).toBeNull();
    expect(scrubSecretFields(undefined)).toBeUndefined();
    expect(scrubSecretFields([1, 'two', true])).toEqual([1, 'two', true]);
  });
});

describe('exception map (documented false-positive mechanism)', () => {
  it('has ZERO exceptions after the M1 audit — default is scrub', () => {
    // The 62-method audit found no allowlisted response carrying a
    // non-secret field that collides with SECRET_FIELD_NAMES, so the
    // exception map ships empty. Any future entry must come with a paired
    // audit-reference test here (per the file header contract).
    expect(Object.keys(RESPONSE_SECRET_EXCEPTIONS)).toEqual([]);
  });

  it('grants registered exceptions only for the exact method', () => {
    // Mechanism proof: an exception keeps the field for one method only.
    // (Cleaned up in a finally so the shared registry stays empty.)
    const method = 'test-only.exception.method';
    RESPONSE_SECRET_EXCEPTIONS[method] = new Set(['token']);
    try {
      const payload = { token: 'a', other: 'b' };
      expect(JSON.stringify(scrubResponse(method, payload))).toContain('"token":"a"');
      expect(JSON.stringify(scrubResponse('other.method', payload))).not.toContain('"token"');
    } finally {
      delete RESPONSE_SECRET_EXCEPTIONS[method];
    }
    expect(Object.keys(RESPONSE_SECRET_EXCEPTIONS)).toEqual([]);
  });
});
