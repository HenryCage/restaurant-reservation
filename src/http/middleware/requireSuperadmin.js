// http/middleware/requireSuperadmin.js — cookie -> session -> superadmin-only (Tenant management spec).
//
// Tenant management is fundamentally cross-tenant, so it doesn't fit
// resolveTenantId's one-tenant-at-a-time model -- this is a separate, simpler
// check: valid session + isSuperadmin, full stop, no tenant scoping involved.
// Still enforces the must_change_password gate (same as every other
// authenticated route) -- there's no reason tenant management specifically
// should be reachable with an unchanged temporary password.

import { parseCookie } from '../cookies.js';

/**
 * @param {{ authStore: ReturnType<typeof import('../../auth.js').createAuthStore> }} deps
 */
export function createRequireSuperadmin({ authStore }) {
  return function requireSuperadmin(req, res, next) {
    const sid = parseCookie(req.headers.cookie, 'sid');
    const session = sid ? authStore.getSession(sid) : null;
    const user = session ? authStore.getUser(session.userId) : null;

    if (!user) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }

    if (user.mustChangePassword) {
      res.status(403).json({ code: 'must_change_password' });
      return;
    }

    if (!user.isSuperadmin) {
      res.status(403).json({ error: 'superadmin access required' });
      return;
    }

    req.authUser = { id: user.id, tenantId: user.tenantId, isSuperadmin: user.isSuperadmin };
    next();
  };
}
