// http/routes/tenants.js — GET/POST /api/tenants, PATCH /api/tenants/:id (Tenant management spec).
//
// Superadmin-only, cross-tenant by nature -- no resolveTenantId/tenant
// scoping involved, unlike every other /api/* route.

import express from 'express';
import { maskSmsCredentials, maskGooglePrivateKey } from '../../tenants.js';

/**
 * Applied only at the HTTP response boundary (Per-tenant SMS provider /
 * Per-tenant Google credentials specs) -- the underlying stored value and
 * the sending/reading path never see this.
 * @param {any} tenant
 */
function maskTenant(tenant) {
  return {
    ...tenant,
    smsCredentials: maskSmsCredentials(tenant.smsProvider, tenant.smsCredentials),
    googlePrivateKey: maskGooglePrivateKey(tenant.googlePrivateKey),
  };
}

/**
 * @param {{
 *   requireSuperadmin: import('express').RequestHandler,
 *   registry: ReturnType<typeof import('../../tenants.js').createTenantRegistry>,
 * }} deps
 */
export function createTenantsRoutes({ requireSuperadmin, registry }) {
  const router = express.Router();

  router.get('/', requireSuperadmin, (req, res) => {
    // Every tenant, active or not -- the admin view needs deactivated ones
    // visible, to be able to reactivate them.
    res.status(200).json(registry.listAll().map(maskTenant));
  });

  router.post('/', requireSuperadmin, (req, res) => {
    const result = registry.create(req.body ?? {});
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(maskTenant(result.tenant));
  });

  router.patch('/:id', requireSuperadmin, (req, res) => {
    // Partial/merge update -- the body carries only the fields being
    // changed. Includes `active`: this is also how deactivation/
    // reactivation works, no separate endpoint needed.
    const result = registry.update(req.params.id, req.body ?? {});
    if (!result.ok) {
      if (result.notFound) {
        res.status(404).json({ error: 'tenant not found' });
        return;
      }
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(200).json(maskTenant(result.tenant));
  });

  return router;
}
