// http/routes/orders.js — GET/POST/PATCH /api/orders, tenant-scoped
// (Dashboard UI spec; POST/PATCH added by the Sheets-mode order editing spec).
//
// GET reads live from the tenant's Google Sheet via sheets.readOrders() -- no
// cache, no store of its own. POST/PATCH write straight back to that same
// Sheet (appendOrder/writeOrderFields), so the sheet remains the single
// source of truth and processor.js needs no changes at all: a UI-originated
// edit is indistinguishable from one typed in by hand.

import express from 'express';
import { resolveTenantId } from '../middleware/requireAuth.js';
import { normalisePhone } from '../../phone.js';
import { generateOrderId } from '../../sheets.js';

/**
 * A tenant's own default country code (if set) wins over the global
 * DEFAULT_COUNTRY_CODE -- same resolution order as processor.js's/
 * campaignScheduler.js's own countryCodeFor(tenant), duplicated here rather
 * than imported to keep this route's dependency surface independent
 * (existing project convention).
 * @param {import('../../tenants.js').Tenant} tenant
 * @param {import('../../config.js').Config} config
 * @returns {string}
 */
function countryCodeFor(tenant, config) {
  return tenant.defaultCountryCode || config.defaultCountryCode;
}

/**
 * @param {{
 *   requireAuth: import('express').RequestHandler,
 *   registry: { load: () => import('../../tenants.js').Tenant[] },
 *   sheets: {
 *     readOrders: (sheetId: string, sheetName: string) => Promise<any>,
 *     appendOrder: (sheetId: string, sheetName: string, colIndex: Record<string, number>, fields: object) => Promise<{ rowNumber: number|null }>,
 *     writeOrderFields: (sheetId: string, sheetName: string, rowNumber: number, colIndex: Record<string, number>, fields: object) => Promise<void>,
 *   },
 *   config: import('../../config.js').Config,
 * }} deps
 */
export function createOrdersRoutes({ requireAuth, registry, sheets, config }) {
  const router = express.Router();

  /** Resolve tenantId + tenant row, or send the appropriate error response. Returns null if already handled. */
  function resolveTenant(req, res) {
    const resolved = resolveTenantId(req, req.query);
    if (!resolved.ok) {
      res.status(400).json({ error: 'tenantId is required' });
      return null;
    }
    const tenant = registry.load().find((t) => t.id === resolved.tenantId);
    if (!tenant) {
      res.status(404).json({ error: 'tenant not found' });
      return null;
    }
    return tenant;
  }

  /** sheets.readOrders() can reject outright (bad credentials, network), not just resolve { ok: false } -- both surface as 502, never the generic 500 (spec §orders route, caught live via the dashboard-ui smoke test). Returns null if already handled. */
  async function readOrRespondError(tenant, res) {
    let read;
    try {
      read = await sheets.readOrders(tenant.sheetId, tenant.sheetName);
    } catch (err) {
      res.status(502).json({ error: err?.message ?? String(err) });
      return null;
    }
    if (!read.ok) {
      res.status(502).json({ error: read.error });
      return null;
    }
    return read;
  }

  router.get('/', requireAuth, async (req, res) => {
    const tenant = resolveTenant(req, res);
    if (!tenant) return;
    const read = await readOrRespondError(tenant, res);
    if (!read) return;
    res.status(200).json({
      rows: read.rows,
      columns: Object.keys(read.colIndex),
      notifyStatuses: tenant.notifyStatuses,
    });
  });

  router.post('/', requireAuth, async (req, res) => {
    const tenant = resolveTenant(req, res);
    if (!tenant) return;
    const read = await readOrRespondError(tenant, res);
    if (!read) return;

    const body = req.body ?? {};
    const status = typeof body.status === 'string' ? body.status.trim() : '';
    if (status === '') {
      res.status(400).json({ error: 'status is required' });
      return;
    }
    const cc = typeof body.countryCode === 'string' && body.countryCode.trim() !== '' ? body.countryCode : countryCodeFor(tenant, config);
    const phone = normalisePhone(body.phone, cc);
    if (!phone) {
      res.status(400).json({ error: `invalid phone: ${body.phone}` });
      return;
    }

    const orderId = generateOrderId(new Set(read.rows.map((r) => r.orderId)));
    const fields = { orderId, phone, status };
    if (body.name !== undefined) fields.name = String(body.name);
    if (body.amount !== undefined) fields.amount = String(body.amount);

    const { rowNumber } = await sheets.appendOrder(tenant.sheetId, tenant.sheetName, read.colIndex, fields);
    res.status(201).json({
      rowNumber,
      orderId,
      name: fields.name ?? '',
      phone,
      amount: fields.amount ?? '',
      status,
      lastNotifiedStatus: '',
      lastError: '',
    });
  });

  router.patch('/:rowNumber', requireAuth, async (req, res) => {
    const tenant = resolveTenant(req, res);
    if (!tenant) return;
    const read = await readOrRespondError(tenant, res);
    if (!read) return;

    const rowNumber = Number(req.params.rowNumber);
    const row = read.rows.find((r) => r.rowNumber === rowNumber);
    if (!row) {
      res.status(404).json({ error: 'order not found' });
      return;
    }

    const body = req.body ?? {};
    if (row.orderId !== body.expectedOrderId) {
      res.status(409).json({ error: 'this order changed, please refresh' });
      return;
    }

    const fields = {};
    let phone = row.phone;
    if (body.status !== undefined) {
      const status = typeof body.status === 'string' ? body.status.trim() : '';
      if (status === '') {
        res.status(400).json({ error: 'status is required' });
        return;
      }
      fields.status = status;
    }
    if (body.phone !== undefined) {
      const cc = typeof body.countryCode === 'string' && body.countryCode.trim() !== '' ? body.countryCode : countryCodeFor(tenant, config);
      phone = normalisePhone(body.phone, cc);
      if (!phone) {
        res.status(400).json({ error: `invalid phone: ${body.phone}` });
        return;
      }
      fields.phone = phone;
    }
    if (body.name !== undefined) fields.name = String(body.name);
    if (body.amount !== undefined) fields.amount = String(body.amount);

    await sheets.writeOrderFields(tenant.sheetId, tenant.sheetName, rowNumber, read.colIndex, fields);
    res.status(200).json({ ...row, ...fields, phone });
  });

  return router;
}
