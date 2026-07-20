import { describe, it, expect, afterEach } from 'vitest';
import { startTestServer, extractCookie } from './helpers/testServer.js';

let ctx;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

function fakeRegistry(tenants) {
  return { load: () => tenants };
}

function fakeSheets(bySheetId) {
  const calls = { readOrders: [], appendOrder: [], writeOrderFields: [] };
  return {
    calls,
    async readOrders(sheetId, sheetName) {
      calls.readOrders.push({ sheetId, sheetName });
      const entry = bySheetId[sheetId];
      return typeof entry === 'function' ? entry() : (entry ?? { ok: true, rows: [] });
    },
    async appendOrder(sheetId, sheetName, headerIndex, values) {
      calls.appendOrder.push({ sheetId, sheetName, headerIndex, values });
      return { rowNumber: 99 };
    },
    async writeOrderFields(sheetId, sheetName, rowNumber, headerIndex, values) {
      calls.writeOrderFields.push({ sheetId, sheetName, rowNumber, headerIndex, values });
    },
  };
}

// Matches what parseOrders actually returns: colIndex always has all 8 known
// fields once a read succeeds (6 of them are required), headers is the raw,
// position-aligned header row.
const HEADERS = ['Order ID', 'Customer Name', 'Phone', 'Amount', 'Status', 'Last Notified Status', 'Notified At', 'Last Error'];
const COL_INDEX = { orderId: 0, name: 1, phone: 2, amount: 3, status: 4, lastNotifiedStatus: 5, notifiedAt: 6, lastError: 7 };
const ROLES = {
  orderId: 'Order ID',
  phone: 'Phone',
  status: 'Status',
  lastNotifiedStatus: 'Last Notified Status',
  notifiedAt: 'Notified At',
  lastError: 'Last Error',
};

/** Builds a row fixture's `values` map from HEADERS, filling gaps with ''. */
function rowValues(over = {}) {
  return Object.fromEntries(HEADERS.map((h) => [h, over[h] ?? '']));
}

async function loginAsNewUser(ctx, { tenantId = null, isSuperadmin = false } = {}) {
  const email = `${isSuperadmin ? 'admin' : 'user'}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = ctx.authStore.createUser({ tenantId, email, password: 'original-pw', isSuperadmin });
  ctx.authStore.changePassword(user.id, { currentPassword: 'original-pw', newPassword: 'brand-new-pw' });
  const res = await fetch(`${ctx.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'brand-new-pw' }),
  });
  return { user, cookie: extractCookie(res) };
}

const TENANTS = [
  {
    id: 't1',
    sheetId: 'sheet-t1',
    sheetName: 'Orders',
    notifyStatuses: ['Out for delivery'],
    defaultCountryCode: '',
    googleServiceAccountEmail: 'sa@example.iam.gserviceaccount.com',
    googlePrivateKey: 'fake-key',
  },
  {
    id: 't2',
    sheetId: 'sheet-t2',
    sheetName: 'Orders',
    notifyStatuses: [],
    defaultCountryCode: '',
    googleServiceAccountEmail: 'sa@example.iam.gserviceaccount.com',
    googlePrivateKey: 'fake-key',
  },
];

