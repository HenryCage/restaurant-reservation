// http/routes/campaigns.js — GET/POST /api/campaigns, tenant-scoped (Customer-auth spec).

import express from 'express';
import { resolveTenantId } from '../middleware/requireAuth.js';

/**
 * @param {{
 *   requireAuth: import('express').RequestHandler,
 *   campaignsStore: ReturnType<typeof import('../../campaigns.js').createCampaignsStore>,
 * }} deps
 */
export function createCampaignsRoutes({ requireAuth, campaignsStore }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    res.status(200).json(campaignsStore.listCampaigns(resolved.tenantId));
  });

  router.post('/', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    const { name, message, sendTo, scheduledTime } = req.body ?? {};
    try {
      const campaign = campaignsStore.createCampaign(resolved.tenantId, { name, message, sendTo, scheduledTime });
      res.status(201).json(campaign);
    } catch (err) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
