import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../../src/http/rateLimiter.js';

describe('createRateLimiter', () => {
  it('allows attempts up to max, then blocks', () => {
    const limiter = createRateLimiter({ max: 3, windowMinutes: 15 });
    expect(limiter.check('a@example.com')).toBe(true);
    limiter.recordFailure('a@example.com');
    expect(limiter.check('a@example.com')).toBe(true);
    limiter.recordFailure('a@example.com');
    expect(limiter.check('a@example.com')).toBe(true);
    limiter.recordFailure('a@example.com');
    expect(limiter.check('a@example.com')).toBe(false); // 3 failures recorded, at the cap
  });

  it('resets the count on a successful login', () => {
    const limiter = createRateLimiter({ max: 1, windowMinutes: 15 });
    limiter.recordFailure('a@example.com');
    expect(limiter.check('a@example.com')).toBe(false);
    limiter.reset('a@example.com');
    expect(limiter.check('a@example.com')).toBe(true);
  });

  it('tracks each key independently', () => {
    const limiter = createRateLimiter({ max: 1, windowMinutes: 15 });
    limiter.recordFailure('a@example.com');
    expect(limiter.check('a@example.com')).toBe(false);
    expect(limiter.check('b@example.com')).toBe(true);
  });

  it('lets the window expire', () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const limiter = createRateLimiter({ max: 1, windowMinutes: 15, now: () => current });
    limiter.recordFailure('a@example.com');
    expect(limiter.check('a@example.com')).toBe(false);

    current = new Date('2026-01-01T00:16:00.000Z'); // 16 min later, window was 15
    expect(limiter.check('a@example.com')).toBe(true);
  });
});
