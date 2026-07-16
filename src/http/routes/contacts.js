// http/routes/contacts.js — GET/POST /api/contacts, tenant-scoped (Customer-auth spec).

import express from 'express';
import { resolveTenantId } from '../middleware/requireAuth.js';

/**
 * @param {{
 *   requireAuth: import('express').RequestHandler,
 *   contactsStore: ReturnType<typeof import('../../contacts.js').createContactsStore>,
 * }} deps
 */
export function createContactsRoutes({ requireAuth, contactsStore }) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    res.status(200).json(contactsStore.listContacts(resolved.tenantId));
  });

  router.post('/', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    const { name, phone, tags, countryCode } = req.body ?? {};
    try {
      const contact = contactsStore.createContact(resolved.tenantId, { name, phone, tags, countryCode });
      res.status(201).json(contact);
    } catch (err) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
