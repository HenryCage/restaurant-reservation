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
  return { user, email, cookie: extractCookie(res) };
}

function seedTenant(ctx, id = 'swift-logistics') {
  // senderId must be 3-11 alphanumeric chars -- derive a valid one from id.
  const senderId = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 11).padEnd(3, 'x');
  const result = ctx.registry.create({
    id,
    name: 'Swift Logistics',
    active: true,
    sheetId: 'sheet-1',
    sheetName: 'Orders',
    senderId,
    channel: 'dnd',
    notifyStatuses: ['Out for delivery'],
    templates: { 'Out for delivery': 'Hi {name}' },
    testNumber: '',
  });
  if (!result.ok) throw new Error(`seedTenant failed: ${result.error}`);
  return result.tenant;
}

async function postJson(ctx, path, body, cookie) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function patchJson(ctx, path, body, cookie) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe('/api/users', () => {
  it('an unauthenticated request is 401', async () => {
    ctx = await startTestServer();
    const res = await fetch(`${ctx.baseUrl}/api/users?superadmins=true`);
    expect(res.status).toBe(401);
  });

  it('a non-superadmin tenant user gets 403 on every route', async () => {
    ctx = await startTestServer();
    seedTenant(ctx);
    const { cookie } = await loginAsNewUser(ctx, { tenantId: 'swift-logistics' });

    expect((await fetch(`${ctx.baseUrl}/api/users?tenantId=swift-logistics`, { headers: { Cookie: cookie } })).status).toBe(403);
    expect((await postJson(ctx, '/api/users', { tenantId: 'swift-logistics', email: 'x@example.com' }, cookie)).status).toBe(403);
    expect((await patchJson(ctx, '/api/users/whatever', { active: false }, cookie)).status).toBe(403);
    expect((await postJson(ctx, '/api/users/whatever/reset-password', {}, cookie)).status).toBe(403);
  });

  describe('as superadmin', () => {
    async function loginSuperadmin(ctx) {
      return loginAsNewUser(ctx, { isSuperadmin: true });
    }

    describe('GET /', () => {
      it('400s when neither tenantId nor superadmins is given', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);
        const res = await fetch(`${ctx.baseUrl}/api/users`, { headers: { Cookie: cookie } });
        expect(res.status).toBe(400);
      });

      it('400s when both tenantId and superadmins are given', async () => {
        ctx = await startTestServer();
        seedTenant(ctx);
        const { cookie } = await loginSuperadmin(ctx);
        const res = await fetch(`${ctx.baseUrl}/api/users?tenantId=swift-logistics&superadmins=true`, {
          headers: { Cookie: cookie },
        });
        expect(res.status).toBe(400);
      });

      it('?tenantId= returns only that tenant\'s users', async () => {
        ctx = await startTestServer();
        seedTenant(ctx, 't1');
        seedTenant(ctx, 't2');
        const { cookie } = await loginSuperadmin(ctx);
        ctx.authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
        ctx.authStore.createUser({ tenantId: 't2', email: 'b@example.com', password: 'longpassword' });

        const res = await fetch(`${ctx.baseUrl}/api/users?tenantId=t1`, { headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        const list = await res.json();
        expect(list.map((u) => u.email)).toEqual(['a@example.com']);
      });

      it('?superadmins=true returns only superadmins', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);
        ctx.authStore.createUser({ tenantId: 't1', email: 'tenant-user@example.com', password: 'longpassword' });

        const res = await fetch(`${ctx.baseUrl}/api/users?superadmins=true`, { headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        const list = await res.json();
        expect(list.every((u) => u.isSuperadmin)).toBe(true);
        expect(list.some((u) => u.email === 'tenant-user@example.com')).toBe(false);
      });
    });

    describe('POST /', () => {
      it('creates a tenant user and returns a one-time temporaryPassword', async () => {
        ctx = await startTestServer();
        seedTenant(ctx);
        const { cookie } = await loginSuperadmin(ctx);

        const res = await postJson(ctx, '/api/users', { tenantId: 'swift-logistics', email: 'new@example.com' }, cookie);
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.user).toMatchObject({
          tenantId: 'swift-logistics',
          email: 'new@example.com',
          isSuperadmin: false,
          active: true,
          mustChangePassword: true,
        });
        expect(typeof body.temporaryPassword).toBe('string');
        expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(8);
      });

      it('creates a superadmin', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);

        const res = await postJson(ctx, '/api/users', { email: 'admin2@example.com', isSuperadmin: true }, cookie);
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.user).toMatchObject({ tenantId: null, isSuperadmin: true });
      });

      it('rejects an unknown tenantId with 400', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);

        const res = await postJson(ctx, '/api/users', { tenantId: 'no-such-tenant', email: 'new@example.com' }, cookie);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/not a known active tenant/);
      });

      it('rejects a duplicate email with 400', async () => {
        ctx = await startTestServer();
        seedTenant(ctx);
        const { cookie } = await loginSuperadmin(ctx);
        await postJson(ctx, '/api/users', { tenantId: 'swift-logistics', email: 'dup@example.com' }, cookie);

        const res = await postJson(ctx, '/api/users', { tenantId: 'swift-logistics', email: 'dup@example.com' }, cookie);
        expect(res.status).toBe(400);
      });
    });

    describe('PATCH /:id and POST /:id/reset-password', () => {
      it('deactivating kills the target user\'s existing session immediately', async () => {
        ctx = await startTestServer();
        seedTenant(ctx);
        const { cookie: adminCookie } = await loginSuperadmin(ctx);
        const { user, cookie: userCookie } = await loginAsNewUser(ctx, { tenantId: 'swift-logistics' });

        // Prove the session is alive before deactivation.
        expect((await fetch(`${ctx.baseUrl}/auth/me`, { headers: { Cookie: userCookie } })).status).toBe(200);

        const patchRes = await patchJson(ctx, `/api/users/${user.id}`, { active: false }, adminCookie);
        expect(patchRes.status).toBe(200);
        expect((await patchRes.json()).user.active).toBe(false);

        const followUp = await fetch(`${ctx.baseUrl}/auth/me`, { headers: { Cookie: userCookie } });
        expect(followUp.status).toBe(401);
      });

      it('rejects deactivating the sole active superadmin with 400', async () => {
        ctx = await startTestServer();
        const { user, cookie } = await loginSuperadmin(ctx);

        const res = await patchJson(ctx, `/api/users/${user.id}`, { active: false }, cookie);
        expect(res.status).toBe(400);
      });

      it('reactivates', async () => {
        ctx = await startTestServer();
        seedTenant(ctx);
        const { cookie: adminCookie } = await loginSuperadmin(ctx);
        const { user } = await loginAsNewUser(ctx, { tenantId: 'swift-logistics' });
        await patchJson(ctx, `/api/users/${user.id}`, { active: false }, adminCookie);

        const res = await patchJson(ctx, `/api/users/${user.id}`, { active: true }, adminCookie);
        expect(res.status).toBe(200);
        expect((await res.json()).user.active).toBe(true);
      });

      it('404s for an unknown id on PATCH', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);
        const res = await patchJson(ctx, '/api/users/nonexistent', { active: false }, cookie);
        expect(res.status).toBe(404);
      });

      it('reset-password rotates the password and the old one stops working', async () => {
        ctx = await startTestServer();
        seedTenant(ctx);
        const { cookie: adminCookie } = await loginSuperadmin(ctx);
        const { user, email } = await loginAsNewUser(ctx, { tenantId: 'swift-logistics' });

        const res = await postJson(ctx, `/api/users/${user.id}/reset-password`, {}, adminCookie);
        expect(res.status).toBe(200);
        const { temporaryPassword } = await res.json();
        expect(typeof temporaryPassword).toBe('string');

        const oldLogin = await postJson(ctx, '/auth/login', { email, password: 'brand-new-pw' });
        expect(oldLogin.status).toBe(401);

        const newLogin = await postJson(ctx, '/auth/login', { email, password: temporaryPassword });
        expect(newLogin.status).toBe(200);
        expect((await newLogin.json()).mustChangePassword).toBe(true);
      });

      it('404s for an unknown id on reset-password', async () => {
        ctx = await startTestServer();
        const { cookie } = await loginSuperadmin(ctx);
        const res = await postJson(ctx, '/api/users/nonexistent/reset-password', {}, cookie);
        expect(res.status).toBe(404);
      });
    });
  });
});
