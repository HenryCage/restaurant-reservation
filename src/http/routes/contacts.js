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

  router.patch('/:id', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    const { name, phone, tags, countryCode } = req.body ?? {};
    try {
      const contact = contactsStore.updateContact(resolved.tenantId, req.params.id, { name, phone, tags, countryCode });
      res.status(200).json(contact);
    } catch (err) {
      const message = err?.message ?? String(err);
      res.status(message === 'contact not found' ? 404 : 400).json({ error: message });
    }
  });

  router.delete('/:id', requireAuth, (req, res) => {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    try {
      const deleted = contactsStore.deleteContact(resolved.tenantId, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'contact not found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      // Blocked by campaign history (FK constraint) -- a conflict with
      // existing related data, not a bad request.
      res.status(409).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
