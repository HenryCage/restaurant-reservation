import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/db.js';
import { createAuthStore } from '../../src/auth.js';
import { createRequireSuperadmin } from '../../src/http/middleware/requireSuperadmin.js';

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

describe('requireSuperadmin middleware', () => {
  it('401s when the cookie is missing', () => {
    const { authStore } = makeHarness();
    const middleware = createRequireSuperadmin({ authStore });
    const req = { headers: {}, path: '/' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('403s with must_change_password for a gated superadmin', () => {
    const { authStore } = makeHarness();
    const admin = authStore.createUser({ email: 'admin@example.com', password: 'original-pw', isSuperadmin: true });
    const sid = authStore.createSession(admin.id);
    const middleware = createRequireSuperadmin({ authStore });

    const req = { headers: { cookie: `sid=${sid}` }, path: '/' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ code: 'must_change_password' });
    expect(nextCalled).toBe(false);
  });

  it('403s a non-superadmin tenant user (not 401 -- they are authenticated, just not authorized)', () => {
    const { authStore } = makeHarness();
    const user = authStore.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
    authStore.changePassword(user.id, { currentPassword: 'original-pw', newPassword: 'brand-new-pw' });
    const sid = authStore.createSession(user.id);
    const middleware = createRequireSuperadmin({ authStore });

    const req = { headers: { cookie: `sid=${sid}` }, path: '/' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(res.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('calls next() with req.authUser set for a non-gated superadmin', () => {
    const { authStore } = makeHarness();
    const admin = authStore.createUser({ email: 'admin@example.com', password: 'original-pw', isSuperadmin: true });
    authStore.changePassword(admin.id, { currentPassword: 'original-pw', newPassword: 'brand-new-pw' });
    const sid = authStore.createSession(admin.id);
    const middleware = createRequireSuperadmin({ authStore });

    const req = { headers: { cookie: `sid=${sid}` }, path: '/' };
    const res = fakeRes();
    let nextCalled = false;
    middleware(req, res, () => (nextCalled = true));

    expect(nextCalled).toBe(true);
    expect(req.authUser).toEqual({ id: admin.id, tenantId: null, isSuperadmin: true });
  });
});