describe('GET /api/orders', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const res = await fetch(`${ctx.baseUrl}/api/orders`);
    expect(res.status).toBe(401);
  });

  it("a tenant user sees their own fake sheet's headers, rows, roles, and notifyStatuses", async () => {
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        headers: HEADERS,
        rows: [{ rowNumber: 2, orderId: 'O1', values: rowValues({ 'Order ID': 'O1', 'Customer Name': 'Ada', Phone: '+2348012345678', Status: 'Delivered' }) }],
      },
      'sheet-t2': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headers).toEqual(HEADERS);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].orderId).toBe('O1');
    expect(body.rows[0].values['Customer Name']).toBe('Ada');
    expect(body.roles).toEqual(ROLES);
    expect(body.notifyStatuses).toEqual(['Out for delivery']);
    expect(sheets.calls.readOrders).toEqual([{ sheetId: 'sheet-t1', sheetName: 'Orders' }]);
  });

  it('omits a blank header from the response headers list', async () => {
    const headersWithBlank = [...HEADERS, ''];
    const sheets = fakeSheets({
      'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: headersWithBlank, rows: [] },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    const body = await res.json();
    expect(body.headers).toEqual(HEADERS); // blank trailing header filtered out
  });

  it("cannot see another tenant's rows by spoofing ?tenantId=", async () => {
    const sheets = fakeSheets({
      'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [{ rowNumber: 2, orderId: 'O1', values: rowValues() }] },
      'sheet-t2': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [{ rowNumber: 2, orderId: 'O2', values: rowValues() }] },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=t2`, { headers: { Cookie: cookie } });
    const body = await res.json();
    expect(body.rows.map((r) => r.orderId)).toEqual(['O1']); // still t1, spoofed param ignored
  });

  describe('superadmin', () => {
    it('gets 400 without ?tenantId=', async () => {
      ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });
      const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(400);
    });

    it("sees the requested tenant's rows with ?tenantId=", async () => {
      const sheets = fakeSheets({
        'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [{ rowNumber: 2, orderId: 'O1', values: rowValues() }] },
      });
      ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });

      const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=t1`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect((await res.json()).rows.map((r) => r.orderId)).toEqual(['O1']);
    });
  });

  it('an unknown tenant id is 404', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });
    const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=nonexistent`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('a sheets.readOrders failure ({ ok: false }) surfaces as 502, not a crash', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: false, error: 'sheet is empty (no header row)' } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('sheet is empty (no header row)');
  });

  it('a sheets.readOrders rejection (e.g. bad credentials) also surfaces as 502, not a 500', async () => {
    // Found live via the sub-project 3 browser smoke test: a real Google
    // auth failure rejects the promise outright rather than resolving with
    // { ok: false }, which previously fell through to the generic 500
    // handler instead of this route's own 502.
    const sheets = {
      readOrders: async () => {
        throw new Error('invalid_grant: could not sign JWT');
      },
    };
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('invalid_grant: could not sign JWT');
  });

  it('a tenant with no Google credentials configured gets a clear 502, never even calling sheets.readOrders', async () => {
    const unconfigured = [
      { id: 't1', sheetId: 'sheet-t1', sheetName: 'Orders', notifyStatuses: [], defaultCountryCode: '', googleServiceAccountEmail: '', googlePrivateKey: '' },
    ];
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(unconfigured), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Google Sheets is not configured/);
    expect(sheets.calls.readOrders).toHaveLength(0);
  });
});

describe('POST /api/orders', () => {
  it('creates an order: generates an id, normalises phone, leaves service columns blank', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ values: { 'Customer Name': 'Ada', Phone: '08012345678', Amount: '15000', Status: 'Processing' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.orderId).toMatch(/^ORD-\d{8}-[A-Z0-9]{4}$/);
    expect(body.values.Phone).toBe('+2348012345678');
    expect(body.rowNumber).toBe(99); // from the fake's appendOrder response

    expect(sheets.calls.appendOrder).toHaveLength(1);
    const call = sheets.calls.appendOrder[0];
    expect(call.sheetId).toBe('sheet-t1');
    expect(call.values).toMatchObject({ 'Customer Name': 'Ada', Phone: '+2348012345678', Amount: '15000', Status: 'Processing' });
    expect(call.values['Order ID']).toBe(body.orderId);
    // Service columns are never set by this path.
    expect(call.values['Last Notified Status']).toBeUndefined();
  });

  it('an arbitrary column (not part of the known 8) round-trips through create', async () => {
    const headersWithNotes = [...HEADERS, 'Notes'];
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: headersWithNotes, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ values: { Phone: '08012345678', Status: 'Processing', Notes: 'fragile, handle with care' } }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).values.Notes).toBe('fragile, handle with care');
    expect(sheets.calls.appendOrder[0].values.Notes).toBe('fragile, handle with care');
    expect(sheets.calls.appendOrder[0].headerIndex.Notes).toBe(8); // buildHeaderIndex resolved its real position
  });

  it('rejects a values entry for a service-role header', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ values: { Phone: '08012345678', Status: 'Processing', 'Last Notified Status': 'delivered' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be set directly/);
    expect(sheets.calls.appendOrder).toHaveLength(0);
  });

  it('rejects a values entry for the Order ID header', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ values: { 'Order ID': 'SPOOFED', Phone: '08012345678', Status: 'Processing' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be set directly/);
    expect(sheets.calls.appendOrder).toHaveLength(0);
  });

  it('rejects a blank status', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ values: { Phone: '08012345678', Status: '  ' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/status is required/);
    expect(sheets.calls.appendOrder).toHaveLength(0);
  });

  it('rejects an invalid phone', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ values: { Phone: 'not-a-phone', Status: 'Processing' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid phone/);
    expect(sheets.calls.appendOrder).toHaveLength(0);
  });

  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { Phone: '08012345678', Status: 'Processing' } }),
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/orders/:rowNumber', () => {
  it('edits only the provided fields and leaves the rest untouched', async () => {
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        headers: HEADERS,
        rows: [{ rowNumber: 2, orderId: 'ORD-1', values: rowValues({ 'Order ID': 'ORD-1', 'Customer Name': 'Ada', Phone: '+2348012345678', Status: 'Processing' }) }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', values: { Status: 'Delivered' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.values.Status).toBe('Delivered');
    expect(body.values['Customer Name']).toBe('Ada'); // untouched

    expect(sheets.calls.writeOrderFields).toHaveLength(1);
    expect(sheets.calls.writeOrderFields[0].values).toEqual({ Status: 'Delivered' });
  });

  it('an arbitrary column edits through the same generic path', async () => {
    const headersWithNotes = [...HEADERS, 'Notes'];
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        headers: headersWithNotes,
        rows: [{ rowNumber: 2, orderId: 'ORD-1', values: { ...rowValues({ 'Order ID': 'ORD-1' }), Notes: 'old note' } }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', values: { Notes: 'new note' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).values.Notes).toBe('new note');
    expect(sheets.calls.writeOrderFields[0].values).toEqual({ Notes: 'new note' });
  });

  it('rejects a values entry for a service-role header', async () => {
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        headers: HEADERS,
        rows: [{ rowNumber: 2, orderId: 'ORD-1', values: rowValues({ 'Order ID': 'ORD-1' }) }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', values: { 'Notified At': '2026-01-01' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be set directly/);
    expect(sheets.calls.writeOrderFields).toHaveLength(0);
  });

  it('404s for a row number that no longer exists', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, headers: HEADERS, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', values: { Status: 'Delivered' } }),
    });
    expect(res.status).toBe(404);
    expect(sheets.calls.writeOrderFields).toHaveLength(0);
  });

  it('409s when expectedOrderId no longer matches the row (concurrency check)', async () => {
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        headers: HEADERS,
        rows: [{ rowNumber: 2, orderId: 'ORD-2-SOMEONE-ELSE', values: rowValues({ 'Order ID': 'ORD-2-SOMEONE-ELSE' }) }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', values: { Status: 'Delivered' } }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/this order changed/);
    expect(sheets.calls.writeOrderFields).toHaveLength(0);
  });

  it('rejects an invalid phone on edit', async () => {
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        headers: HEADERS,
        rows: [{ rowNumber: 2, orderId: 'ORD-1', values: rowValues({ 'Order ID': 'ORD-1' }) }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', values: { Phone: 'nope' } }),
    });
    expect(res.status).toBe(400);
    expect(sheets.calls.writeOrderFields).toHaveLength(0);
  });

  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', values: { Status: 'Delivered' } }),
    });
    expect(res.status).toBe(401);
  });
});
