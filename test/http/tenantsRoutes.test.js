import { describe, it, expect, afterEach } from 'vitest';
import { startTestServer, extractCookie } from './helpers/testServer.js';

let ctx;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

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

function tenantPayload(over = {}) {
  return {
    id: 'swift-logistics',
    name: 'Swift Logistics',
    active: true,
    sheetId: 'sheet-1',
    sheetName: 'Orders',
    senderId: 'SwiftLog',
    channel: 'dnd',
    notifyStatuses: ['Out for delivery'],
    templates: { 'Out for delivery': 'Hi {name}' },
    testNumber: '',
    ...over,
  };
}

describe('/api/tenants', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer();
    const res = await fetch(`${ctx.baseUrl}/api/tenants`);
    expect(res.status).toBe(401);
  });

  it('a non-superadmin tenant user gets 403 on every route', async () => {
    ctx = await startTestServer();
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 't1' });

    const get = await fetch(`${ctx.baseUrl}/api/tenants`, { headers: { Cookie: cookie } });
    expect(get.status).toBe(403);

    const post = await fetch(`${ctx.baseUrl}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(tenantPayload()),
    });
    expect(post.status).toBe(403);

    const patch = await fetch(`${ctx.baseUrl}/api/tenants/swift-logistics`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(patch.status).toBe(403);
  });

  describe('as superadmin', () => {
    async function loginSuperadmin(ctx) {
      return loginAsNewUser(ctx, { isSuperadmin: true });
    }

    it('full CRUD happy path', async () => {
      ctx = await startTestServer();
      const { cookie } = await loginSuperadmin(ctx);

      const createRes = await fetch(`${ctx.baseUrl}/api/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(tenantPayload()),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.id).toBe('swift-logistics');

      const listRes = await fetch(`${ctx.baseUrl}/api/tenants`, { headers: { Cookie: cookie } });
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toHaveLength(1);

      const patchRes = await fetch(`${ctx.baseUrl}/api/tenants/swift-logistics`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Swift Renamed' }),
      });
      expect(patchRes.status).toBe(200);
      expect((await patchRes.json()).name).toBe('Swift Renamed');
    });

    it('rejects a senderId conflict on create with 400', async () => {
      ctx = await startTestServer();
      const { cookie } = await loginSuperadmin(ctx);
      await fetch(`${ctx.baseUrl}/api/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(tenantPayload({ id: 'a' })),
      });

      const res = await fetch(`${ctx.baseUrl}/api/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(tenantPayload({ id: 'b' })), // same default senderId
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/shared with another active tenant/);
    });

    it('rejects a senderId conflict on update with 400', async () => {
      ctx = await startTestServer();
      const { cookie } = await loginSuperadmin(ctx);
      await fetch(`${ctx.baseUrl}/api/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(tenantPayload({ id: 'a' })),
      });
      await fetch(`${ctx.baseUrl}/api/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(tenantPayload({ id: 'b', senderId: 'Other11' })),
      });

      const res = await fetch(`${ctx.baseUrl}/api/tenants/b`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ senderId: 'SwiftLog' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown id on PATCH', async () => {
      ctx = await startTestServer();
      const { cookie } = await loginSuperadmin(ctx);
      const res = await fetch(`${ctx.baseUrl}/api/tenants/nonexistent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'X' }),
      });
      expect(res.status).toBe(404);
    });

    it('PATCH { active: false } deactivates -- gone from .load(), still visible via GET /', async () => {
      ctx = await startTestServer();
      const { cookie } = await loginSuperadmin(ctx);
      await fetch(`${ctx.baseUrl}/api/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(tenantPayload()),
      });
      expect(ctx.registry.load()).toHaveLength(1);

      const patchRes = await fetch(`${ctx.baseUrl}/api/tenants/swift-logistics`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ active: false }),
      });
      expect(patchRes.status).toBe(200);
      expect(ctx.registry.load()).toHaveLength(0);

      const listRes = await fetch(`${ctx.baseUrl}/api/tenants`, { headers: { Cookie: cookie } });
      const list = await listRes.json();
      expect(list).toHaveLength(1);
      expect(list[0].active).toBe(false);
    });

    describe('SMS provider secret masking', () => {
      it('POST / and GET / never return the real secret, only a masked form', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);

        const createRes = await fetch(`${ctx.baseUrl}/api/tenants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify(
            tenantPayload({ smsProvider: 'termii', smsCredentials: { apiKey: 'super-secret-key', baseUrl: 'https://x' } }),
          ),
        });
        expect(createRes.status).toBe(201);
        const created = await createRes.json();
        expect(created.smsCredentials.apiKey).not.toBe('super-secret-key');
        expect(created.smsCredentials.apiKey).toMatch(/^••••/);
        expect(created.smsCredentials.baseUrl).toBe('https://x'); // not secret, passes through

        const listRes = await fetch(`${ctx.baseUrl}/api/tenants`, { headers: { Cookie: cookie } });
        const [listed] = await listRes.json();
        expect(listed.smsCredentials.apiKey).not.toBe('super-secret-key');

        // The real value is still what the sending path would actually use.
        const [stored] = ctx.registry.listAll();
        expect(stored.smsCredentials.apiKey).toBe('super-secret-key');
      });

      it('PATCH response is also masked, and a blank secret field preserves the stored real value', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);
        await fetch(`${ctx.baseUrl}/api/tenants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify(
            tenantPayload({ smsProvider: 'termii', smsCredentials: { apiKey: 'real-secret', baseUrl: 'https://x' } }),
          ),
        });

        const patchRes = await fetch(`${ctx.baseUrl}/api/tenants/swift-logistics`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            smsProvider: 'termii',
            smsCredentials: { apiKey: '', baseUrl: 'https://x' }, // blank = keep existing
          }),
        });
        expect(patchRes.status).toBe(200);
        const patched = await patchRes.json();
        expect(patched.smsCredentials.apiKey).not.toBe('real-secret');
        expect(patched.smsCredentials.apiKey).toMatch(/^••••/);

        const [stored] = ctx.registry.listAll();
        expect(stored.smsCredentials.apiKey).toBe('real-secret'); // untouched
      });
    });
  });
});
