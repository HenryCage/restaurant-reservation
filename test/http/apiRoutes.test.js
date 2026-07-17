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

  it('creates a contact using a countryCode other than the server default', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const createRes = await fetch(`${ctx.baseUrl}/api/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Rimas', phone: '60012345', countryCode: '370' }),
    });
    expect(createRes.status).toBe(201);
    expect((await createRes.json()).phone).toBe('+37060012345');
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

describe('GET /api/status', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer();
    const res = await fetch(`${ctx.baseUrl}/api/status`);
    expect(res.status).toBe(401);
  });

  it('404s when the tenant does not exist in the registry', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const res = await fetch(`${ctx.baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('reports providerConfigured: false and no overrides for a freshly-created tenant', async () => {
    ctx = await startTestServer();
    ctx.registry.create({
      id: 't1',
      name: 'Acme',
      active: true,
      sheetId: 'sheet1',
      senderId: 'ACMESENDER',
      notifyStatuses: ['Delivered'],
      templates: { delivered: 'Hi {name}' },
    });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providerConfigured: false, dryRun: false, testOverrideActive: false });
  });

  it('reports providerConfigured: true once an SMS provider is configured', async () => {
    ctx = await startTestServer();
    ctx.registry.create({
      id: 't1',
      name: 'Acme',
      active: true,
      sheetId: 'sheet1',
      senderId: 'ACMESENDER',
      notifyStatuses: ['Delivered'],
      templates: { delivered: 'Hi {name}' },
      smsProvider: 'termii',
      smsCredentials: { apiKey: 'secret-key', baseUrl: 'https://termii.example' },
    });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerConfigured).toBe(true);
    expect(body).not.toHaveProperty('smsCredentials'); // never leaks secrets
  });

  it('reports testOverrideActive: true when the tenant has its own testNumber set', async () => {
    ctx = await startTestServer();
    ctx.registry.create({
      id: 't1',
      name: 'Acme',
      active: true,
      sheetId: 'sheet1',
      senderId: 'ACMESENDER',
      notifyStatuses: ['Delivered'],
      templates: { delivered: 'Hi {name}' },
      testNumber: '+2348000000000',
    });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect((await res.json()).testOverrideActive).toBe(true);
  });

  it('reports dryRun: true when the server is running in dry-run mode', async () => {
    ctx = await startTestServer({ configOverrides: { dryRun: true } });
    ctx.registry.create({
      id: 't1',
      name: 'Acme',
      active: true,
      sheetId: 'sheet1',
      senderId: 'ACMESENDER',
      notifyStatuses: ['Delivered'],
      templates: { delivered: 'Hi {name}' },
    });
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const res = await fetch(`${ctx.baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect((await res.json()).dryRun).toBe(true);
  });
});

describe('PATCH/DELETE /api/contacts/:id', () => {
  it('updates a contact', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const contact = ctx.contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });

    const res = await fetch(`${ctx.baseUrl}/api/contacts/${contact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Ada Lovelace' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('Ada Lovelace');
  });

  it('404s updating another tenant\'s contact', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const contact = ctx.contactsStore.createContact('t2', { name: 'Bola', phone: '+2348023456789' });

    const res = await fetch(`${ctx.baseUrl}/api/contacts/${contact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('deletes a contact', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const contact = ctx.contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });

    const res = await fetch(`${ctx.baseUrl}/api/contacts/${contact.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(res.status).toBe(204);
    expect(ctx.contactsStore.listContacts('t1')).toHaveLength(0);
  });

  it('404s deleting a nonexistent contact', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const res = await fetch(`${ctx.baseUrl}/api/contacts/nonexistent`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });

  it('409s deleting a contact with existing campaign history', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const contact = ctx.contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    const campaign = ctx.campaignsStore.createCampaign('t1', {
      name: 'Promo',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2025-01-01T00:00:00.000Z',
    });
    ctx.campaignsStore.ensureRecipients(campaign.id, 't1', 'all');

    const res = await fetch(`${ctx.baseUrl}/api/contacts/${contact.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/existing campaign history/);
  });

  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer();
    const res = await fetch(`${ctx.baseUrl}/api/contacts/some-id`, { method: 'PATCH' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/campaigns/:id, POST /:id/cancel, GET /:id/recipients', () => {
  it('updates a pending campaign', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const campaign = ctx.campaignsStore.createCampaign('t1', {
      name: 'Promo',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2099-01-01T00:00:00.000Z',
    });

    const res = await fetch(`${ctx.baseUrl}/api/campaigns/${campaign.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Promo v2' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('Promo v2');
  });

  it('404s updating another tenant\'s campaign', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const campaign = ctx.campaignsStore.createCampaign('t2', {
      name: 'Promo',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2099-01-01T00:00:00.000Z',
    });

    const res = await fetch(`${ctx.baseUrl}/api/campaigns/${campaign.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('cancels a pending campaign', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const campaign = ctx.campaignsStore.createCampaign('t1', {
      name: 'Promo',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2099-01-01T00:00:00.000Z',
    });

    const res = await fetch(`${ctx.baseUrl}/api/campaigns/${campaign.id}/cancel`, { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
  });

  it('400s cancelling a campaign that is no longer pending', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    ctx.contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    const campaign = ctx.campaignsStore.createCampaign('t1', {
      name: 'Promo',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2020-01-01T00:00:00.000Z',
    });
    ctx.campaignsStore.ensureRecipients(campaign.id, 't1', 'all'); // flips to 'processing'

    const res = await fetch(`${ctx.baseUrl}/api/campaigns/${campaign.id}/cancel`, { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });

  it('lists per-recipient outcomes for a campaign', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    ctx.contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    const campaign = ctx.campaignsStore.createCampaign('t1', {
      name: 'Promo',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2020-01-01T00:00:00.000Z',
    });
    ctx.campaignsStore.ensureRecipients(campaign.id, 't1', 'all');

    const res = await fetch(`${ctx.baseUrl}/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const recipients = await res.json();
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ phone: '+2348012345678', status: 'pending' });
  });

  it('404s listing recipients for another tenant\'s campaign', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });
    const campaign = ctx.campaignsStore.createCampaign('t2', {
      name: 'Promo',
      message: 'hi',
      sendTo: 'all',
      scheduledTime: '2099-01-01T00:00:00.000Z',
    });

    const res = await fetch(`${ctx.baseUrl}/api/campaigns/${campaign.id}/recipients`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
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
