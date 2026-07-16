import { describe, it, expect } from 'vitest';
import { parseCookie, serializeCookie } from '../../src/http/cookies.js';

describe('parseCookie', () => {
  it('finds the named cookie among several', () => {
    expect(parseCookie('a=1; sid=abc-123; b=2', 'sid')).toBe('abc-123');
  });

  it('returns undefined when the cookie is absent or the header is missing', () => {
    expect(parseCookie('a=1; b=2', 'sid')).toBeUndefined();
    expect(parseCookie(undefined, 'sid')).toBeUndefined();
    expect(parseCookie('', 'sid')).toBeUndefined();
  });

  it('decodes a URI-encoded value', () => {
    expect(parseCookie('sid=abc%2Fdef', 'sid')).toBe('abc/def');
  });
});

describe('serializeCookie', () => {
  it('includes HttpOnly, SameSite=Lax, and Path=/ always', () => {
    const value = serializeCookie('sid', 'abc-123');
    expect(value).toContain('sid=abc-123');
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Path=/');
  });

  it('includes Secure only when requested', () => {
    expect(serializeCookie('sid', 'x', { secure: true })).toContain('Secure');
    expect(serializeCookie('sid', 'x', { secure: false })).not.toContain('Secure');
  });

  it('sets Max-Age from maxAgeSeconds, floored and non-negative', () => {
    expect(serializeCookie('sid', 'x', { maxAgeSeconds: 604800 })).toContain('Max-Age=604800');
    expect(serializeCookie('sid', 'x', { maxAgeSeconds: 12.9 })).toContain('Max-Age=12');
  });

  it('produces the immediate-expiry form for maxAgeSeconds <= 0 (logout)', () => {
    expect(serializeCookie('sid', '', { maxAgeSeconds: 0 })).toContain('Max-Age=0');
    expect(serializeCookie('sid', '', { maxAgeSeconds: -1 })).toContain('Max-Age=0');
  });
});
