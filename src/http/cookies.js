// http/cookies.js — tiny cookie parse/serialize helpers (Customer-auth spec).
//
// The app only ever needs one cookie ('sid'), so this hand-rolls just enough
// instead of adding a cookie-parser dependency (matches the spec's "no new
// dependency beyond Express/cors" framing for this sub-project).

/**
 * @param {string|undefined} cookieHeader - the raw `Cookie` request header.
 * @param {string} name
 * @returns {string|undefined}
 */
export function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Build a `Set-Cookie` header value. `maxAgeSeconds <= 0` produces the
 * immediate-expiry form used for logout.
 * @param {string} name
 * @param {string} value
 * @param {{ maxAgeSeconds?: number, secure?: boolean }} [opts]
 * @returns {string}
 */
export function serializeCookie(name, value, opts = {}) {
  const { maxAgeSeconds, secure = false } = opts;
  const segments = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) segments.push('Secure');
  if (typeof maxAgeSeconds === 'number') {
    segments.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  return segments.join('; ');
}
