import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RATE_LIMIT,
  TokenRateLimiter,
  resolveRateLimiterOptions,
} from '../../src/rate-limit.js';

describe('TokenRateLimiter', () => {
  it('allows requests under the limit', () => {
    const limiter = new TokenRateLimiter({ limit: 3, windowMs: 1000 });
    expect(limiter.check('tok').allowed).toBe(true);
    expect(limiter.check('tok').allowed).toBe(true);
    expect(limiter.check('tok').allowed).toBe(true);
  });

  it('throttles once the limit is reached and reports zero remaining', () => {
    const limiter = new TokenRateLimiter({ limit: 2, windowMs: 1000 });
    limiter.check('tok');
    limiter.check('tok');
    const result = limiter.check('tok');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('resets after the window elapses', async () => {
    const limiter = new TokenRateLimiter({ limit: 1, windowMs: 60 });
    expect(limiter.check('tok').allowed).toBe(true);
    expect(limiter.check('tok').allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(limiter.check('tok').allowed).toBe(true);
  });

  it('tracks tokens independently', () => {
    const limiter = new TokenRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.check('token-a').allowed).toBe(true);
    expect(limiter.check('token-a').allowed).toBe(false);
    expect(limiter.check('token-b').allowed).toBe(true);
  });

  it('reports remaining quota', () => {
    const limiter = new TokenRateLimiter({ limit: 3, windowMs: 1000 });
    expect(limiter.check('tok').remaining).toBe(2);
    expect(limiter.check('tok').remaining).toBe(1);
    expect(limiter.check('tok').remaining).toBe(0);
  });
});

describe('TokenRateLimiter default budget', () => {
  it('allows 1500 requests per simulated 60s window, then throttles the 1501st', () => {
    const limiter = new TokenRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 1500; i++) {
      expect(limiter.check('tok', now).allowed).toBe(true);
    }
    expect(limiter.check('tok', now).allowed).toBe(false);
  });

  it('allows requests again once the window resets', () => {
    const limiter = new TokenRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 1500; i++) {
      limiter.check('tok', now);
    }
    expect(limiter.check('tok', now).allowed).toBe(false);
    expect(limiter.check('tok', now + DEFAULT_RATE_LIMIT.windowMs).allowed).toBe(true);
  });

  it('allows a 1000-request reconnect burst at a single instant (gateway 429 flake regression)', () => {
    const limiter = new TokenRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 1000; i++) {
      expect(limiter.check('tok', now).allowed).toBe(true);
    }
  });
});

describe('resolveRateLimiterOptions', () => {
  it('returns the default when the env override is absent', () => {
    expect(resolveRateLimiterOptions({})).toEqual(DEFAULT_RATE_LIMIT);
  });

  it('uses the env override for a valid budget', () => {
    expect(resolveRateLimiterOptions({ ACCOMPLISH_GATEWAY_RATE_LIMIT: '3000' })).toEqual({
      limit: 3000,
      windowMs: 60_000,
    });
  });

  it('accepts the 60 and 100000 range boundaries', () => {
    expect(resolveRateLimiterOptions({ ACCOMPLISH_GATEWAY_RATE_LIMIT: '60' })).toEqual({
      limit: 60,
      windowMs: 60_000,
    });
    expect(resolveRateLimiterOptions({ ACCOMPLISH_GATEWAY_RATE_LIMIT: '100000' })).toEqual({
      limit: 100_000,
      windowMs: 60_000,
    });
  });

  it.each(['abc', '0', '-5', '200000', '', '12.5'])(
    'falls back to the default with a warning for invalid override "%s"',
    (raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(resolveRateLimiterOptions({ ACCOMPLISH_GATEWAY_RATE_LIMIT: raw })).toEqual(
          DEFAULT_RATE_LIMIT,
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('ACCOMPLISH_GATEWAY_RATE_LIMIT');
      } finally {
        warn.mockRestore();
      }
    },
  );
});
