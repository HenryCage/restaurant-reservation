// http/routes/orders.js — GET /api/orders, tenant-scoped (Dashboard UI spec).
//
// Reads live from the tenant's Google Sheet via the existing
// sheets.readOrders() -- no cache, no store of its own. The sheet remains
// the single source of truth, same principle as the rest of the system.

import express from 'express';
import { resolveTenantId } from '../middleware/requireAuth.js';

/**
 * @param {{
 *   requireAuth: import('express').RequestHandler,
 *   registry: { load: () => import('../../tenants.js').Tenant[] },
 *   sheets: { readOrders: (sheetId: string, sheetName: string) => Promise<any> },
 * }} deps
 */
export function createOrdersRoutes({ requireAuth, registry, sheets }) {
  const router = express.Router();

  router.get('/', requireAuth, async (req, res) => {
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

    const read = await sheets.readOrders(tenant.sheetId, tenant.sheetName);
    if (!read.ok) {
      res.status(502).json({ error: read.error });
      return;
    }
    res.status(200).json(read.rows);
  });

  return router;
}
