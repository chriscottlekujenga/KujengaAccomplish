import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateBrowserToken,
  resolveBrowserToken,
  extractBearerToken,
  timingSafeTokenEquals,
  verifyAnyCredentialHeader,
} from './token-auth.js';

const ENV_KEY = 'ACCOMPLISH_DEV_BROWSER_TOKEN';

describe('token-auth (dev-browser sidecar — Phase 3 M1 §5.3)', () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  describe('generateBrowserToken', () => {
    it('generates unique 256-bit base64url tokens', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => generateBrowserToken()));
      expect(tokens.size).toBe(50);
      for (const t of tokens) {
        expect(t.length).toBe(43);
      }
    });
  });

  describe('resolveBrowserToken', () => {
    beforeEach(() => {
      delete process.env[ENV_KEY];
    });

    it('prefers the ACCOMPLISH_DEV_BROWSER_TOKEN env (spawn-side hand-off)', () => {
      process.env[ENV_KEY] = 'env-token';
      expect(resolveBrowserToken('option-token')).toBe('env-token');
    });

    it('falls back to the options token when the env is unset', () => {
      expect(resolveBrowserToken('option-token')).toBe('option-token');
    });

    it('generates a self-protecting token when neither is available', () => {
      const token = resolveBrowserToken(undefined);
      expect(token.length).toBe(43);
      expect(resolveBrowserToken(undefined)).not.toBe(token);
    });
  });

  describe('extractBearerToken', () => {
    it('parses Bearer headers', () => {
      expect(extractBearerToken('Bearer tok')).toBe('tok');
      expect(extractBearerToken(undefined)).toBeNull();
      expect(extractBearerToken('Basic x')).toBeNull();
    });
  });

  describe('timingSafeTokenEquals', () => {
    it('is constant-time equality with empty-never-matches', () => {
      expect(timingSafeTokenEquals('a', 'a')).toBe(true);
      expect(timingSafeTokenEquals('a', 'b')).toBe(false);
      expect(timingSafeTokenEquals('a', 'ab')).toBe(false);
      expect(timingSafeTokenEquals('', 'a')).toBe(false);
      expect(timingSafeTokenEquals('a', '')).toBe(false);
    });
  });

  describe('verifyAnyCredentialHeader (WS upgrade headers)', () => {
    it('accepts via authorization bearer', () => {
      expect(verifyAnyCredentialHeader({ authorization: 'Bearer tok-1' }, 'tok-1')).toBe(true);
    });

    it('accepts via x-cdp-secret (Playwright cdpHeaders convention)', () => {
      expect(verifyAnyCredentialHeader({ 'x-cdp-secret': 'tok-1' }, 'tok-1')).toBe(true);
    });

    it('accepts via x-accomplish-dev-browser-token', () => {
      expect(
        verifyAnyCredentialHeader({ 'x-accomplish-dev-browser-token': 'tok-1' }, 'tok-1'),
      ).toBe(true);
    });

    it('reports null when no credential header is present', () => {
      expect(verifyAnyCredentialHeader({}, 'tok-1')).toBeNull();
    });

    it('reports false when a credential is present but wrong', () => {
      expect(verifyAnyCredentialHeader({ 'x-cdp-secret': 'nope' }, 'tok-1')).toBe(false);
      expect(verifyAnyCredentialHeader({ authorization: 'Bearer nope' }, 'tok-1')).toBe(false);
    });
  });
});
