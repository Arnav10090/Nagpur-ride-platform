/**
 * In-memory sliding window rate limiter. No external dependencies (Redis comes later in Phase 8).
 * Each key tracks a fixed-size window of timestamps; requests outside the window are cleaned up lazily.
 *
 * LIMITATION: per-process only. Under multi-process deployment, Redis should replace this (Phase 8).
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export class RateLimiter {
  /** key → sorted array of request timestamps (ms). */
  private windows = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private cfg: RateLimitConfig, private now: () => number = Date.now) {
    // Periodic cleanup of expired entries to prevent unbounded memory growth.
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(cfg.windowMs, 60_000));
  }

  /**
   * Returns true if the request should be allowed, false if rate-limited.
   * When allowed, the request is recorded in the window.
   */
  check(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.cfg.windowMs;
    let timestamps = this.windows.get(key);
    if (!timestamps) { timestamps = []; this.windows.set(key, timestamps); }

    // Remove expired entries from the front.
    while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift();

    if (timestamps.length >= this.cfg.limit) return false;
    timestamps.push(now);
    return true;
  }

  /** Returns remaining requests allowed for this key. */
  remaining(key: string): number {
    const cutoff = this.now() - this.cfg.windowMs;
    const timestamps = this.windows.get(key);
    if (!timestamps) return this.cfg.limit;
    const active = timestamps.filter(t => t >= cutoff).length;
    return Math.max(0, this.cfg.limit - active);
  }

  /** Clean up all expired windows. */
  private cleanup() {
    const cutoff = this.now() - this.cfg.windowMs;
    for (const [key, timestamps] of this.windows) {
      while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift();
      if (timestamps.length === 0) this.windows.delete(key);
    }
  }

  /** For graceful shutdown. */
  destroy() { clearInterval(this.cleanupTimer); }
}

/** Preconfigured rate limiters for different endpoint classes. */
export function createRateLimiters(now: () => number = Date.now) {
  return {
    /** OTP requests: 5 per 5 minutes per phone (IP is separate). */
    otp: new RateLimiter({ limit: 5, windowMs: 5 * 60_000 }, now),
    /** OTP requests per IP: 20 per 5 minutes (shared across all phones from one IP). */
    otpByIp: new RateLimiter({ limit: 20, windowMs: 5 * 60_000 }, now),
    /** Booking: 10 per minute per rider. */
    booking: new RateLimiter({ limit: 10, windowMs: 60_000 }, now),
    /** Location updates: 2 per second per driver (PRD DRV-03 rate limit). */
    location: new RateLimiter({ limit: 2, windowMs: 1_000 }, now),
    /** Webhook calls: 100 per minute per provider (protects against replay storms). */
    webhook: new RateLimiter({ limit: 100, windowMs: 60_000 }, now),
    /** General API: 60 per minute per user. */
    general: new RateLimiter({ limit: 60, windowMs: 60_000 }, now),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;

/** No-op rate limiters for test harnesses: effectively unlimited. */
export function noopRateLimiters(): RateLimiters {
  const noop = () => new RateLimiter({ limit: 1_000_000, windowMs: 1 });
  return { otp: noop(), otpByIp: noop(), booking: noop(), location: noop(), webhook: noop(), general: noop() };
}
