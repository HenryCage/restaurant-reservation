import { describe, it, expect, afterEach } from 'vitest';
import { startTestServer, extractCookie } from './helpers/testServer.js';

let ctx;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

/** Creates a ready-to-use (password already changed) user and logs in, returning the cookie. */
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

describe('GET/POST /api/contacts', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer();
    const res = await fetch(`${ctx.baseUrl}/api/contacts`);
    expect(res.status).toBe(401);
  });

  it('a tenant user can create and then list their own contacts', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const createRes = await fetch(`${ctx.baseUrl}/api/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Ada', phone: '+2348012345678' }),
    });
    expect(createRes.status).toBe(201);
    expect((await createRes.json()).phone).toBe('+2348012345678');

    const listRes = await fetch(`${ctx.baseUrl}/api/contacts`, { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Ada');
  });

  it('cannot see another tenant\'s contacts by spoofing ?tenantId=', async () => {
    ctx = await startTestServer();
    ctx.contactsStore.createContact('t2', { name: 'Other tenant contact', phone: '+2348023456789' });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/contacts?tenantId=t2`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]); // still scoped to t1, the spoofed param is ignored
  });

  it('a duplicate contact surfaces as 400 with the store error message', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const body = JSON.stringify({ name: 'Ada', phone: '+2348012345678' });
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body };

    await fetch(`${ctx.baseUrl}/api/contacts`, opts);
    const second = await fetch(`${ctx.baseUrl}/api/contacts`, opts);
    expect(second.status).toBe(400);
    expect((await second.json()).error).toMatch(/already exists/);
  });

  describe('superadmin', () => {
    it('gets 400 without ?tenantId=', async () => {
      ctx = await startTestServer();
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });
      const res = await fetch(`${ctx.baseUrl}/api/contacts`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(400);
    });

    it('sees the requested tenant\'s data with ?tenantId=', async () => {
      ctx = await startTestServer();
      ctx.contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const { cookie } = await loginAsNewUser(ctx, { isSuperadmin: true });

      const res = await fetch(`${ctx.baseUrl}/api/contacts?tenantId=t1`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(1);
    });
  });
});

describe('GET/POST /api/campaigns', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer();
    const res = await fetch(`${ctx.baseUrl}/api/campaigns`);
    expect(res.status).toBe(401);
  });

  it('a tenant user can create and then list their own campaigns', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const createRes = await fetch(`${ctx.baseUrl}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Promo', message: 'hello', sendTo: 'all', scheduledTime: '2099-01-01T00:00:00.000Z' }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await fetch(`${ctx.baseUrl}/api/campaigns`, { headers: { Cookie: cookie } });
    const list = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Promo');
  });

  it('an unknown sendTo contact surfaces as 400 with the store error message', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Promo', message: 'hi', sendTo: 'nonexistent-id', scheduledTime: '2099-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a known contact/);
  });

  it('cannot see another tenant\'s campaigns by spoofing ?tenantId=', async () => {
    ctx = await startTestServer();
    ctx.campaignsStore.createCampaign('t2', {
      name: 'Other tenant campaign',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2099-01-01T00:00:00.000Z',
    });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/campaigns?tenantId=t2`, { headers: { Cookie: cookie } });
    expect(await res.json()).toEqual([]);
  });
});
