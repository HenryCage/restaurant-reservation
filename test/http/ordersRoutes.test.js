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
  const calls = [];
  return {
    calls,
    async readOrders(sheetId, sheetName) {
      calls.push({ sheetId, sheetName });
      const entry = bySheetId[sheetId];
      return typeof entry === 'function' ? entry() : (entry ?? { ok: true, rows: [] });
    },
  };
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
  { id: 't1', sheetId: 'sheet-t1', sheetName: 'Orders' },
  { id: 't2', sheetId: 'sheet-t2', sheetName: 'Orders' },
];

describe('GET /api/orders', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const res = await fetch(`${ctx.baseUrl}/api/orders`);
    expect(res.status).toBe(401);
  });

  it("a tenant user sees their own fake sheet's rows", async () => {
    const sheets = fakeSheets({
      'sheet-t1': { ok: true, rows: [{ orderId: 'O1', name: 'Ada', phone: '+2348012345678', status: 'Delivered' }] },
      'sheet-t2': { ok: true, rows: [{ orderId: 'O2', name: 'Bola' }] },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].orderId).toBe('O1');
    expect(sheets.calls).toEqual([{ sheetId: 'sheet-t1', sheetName: 'Orders' }]);
  });

  it("cannot see another tenant's rows by spoofing ?tenantId=", async () => {
    const sheets = fakeSheets({
      'sheet-t1': { ok: true, rows: [{ orderId: 'O1' }] },
      'sheet-t2': { ok: true, rows: [{ orderId: 'O2' }] },
    });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=t2`, { headers: { Cookie: cookie } });
    const body = await res.json();
    expect(body).toEqual([{ orderId: 'O1' }]); // still t1, spoofed param ignored
  });

  describe('superadmin', () => {
    it('gets 400 without ?tenantId=', async () => {
      ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });
      const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(400);
    });

    it("sees the requested tenant's rows with ?tenantId=", async () => {
      const sheets = fakeSheets({ 'sheet-t1': { ok: true, rows: [{ orderId: 'O1' }] } });
      ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });

      const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=t1`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ orderId: 'O1' }]);
    });
  });

  it('an unknown tenant id is 404', async () => {
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS) });
    const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });
    const res = await fetch(`${ctx.baseUrl}/api/orders?tenantId=nonexistent`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('a sheets.readOrders failure surfaces as 502, not a crash', async () => {
    const sheets = fakeSheets({ 'sheet-t1': { ok: false, error: 'sheet is empty (no header row)' } });
    ctx = await startTestServer({ registry: fakeRegistry(TENANTS), sheets });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/orders`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('sheet is empty (no header row)');
  });
});
