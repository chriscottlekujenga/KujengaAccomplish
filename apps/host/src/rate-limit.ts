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

/**
 * Per-token budget of 1500 requests/60 s: the old 600 budget was consumed by
 * web-UI reconnect floods after every daemon restart, producing spurious 429s
 * (DEVELOPMENT_CHECKPOINT §17). 1500 leaves headroom for those legitimate
 * bursts while still capping abusive per-token traffic.
 */
export const DEFAULT_RATE_LIMIT: RateLimiterOptions = { limit: 1500, windowMs: 60_000 };

/** Valid `ACCOMPLISH_GATEWAY_RATE_LIMIT` range: sane floor, abuse-guard ceiling. */
const RATE_LIMIT_MIN = 60;
const RATE_LIMIT_MAX = 100_000;

/**
 * Resolve rate-limiter options from the environment.
 *
 * `ACCOMPLISH_GATEWAY_RATE_LIMIT` overrides the per-token request budget;
 * absent or invalid values (non-numeric, or outside 60..100000) fall back to
 * the default with a warning. Pure/deterministic — never reads a clock.
 */
export function resolveRateLimiterOptions(env: NodeJS.ProcessEnv): RateLimiterOptions {
  const raw = env.ACCOMPLISH_GATEWAY_RATE_LIMIT;
  if (raw === undefined) {
    return DEFAULT_RATE_LIMIT;
  }
  const parsed = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed >= RATE_LIMIT_MIN && parsed <= RATE_LIMIT_MAX) {
    return { limit: parsed, windowMs: DEFAULT_RATE_LIMIT.windowMs };
  }
  console.warn(
    `[host] Invalid ACCOMPLISH_GATEWAY_RATE_LIMIT "${raw}" — using default ${DEFAULT_RATE_LIMIT.limit}/60s`,
  );
  return DEFAULT_RATE_LIMIT;
}

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
