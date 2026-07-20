// http/routes/orders.js — GET/POST/PATCH /api/orders, tenant-scoped
// (Dashboard UI spec; POST/PATCH added by the Sheets-mode order editing
// spec; the generic header-driven `values` shape added by the Orders
// column-parity spec).
//
// GET reads live from the tenant's Google Sheet via sheets.readOrders() -- no
// cache, no store of its own. POST/PATCH write straight back to that same
// Sheet (appendOrder/writeOrderFields), so the sheet remains the single
// source of truth and processor.js needs no changes at all: a UI-originated
// edit is indistinguishable from one typed in by hand.
//
// Orders are represented generically as `values` (a map of that tenant's own
// header text -> cell value) rather than a fixed set of named fields, so the
// dashboard mirrors whatever columns a tenant's sheet actually has, in the
// sheet's own order. `roles` tells the client which real header plays which
// special part (phone/status need particular treatment; Order ID and the 3
// service columns are never client-writable).

import express from 'express';
import { resolveTenantId } from '../middleware/requireAuth.js';
import { normalisePhone } from '../../phone.js';
import { generateOrderId, buildRoles, buildHeaderIndex, SERVICE_FIELDS } from '../../sheets.js';

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
 *   sheetsClientFactory: { forTenant: (tenant: import('../../tenants.js').Tenant) => {
 *     readOrders: (sheetId: string, sheetName: string) => Promise<any>,
 *     appendOrder: (sheetId: string, sheetName: string, headerIndex: Record<string, number>, values: object) => Promise<{ rowNumber: number|null }>,
 *     writeOrderFields: (sheetId: string, sheetName: string, rowNumber: number, headerIndex: Record<string, number>, values: object) => Promise<void>,
 *   } },
 *   config: import('../../config.js').Config,
 * }} deps
 */
export function createOrdersRoutes({ requireAuth, registry, sheetsClientFactory, config }) {
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

  /** A tenant with no Google credentials configured gets a clear, distinct error rather than a confusing generic read failure (Per-tenant Google credentials spec -- mirrors "no SMS provider configured"). Returns null if already handled. */
  function sheetsForTenant(tenant, res) {
    if (tenant.googleServiceAccountEmail === '' || tenant.googlePrivateKey === '') {
      res.status(502).json({ error: 'Google Sheets is not configured for this tenant' });
      return null;
    }
    return sheetsClientFactory.forTenant(tenant);
  }

  /** sheets.readOrders() can reject outright (bad credentials, network), not just resolve { ok: false } -- both surface as 502, never the generic 500 (spec §orders route, caught live via the dashboard-ui smoke test). Returns null if already handled. */
  async function readOrRespondError(sheets, tenant, res) {
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

  /**
   * Validate/normalise the status and phone entries of an incoming `values`
   * map in place, using `roles` to find the right keys. `require` controls
   * whether a missing key is itself an error (create) or just skipped
   * (partial edit -- only validate what's actually being changed).
   * Returns an error message string, or null if valid.
   */
  function validateValues(values, roles, tenant, body, { require }) {
    if (require || roles.status in values) {
      const status = typeof values[roles.status] === 'string' ? values[roles.status].trim() : '';
      if (status === '') return 'status is required';
      values[roles.status] = status;
    }
    if (require || roles.phone in values) {
      const cc = typeof body.countryCode === 'string' && body.countryCode.trim() !== '' ? body.countryCode : countryCodeFor(tenant, config);
      const phone = normalisePhone(values[roles.phone], cc);
      if (!phone) return `invalid phone: ${values[roles.phone]}`;
      values[roles.phone] = phone;
    }
    return null;
  }

  /** Reject any attempt to write a service-owned or server-controlled header directly. Returns the offending header, or null if clean. */
  function forbiddenHeaderIn(values, roles) {
    const forbidden = [roles.orderId, ...SERVICE_FIELDS.map((f) => roles[f])];
    return forbidden.find((header) => header in values) ?? null;
  }

  router.get('/', requireAuth, async (req, res) => {
    const tenant = resolveTenant(req, res);
    if (!tenant) return;
    const sheets = sheetsForTenant(tenant, res);
    if (!sheets) return;
    const read = await readOrRespondError(sheets, tenant, res);
    if (!read) return;
    res.status(200).json({
      headers: read.headers.filter((h) => h !== ''),
      rows: read.rows.map((r) => ({ rowNumber: r.rowNumber, orderId: r.orderId, values: r.values })),
      roles: buildRoles(read.headers, read.colIndex),
      notifyStatuses: tenant.notifyStatuses,
    });
  });

  router.post('/', requireAuth, async (req, res) => {
    const tenant = resolveTenant(req, res);
    if (!tenant) return;
    const sheets = sheetsForTenant(tenant, res);
    if (!sheets) return;
    const read = await readOrRespondError(sheets, tenant, res);
    if (!read) return;

    const roles = buildRoles(read.headers, read.colIndex);
    const body = req.body ?? {};
    const values = body.values && typeof body.values === 'object' ? { ...body.values } : {};

    const forbidden = forbiddenHeaderIn(values, roles);
    if (forbidden) {
      res.status(400).json({ error: `"${forbidden}" cannot be set directly` });
      return;
    }
    const error = validateValues(values, roles, tenant, body, { require: true });
    if (error) {
      res.status(400).json({ error });
      return;
    }

    const orderId = generateOrderId(new Set(read.rows.map((r) => r.orderId)));
    values[roles.orderId] = orderId;

    const { rowNumber } = await sheets.appendOrder(tenant.sheetId, tenant.sheetName, buildHeaderIndex(read.headers), values);
    res.status(201).json({ rowNumber, orderId, values });
  });

  router.patch('/:rowNumber', requireAuth, async (req, res) => {
    const tenant = resolveTenant(req, res);
    if (!tenant) return;
    const sheets = sheetsForTenant(tenant, res);
    if (!sheets) return;
    const read = await readOrRespondError(sheets, tenant, res);
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

    const roles = buildRoles(read.headers, read.colIndex);
    const values = body.values && typeof body.values === 'object' ? { ...body.values } : {};

    const forbidden = forbiddenHeaderIn(values, roles);
    if (forbidden) {
      res.status(400).json({ error: `"${forbidden}" cannot be set directly` });
      return;
    }
    const error = validateValues(values, roles, tenant, body, { require: false });
    if (error) {
      res.status(400).json({ error });
      return;
    }

    await sheets.writeOrderFields(tenant.sheetId, tenant.sheetName, rowNumber, buildHeaderIndex(read.headers), values);
    res.status(200).json({ rowNumber, orderId: row.orderId, values: { ...row.values, ...values } });
  });

  return router;
}
