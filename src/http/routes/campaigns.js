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

  router.patch('/:id', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    const { name, message, sendTo, scheduledTime } = req.body ?? {};
    try {
      const campaign = campaignsStore.updateCampaign(resolved.tenantId, req.params.id, { name, message, sendTo, scheduledTime });
      res.status(200).json(campaign);
    } catch (err) {
      const msg = err?.message ?? String(err);
      res.status(msg === 'campaign not found' ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/:id/cancel', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    try {
      const campaign = campaignsStore.cancelCampaign(resolved.tenantId, req.params.id);
      res.status(200).json(campaign);
    } catch (err) {
      const msg = err?.message ?? String(err);
      res.status(msg === 'campaign not found' ? 404 : 400).json({ error: msg });
    }
  });

  router.get('/:id/recipients', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    const recipients = campaignsStore.listRecipients(resolved.tenantId, req.params.id);
    if (recipients === null) {
      res.status(404).json({ error: 'campaign not found' });
      return;
    }
    res.status(200).json(recipients);
  });

  return router;
}
