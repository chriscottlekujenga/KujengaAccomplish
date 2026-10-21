/**
 * Per-token rate limiter — fixed-window counters.
 *
 * The daemon's HTTP factory rate-limits per-IP, which is useless for the
 * gateway: every browser client shares 127.0.0.1, so one bucket would
 * throttle the legitimate UI. The gateway limits per session token instead
 * (one token per app session), keeping the abuse cap while letting the UI
 * burst normally.
 */

export interface RateLimiterOptions {
  /** Requests allowed per window per token. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateCheckResult {
  allowed: boolean;
  /** Requests remaining in the current window (0 when throttled). */
  remaining: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export const DEFAULT_RATE_LIMIT: RateLimiterOptions = { limit: 600, windowMs: 60_000 };

export class TokenRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimiterOptions = DEFAULT_RATE_LIMIT) {}

  check(key: string, now: number = Date.now()): RateCheckResult {
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.options.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(key, bucket);
      this.prune(now);
    }
    if (bucket.count >= this.options.limit) {
      return { allowed: false, remaining: 0 };
    }
    bucket.count++;
    return { allowed: true, remaining: this.options.limit - bucket.count };
  }

  /** Drop expired buckets so long sessions do not grow the map unbounded. */
  private prune(now: number): void {
    if (this.buckets.size < 1024) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.options.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
