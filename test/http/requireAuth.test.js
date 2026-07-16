import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/db.js';
import { createAuthStore } from '../../src/auth.js';
import { createRequireAuth, resolveTenantId } from '../../src/http/middleware/requireAuth.js';

function fakeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeHarness() {
  const db = createDb(':memory:');
  const authStore = createAuthStore(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
  return { db, authStore };
}

describe('requireAuth middleware', () => {
  it('401s when the cookie is missing', () => {
    const { authStore } = makeHarness();
    const middleware = createRequireAuth({ authStore });
    const req = { headers: {}, path: '/contacts' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('401s on an expired/unknown session', () => {
    const { authStore } = makeHarness();
    const middleware = createRequireAuth({ authStore });
    const req = { headers: { cookie: 'sid=nonexistent' }, path: '/contacts' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('403s with must_change_password on a non-exempt path, but lets the exempt path through', () => {
    const { authStore } = makeHarness();
    const user = authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
    const sid = authStore.createSession(user.id);
    const middleware = createRequireAuth({ authStore, exemptPaths: ['/change-password'] });

    const blockedRes = fakeRes();
    let blockedNext = false;
    middleware({ headers: { cookie: `sid=${sid}` }, path: '/contacts' }, blockedRes, () => (blockedNext = true));
    expect(blockedRes.statusCode).toBe(403);
    expect(blockedRes.body).toEqual({ code: 'must_change_password' });
    expect(blockedNext).toBe(false);

    const exemptRes = fakeRes();
    let exemptNext = false;
    middleware({ headers: { cookie: `sid=${sid}` }, path: '/change-password' }, exemptRes, () => (exemptNext = true));
    expect(exemptNext).toBe(true);
  });

  it('calls next() with req.authUser populated for a tenant user once past must_change_password', () => {
    const { authStore } = makeHarness();
    const user = authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
    authStore.changePassword(user.id, { currentPassword: 'original-pw', newPassword: 'brand-new-pw' });
    const sid = authStore.createSession(user.id);
    const middleware = createRequireAuth({ authStore });

    const req = { headers: { cookie: `sid=${sid}` }, path: '/contacts' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(nextCalled).toBe(true);
    expect(req.authUser).toEqual({ id: user.id, tenantId: 't1', isSuperadmin: false });
  });

  it('populates req.authUser correctly for a superadmin', () => {
    const { authStore } = makeHarness();
    const admin = authStore.createUser({ email: 'admin@example.com', password: 'original-pw', isSuperadmin: true });
    authStore.changePassword(admin.id, { currentPassword: 'original-pw', newPassword: 'brand-new-pw' });
    const sid = authStore.createSession(admin.id);
    const middleware = createRequireAuth({ authStore });

    const req = { headers: { cookie: `sid=${sid}` }, path: '/contacts' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(nextCalled).toBe(true);
    expect(req.authUser).toEqual({ id: admin.id, tenantId: null, isSuperadmin: true });
  });
});

describe('resolveTenantId', () => {
  it('uses the authUser tenantId for a non-superadmin, ignoring the query', () => {
    const req = { authUser: { tenantId: 't1', isSuperadmin: false } };
    expect(resolveTenantId(req, { tenantId: 't2' })).toEqual({ ok: true, tenantId: 't1' });
  });

  it('requires ?tenantId= for a superadmin', () => {
    const req = { authUser: { tenantId: null, isSuperadmin: true } };
    expect(resolveTenantId(req, {})).toEqual({ ok: false });
    expect(resolveTenantId(req, { tenantId: 't2' })).toEqual({ ok: true, tenantId: 't2' });
  });
});
