import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  extractBearerToken,
  isAllowedHostHeader,
  isAllowedOrigin,
  timingSafeTokenEquals,
} from '../../src/auth.js';

describe('createSessionToken', () => {
  it('generates a 256-bit base64url token', () => {
    const token = createSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates unique tokens per call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => createSessionToken()));
    expect(tokens.size).toBe(100);
  });
});

describe('timingSafeTokenEquals', () => {
  it('accepts equal strings', () => {
    const token = createSessionToken();
    expect(timingSafeTokenEquals(token, token)).toBe(true);
  });

  it('rejects different strings', () => {
    expect(timingSafeTokenEquals('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('rejects different-length strings without throwing', () => {
    expect(timingSafeTokenEquals('short', 'a-much-longer-token-value')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(timingSafeTokenEquals('', '')).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
  });

  it('returns null for other schemes', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null for missing or malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('isAllowedHostHeader', () => {
  const port = 8123;

  it('accepts exact loopback hosts with the listening port', () => {
    expect(isAllowedHostHeader(`127.0.0.1:${port}`, port)).toBe(true);
    expect(isAllowedHostHeader(`localhost:${port}`, port)).toBe(true);
    expect(isAllowedHostHeader(`[::1]:${port}`, port)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAllowedHostHeader(`LOCALHOST:${port}`, port)).toBe(true);
  });

  it('rejects foreign hosts (DNS-rebinding payloads)', () => {
    expect(isAllowedHostHeader('evil.example.com:8123', port)).toBe(false);
    expect(isAllowedHostHeader('accomplish.example.com', port)).toBe(false);
  });

  it('rejects the right hostname on the wrong port', () => {
    expect(isAllowedHostHeader('127.0.0.1:9999', port)).toBe(false);
  });

  it('rejects missing or portless Host headers', () => {
    expect(isAllowedHostHeader(undefined, port)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1', port)).toBe(false);
    expect(isAllowedHostHeader('', port)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  const port = 8123;

  it('accepts the gateway origin exactly', () => {
    expect(isAllowedOrigin(`http://127.0.0.1:${port}`, port)).toBe(true);
    expect(isAllowedOrigin(`http://localhost:${port}`, port)).toBe(true);
    expect(isAllowedOrigin(`http://[::1]:${port}`, port)).toBe(true);
  });

  it('permits absent Origin (non-browser clients, same-origin GETs)', () => {
    expect(isAllowedOrigin(undefined, port)).toBe(true);
  });

  it('rejects cross-origin values browsers may send', () => {
    expect(isAllowedOrigin('https://evil.example.com', port)).toBe(false);
    expect(isAllowedOrigin('http://evil.example.com', port)).toBe(false);
    expect(isAllowedOrigin(`http://127.0.0.1:${port + 1}`, port)).toBe(false);
    expect(isAllowedOrigin('null', port)).toBe(false);
  });

  it('rejects https against the http gateway origin', () => {
    expect(isAllowedOrigin(`https://127.0.0.1:${port}`, port)).toBe(false);
  });
});
