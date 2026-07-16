// http/middleware/requireAuth.js — cookie -> session -> req.authUser (Customer-auth spec).
//
// Applied per-route (not as a blanket app.use), so login itself never runs
// through this -- there is no session yet at that point.

import { parseCookie } from '../cookies.js';

/**
 * @param {{
 *   authStore: ReturnType<typeof import('../../auth.js').createAuthStore>,
 *   exemptPaths?: string[],
 * }} deps
 */
export function createRequireAuth({ authStore, exemptPaths = [] }) {
  return function requireAuth(req, res, next) {
    const sid = parseCookie(req.headers.cookie, 'sid');
    const session = sid ? authStore.getSession(sid) : null;
    const user = session ? authStore.getUser(session.userId) : null;

    if (!user) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }

    if (user.mustChangePassword && !exemptPaths.includes(req.path)) {
      res.status(403).json({ code: 'must_change_password' });
      return;
    }

    req.authUser = { id: user.id, tenantId: user.tenantId, isSuperadmin: user.isSuperadmin };
    next();
  };
}

/**
 * Resolve the tenant a request should act on: a non-superadmin always uses
 * their own tenant; a superadmin must supply ?tenantId= explicitly (never an
 * implicit "all tenants" view).
 * @param {{ authUser: { tenantId: string|null, isSuperadmin: boolean } }} req
 * @param {{ tenantId?: string }} query
 * @returns {{ ok: true, tenantId: string } | { ok: false }}
 */
export function resolveTenantId(req, query) {
  if (!req.authUser.isSuperadmin) return { ok: true, tenantId: req.authUser.tenantId };
  const tenantId = typeof query.tenantId === 'string' ? query.tenantId.trim() : '';
  return tenantId ? { ok: true, tenantId } : { ok: false };
}
