import { describe, expect, it } from 'vitest';
import { TokenRateLimiter } from '../../src/rate-limit.js';

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
