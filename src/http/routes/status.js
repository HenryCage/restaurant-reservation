// http/routes/status.js — GET /api/status, tenant-scoped.
//
// Surfaces just enough of the send configuration for a *tenant user* (not
// just a superadmin) to understand why their messages might not actually be
// reaching real phones -- no SMS provider configured, DRY_RUN, or a test
// number override in effect all look identical from the tenant's side
// ("nothing happened") without this. Never exposes secrets: only booleans
// derived from config/tenant fields, never the credentials or the override
// number itself.

import express from 'express';
import { resolveTenantId } from '../middleware/requireAuth.js';

/**
 * @param {{
 *   requireAuth: import('express').RequestHandler,
 *   registry: { load: () => import('../../tenants.js').Tenant[] },
 *   config: import('../../config.js').Config,
 * }} deps
 */
export function createStatusRoutes({ requireAuth, registry, config }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }

    const tenant = registry.load().find((t) => t.id === resolved.tenantId);
    if (!tenant) {
      res.status(404).json({ error: 'tenant not found' });
      return;
    }

    res.status(200).json({
      providerConfigured: tenant.smsProvider !== '',
      dryRun: config.dryRun,
      // Mirrors processor.js/campaignScheduler.js's own resolveRecipient()
      // override precedence: the (production-gated) global test number wins,
      // otherwise this tenant's own testNumber.
      testOverrideActive: Boolean(config.effectiveGlobalTestNumber || tenant.testNumber),
    });
  });

  return router;
}
