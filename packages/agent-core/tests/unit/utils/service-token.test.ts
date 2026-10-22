import { describe, it, expect } from 'vitest';
import {
  generateServiceToken,
  timingSafeTokenEquals,
  extractBearerToken,
  verifyBearerToken,
  verifyBearerTokenEquals,
  verifyRawToken,
  bearerHeaderValue,
} from '../../../src/utils/service-token.js';

describe('service-token (side-service bearer tokens — Phase 3 M1 §5.3)', () => {
  describe('generateServiceToken', () => {
    it('generates a non-empty base64url token', () => {
      const token = generateServiceToken();
      expect(token.length).toBeGreaterThan(0);
      expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
    });

    it('generates 256-bit tokens (43 base64url chars)', () => {
      expect(generateServiceToken().length).toBe(43);
    });

    it('generates unique tokens', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateServiceToken()));
      expect(tokens.size).toBe(100);
    });
  });

  describe('timingSafeTokenEquals', () => {
    it('matches identical non-empty strings', () => {
      expect(timingSafeTokenEquals('abc', 'abc')).toBe(true);
    });

    it('rejects different values of the same length', () => {
      expect(timingSafeTokenEquals('aaa', 'aab')).toBe(false);
    });

    it('rejects different-length inputs', () => {
      expect(timingSafeTokenEquals('abc', 'abcd')).toBe(false);
    });

    it('never matches empty inputs', () => {
      expect(timingSafeTokenEquals('', 'abc')).toBe(false);
      expect(timingSafeTokenEquals('abc', '')).toBe(false);
      expect(timingSafeTokenEquals('', '')).toBe(false);
    });
  });

  describe('extractBearerToken', () => {
    it('parses a Bearer header case-insensitively', () => {
      expect(extractBearerToken('Bearer tok-1')).toBe('tok-1');
      expect(extractBearerToken('bearer tok-1')).toBe('tok-1');
    });

    it('returns null for missing/malformed headers', () => {
      expect(extractBearerToken(undefined)).toBeNull();
      expect(extractBearerToken('')).toBeNull();
      expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
      expect(extractBearerToken('Bearer')).toBeNull();
      expect(extractBearerToken('Bearer ')).toBeNull();
    });
  });

  describe('verifyBearerToken (allowlist form — proxy surfaces)', () => {
    const tokens = new Set(['tok-a', 'tok-b']);

    it('accepts a token in the allowlist', () => {
      expect(verifyBearerToken('Bearer tok-a', tokens)).toBe(true);
      expect(verifyBearerToken('Bearer tok-b', tokens)).toBe(true);
    });

    it('rejects wrong/missing tokens', () => {
      expect(verifyBearerToken('Bearer wrong', tokens)).toBe(false);
      expect(verifyBearerToken(undefined, tokens)).toBe(false);
      expect(verifyBearerToken('Bearer', tokens)).toBe(false);
      expect(verifyBearerToken('Basic tok-a', tokens)).toBe(false);
    });

    it('rejects against an empty allowlist', () => {
      expect(verifyBearerToken('Bearer tok-a', new Set())).toBe(false);
    });
  });

  describe('verifyBearerTokenEquals (single-token form — dev-browser surface)', () => {
    it('matches the exact expected token', () => {
      expect(verifyBearerTokenEquals('Bearer tok', 'tok')).toBe(true);
    });

    it('rejects wrong/missing tokens', () => {
      expect(verifyBearerTokenEquals('Bearer wrong', 'tok')).toBe(false);
      expect(verifyBearerTokenEquals(undefined, 'tok')).toBe(false);
      expect(verifyBearerTokenEquals('Bearer ', 'tok')).toBe(false);
    });
  });

  describe('verifyRawToken (dicated-header form — x-accomplish-proxy-token)', () => {
    const tokens = new Set(['tok-a', 'tok-b']);

    it('accepts a raw token in the allowlist', () => {
      expect(verifyRawToken('tok-a', tokens)).toBe(true);
      expect(verifyRawToken(' tok-b ', tokens)).toBe(true);
    });

    it('rejects wrong/missing values', () => {
      expect(verifyRawToken('wrong', tokens)).toBe(false);
      expect(verifyRawToken(undefined, tokens)).toBe(false);
      expect(verifyRawToken('', tokens)).toBe(false);
      // Bearer-prefixed values must NOT match a raw-token header.
      expect(verifyRawToken('Bearer tok-a', tokens)).toBe(false);
    });

    it('rejects against an empty allowlist', () => {
      expect(verifyRawToken('tok-a', new Set())).toBe(false);
    });
  });

  describe('bearerHeaderValue', () => {
    it('builds the Authorization header value', () => {
      expect(bearerHeaderValue('tok')).toBe('Bearer tok');
    });
  });
});
