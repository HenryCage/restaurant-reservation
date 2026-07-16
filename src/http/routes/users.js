// http/routes/users.js — /api/users: list/create/deactivate/reactivate/reset (User management spec).
//
// Superadmin-only, like tenants.js. Two orthogonal "views" (a single
// tenant's users, or the superadmin roster) live under one GET route rather
// than two separate ones, since they share the same list shape.

import express from 'express';
import { generateTempPassword } from '../../auth.js';

/**
 * @param {{
 *   requireSuperadmin: import('express').RequestHandler,
 *   authStore: ReturnType<typeof import('../../auth.js').createAuthStore>,
 *   registry: ReturnType<typeof import('../../tenants.js').createTenantRegistry>,
 * }} deps
 */
export function createUsersRoutes({ requireSuperadmin, authStore, registry }) {
  const router = express.Router();

  router.get('/', requireSuperadmin, (req, res) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    const superadmins = req.query.superadmins === 'true';

    if (superadmins && tenantId) {
      res.status(400).json({ error: 'tenantId and superadmins are mutually exclusive' });
      return;
    }
    if (superadmins) {
      res.status(200).json(authStore.listSuperadmins());
      return;
    }
    if (tenantId) {
      res.status(200).json(authStore.listByTenant(tenantId));
      return;
    }
    res.status(400).json({ error: 'tenantId or superadmins=true is required' });
  });

  router.post('/', requireSuperadmin, (req, res) => {
    const { email, isSuperadmin } = req.body ?? {};
    const tenantId = typeof req.body?.tenantId === 'string' ? req.body.tenantId.trim() : '';

    if (!isSuperadmin) {
      // Mirrors the same check scripts/create-user.mjs already does --
      // catches a typo'd tenant id loudly instead of silently creating an
      // orphaned user.
      const knownActiveTenant = registry.load().some((t) => t.id === tenantId);
      if (!knownActiveTenant) {
        res.status(400).json({ error: `tenant "${tenantId}" is not a known active tenant` });
        return;
      }
    }

    const temporaryPassword = generateTempPassword();
    try {
      const user = authStore.createUser({
        tenantId: isSuperadmin ? null : tenantId,
        email,
        password: temporaryPassword,
        isSuperadmin: !!isSuperadmin,
      });
      res.status(201).json({ user, temporaryPassword });
    } catch (err) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  router.patch('/:id', requireSuperadmin, (req, res) => {
    const { active } = req.body ?? {};
    if (typeof active !== 'boolean') {
      res.status(400).json({ error: 'active (boolean) is required' });
      return;
    }

    const result = active ? authStore.reactivate(req.params.id) : authStore.deactivate(req.params.id);
    if (!result.ok) {
      if (result.notFound) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(200).json({ user: result.user });
  });

  router.post('/:id/reset-password', requireSuperadmin, (req, res) => {
    const result = authStore.resetPassword(req.params.id);
    if (!result.ok) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    res.status(200).json({ temporaryPassword: result.temporaryPassword });
  });

  return router;
}
