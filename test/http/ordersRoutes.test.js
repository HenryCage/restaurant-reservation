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
    async appendOrder(sheetId, sheetName, colIndex, fields) {
      calls.appendOrder.push({ sheetId, sheetName, colIndex, fields });
      return { rowNumber: 99 };
    },
    async writeOrderFields(sheetId, sheetName, rowNumber, colIndex, fields) {
      calls.writeOrderFields.push({ sheetId, sheetName, rowNumber, colIndex, fields });
    },
  };
}

const COL_INDEX = { orderId: 0, name: 1, phone: 2, amount: 3, status: 4 };

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
  { id: 't1', sheetId: 'sheet-t1', sheetName: 'Orders', notifyStatuses: ['Out for delivery'], defaultCountryCode: '' },
  { id: 't2', sheetId: 'sheet-t2', sheetName: 'Orders', notifyStatuses: [], defaultCountryCode: '' },
];

describe('GET /api/orders', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const res = await fetch(`${ctx.baseUrl}/api/orders`);
    expect(res.status).toBe(401);
  });

  it("a tenant user sees their own fake sheet's rows, columns, and notifyStatuses", async () => {
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        rows: [{ orderId: 'O1', name: 'Ada', phone: '+2348012345678', status: 'Delivered' }],
      },
      'sheet-t2': { ok: true, colIndex: COL_INDEX, rows: [{ orderId: 'O2', name: 'Bola' }] },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].orderId).toBe('O1');
    expect(body.columns).toEqual(Object.keys(COL_INDEX));
    expect(body.notifyStatuses).toEqual(['Out for delivery']);
    expect(sheets.calls.readOrders).toEqual([{ sheetId: 'sheet-t1', sheetName: 'Orders' }]);
  });

  it("cannot see another tenant's rows by spoofing ?tenantId=", async () => {
    const sheets = fakeSheets({
      'sheet-t1': { ok: true, colIndex: COL_INDEX, rows: [{ orderId: 'O1' }] },
      'sheet-t2': { ok: true, colIndex: COL_INDEX, rows: [{ orderId: 'O2' }] },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=t2`, { headers: { Cookie: cookie } });
    const body = await res.json();
    expect(body.rows).toEqual([{ orderId: 'O1' }]); // still t1, spoofed param ignored
  });

  describe('superadmin', () => {
    it('gets 400 without ?tenantId=', async () => {
      ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });
      const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(400);
    });

    it("sees the requested tenant's rows with ?tenantId=", async () => {
      const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, rows: [{ orderId: 'O1' }] } });
      ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });

      const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=t1`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect((await res.json()).rows).toEqual([{ orderId: 'O1' }]);
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
});

describe('POST /api/orders', () => {
  it('creates an order: generates an id, normalises phone, leaves service columns blank', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Ada', phone: '08012345678', amount: '15000', status: 'Processing' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.orderId).toMatch(/^ORD-\d{8}-[A-Z0-9]{4}$/);
    expect(body.phone).toBe('+2348012345678');
    expect(body.rowNumber).toBe(99); // from the fake's appendOrder response
    expect(body.lastNotifiedStatus).toBe('');

    expect(sheets.calls.appendOrder).toHaveLength(1);
    const call = sheets.calls.appendOrder[0];
    expect(call.sheetId).toBe('sheet-t1');
    expect(call.fields).toMatchObject({ name: 'Ada', phone: '+2348012345678', amount: '15000', status: 'Processing' });
  });

  it('rejects a blank status', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ phone: '08012345678', status: '  ' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/status is required/);
    expect(sheets.calls.appendOrder).toHaveLength(0);
  });

  it('rejects an invalid phone', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ phone: 'not-a-phone', status: 'Processing' }),
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
      body: JSON.stringify({ phone: '08012345678', status: 'Processing' }),
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
        rows: [{ rowNumber: 2, orderId: 'ORD-1', name: 'Ada', phone: '+2348012345678', status: 'Processing' }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', status: 'Delivered' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Delivered');
    expect(body.name).toBe('Ada'); // untouched

    expect(sheets.calls.writeOrderFields).toHaveLength(1);
    expect(sheets.calls.writeOrderFields[0].fields).toEqual({ status: 'Delivered' });
  });

  it('404s for a row number that no longer exists', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: true, colIndex: COL_INDEX, rows: [] } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', status: 'Delivered' }),
    });
    expect(res.status).toBe(404);
    expect(sheets.calls.writeOrderFields).toHaveLength(0);
  });

  it('409s when expectedOrderId no longer matches the row (concurrency check)', async () => {
    const sheets = fakeSheets({
      'sheet-t1': {
        ok: true,
        colIndex: COL_INDEX,
        rows: [{ rowNumber: 2, orderId: 'ORD-2-SOMEONE-ELSE', name: 'Bola', phone: '+2348012345678', status: 'Processing' }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', status: 'Delivered' }),
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
        rows: [{ rowNumber: 2, orderId: 'ORD-1', name: 'Ada', phone: '+2348012345678', status: 'Processing' }],
      },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', phone: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(sheets.calls.writeOrderFields).toHaveLength(0);
  });

  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const res = await fetch(`${ctx.baseUrl}/api/orders/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedOrderId: 'ORD-1', status: 'Delivered' }),
    });
    expect(res.status).toBe(401);
  });
});
