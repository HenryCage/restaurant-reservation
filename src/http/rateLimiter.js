// http/rateLimiter.js — in-memory login brute-force guard (Customer-auth spec).
//
// Map-backed, per-process. Fine because this service runs as a single
// instance with no load balancer (same operating model as the rest of the
// service) -- no Redis/shared store needed for a limit this coarse.

/**
 * @param {{ max: number, windowMinutes: number, now?: () => Date }} opts
 */
export function createRateLimiter({ max, windowMinutes, now = () => new Date() }) {
  /** @type {Map<string, { count: number, windowStart: number }>} */
  const attempts = new Map();
  const windowMs = windowMinutes * 60 * 1000;

  /** @param {string} key */
  function currentEntry(key) {
    const entry = attempts.get(key);
    if (!entry) return null;
    if (now().getTime() - entry.windowStart >= windowMs) {
      attempts.delete(key);
      return null;
    }
    return entry;
  }

  return {
    /**
     * Call before attempting the login. False means "blocked, don't even try".
     * @param {string} key
     * @returns {boolean}
     */
    check(key) {
      const entry = currentEntry(key);
      return !entry || entry.count < max;
    },

    /** Call after a failed login attempt. @param {string} key */
    recordFailure(key) {
      const entry = currentEntry(key);
      if (entry) {
        entry.count += 1;
      } else {
        attempts.set(key, { count: 1, windowStart: now().getTime() });
      }
    },

    /** Call after a successful login. @param {string} key */
    reset(key) {
      attempts.delete(key);
    },
  };
}
