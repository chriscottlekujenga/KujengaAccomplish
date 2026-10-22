import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getDevBrowserToken,
  ACCOMPLISH_DEV_BROWSER_TOKEN_ENV,
} from '../../../src/browser/dev-browser-token.js';

describe('getDevBrowserToken (dev-browser sidecar token — Phase 3 M1 §5.3)', () => {
  const originalEnv = process.env[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV];

  beforeEach(() => {
    vi.resetModules();
    delete process.env[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV];
    } else {
      process.env[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV] = originalEnv;
    }
  });

  it('generates a stable memoized token within one process', () => {
    const first = getDevBrowserToken();
    const second = getDevBrowserToken();
    expect(first).toBe(second);
    expect(first.length).toBe(43);
  });

  it('prefers an explicitly exported ACCOMPLISH_DEV_BROWSER_TOKEN env', () => {
    process.env[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV] = 'launcher-seeded-token';
    expect(getDevBrowserToken()).toBe('launcher-seeded-token');
  });

  it('falls back to generation when the env value is blank', () => {
    process.env[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV] = '   ';
    const token = getDevBrowserToken();
    expect(token.length).toBe(43);
    expect(token).not.toBe('   ');
  });

  it('switches to env import when the env var appears after generation', () => {
    const generated = getDevBrowserToken();
    expect(generated.length).toBe(43);
    process.env[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV] = 'launcher-seeded-token';
    expect(getDevBrowserToken()).toBe('launcher-seeded-token');
  });
});

describe('dev-browser token module reload (fresh memoization per module instance)', () => {
  it('a fresh module instance generates a new token (daemon restart simulation)', async () => {
    const fresh = await import('../../../src/browser/dev-browser-token.js');
    const a = fresh.getDevBrowserToken();
    vi.resetModules();
    const fresher = await import('../../../src/browser/dev-browser-token.js');
    expect(a).not.toBe(fresher.getDevBrowserToken());
    // Both are valid 256-bit base64url tokens.
    expect(a.length).toBe(43);
    expect(fresher.getDevBrowserToken().length).toBe(43);
  });
});
