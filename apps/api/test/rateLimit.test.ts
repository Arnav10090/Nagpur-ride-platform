import { describe, it, expect } from 'vitest';
import { RateLimiter, createRateLimiters } from '../src/http/rateLimit';

describe('RateLimiter', () => {
  it('allows requests within the limit', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 }, () => t);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.remaining('a')).toBe(0);
    rl.destroy();
  });

  it('blocks requests over the limit', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 }, () => t);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    rl.destroy();
  });

  it('expires old requests after the window', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 }, () => t);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    t = 1001; // past the window
    expect(rl.check('a')).toBe(true);
    expect(rl.remaining('a')).toBe(1);
    rl.destroy();
  });

  it('tracks keys independently', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 }, () => t);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    expect(rl.check('b')).toBe(true);
    expect(rl.check('b')).toBe(false);
    rl.destroy();
  });

  it('remaining returns correct values', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 5, windowMs: 1000 }, () => t);
    expect(rl.remaining('x')).toBe(5);
    rl.check('x');
    expect(rl.remaining('x')).toBe(4);
    rl.check('x'); rl.check('x'); rl.check('x'); rl.check('x');
    expect(rl.remaining('x')).toBe(0);
    rl.destroy();
  });
});

describe('createRateLimiters', () => {
  it('creates all expected limiter categories', () => {
    const limiters = createRateLimiters();
    expect(limiters.otp).toBeInstanceOf(RateLimiter);
    expect(limiters.otpByIp).toBeInstanceOf(RateLimiter);
    expect(limiters.booking).toBeInstanceOf(RateLimiter);
    expect(limiters.location).toBeInstanceOf(RateLimiter);
    expect(limiters.webhook).toBeInstanceOf(RateLimiter);
    expect(limiters.general).toBeInstanceOf(RateLimiter);
    // Clean up
    Object.values(limiters).forEach(l => l.destroy());
  });
});
