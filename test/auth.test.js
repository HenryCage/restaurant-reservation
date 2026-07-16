import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { createAuthStore, generateTempPassword, MIN_PASSWORD_LEN } from '../src/auth.js';

function makeStore(over = {}) {
  const db = createDb(':memory:');
  const auth = createAuthStore(db, { now: () => new Date('2026-01-01T00:00:00.000Z'), ...over });
  return { db, auth };
}

describe('createAuthStore', () => {
  describe('createUser', () => {
    it('creates a tenant user with must_change_password set', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'Ada@Example.com', password: 'longpassword' });
      expect(u).toMatchObject({ tenantId: 't1', email: 'ada@example.com', isSuperadmin: false, mustChangePassword: true });
    });

    it('creates a superadmin with no tenantId', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ email: 'admin@example.com', password: 'longpassword', isSuperadmin: true });
      expect(u).toMatchObject({ tenantId: null, isSuperadmin: true });
    });

    it('rejects a superadmin with a tenantId', () => {
      const { auth } = makeStore();
      expect(() =>
        auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword', isSuperadmin: true }),
      ).toThrow(/must not have a tenantId/);
    });

    it('rejects a non-superadmin without a tenantId', () => {
      const { auth } = makeStore();
      expect(() => auth.createUser({ email: 'a@example.com', password: 'longpassword' })).toThrow(/tenantId is required/);
    });

    it('rejects a short password', () => {
      const { auth } = makeStore();
      expect(() => auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'short' })).toThrow(
        /at least 8 characters/,
      );
    });

    it('rejects a duplicate email (case-insensitive)', () => {
      const { auth } = makeStore();
      auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      expect(() => auth.createUser({ tenantId: 't2', email: 'A@Example.com', password: 'longpassword' })).toThrow(
        /already exists/,
      );
    });
  });

  describe('verifyPassword', () => {
    it('returns the user on correct credentials', () => {
      const { auth } = makeStore();
      auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'correct-password' });
      const u = auth.verifyPassword('a@example.com', 'correct-password');
      expect(u).toMatchObject({ email: 'a@example.com' });
    });

    it('returns null (not a thrown error) on a wrong password', () => {
      const { auth } = makeStore();
      auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'correct-password' });
      expect(auth.verifyPassword('a@example.com', 'wrong-password')).toBeNull();
    });

    it('returns null for an unknown email, same shape as a wrong password', () => {
      const { auth } = makeStore();
      expect(auth.verifyPassword('nobody@example.com', 'whatever')).toBeNull();
    });

    it('is case-insensitive on email', () => {
      const { auth } = makeStore();
      auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'correct-password' });
      expect(auth.verifyPassword('A@Example.com', 'correct-password')).toMatchObject({ email: 'a@example.com' });
    });

    it('returns null (not a distinct error) for a deactivated user, even with the correct password', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'correct-password' });
      auth.deactivate(u.id);
      expect(auth.verifyPassword('a@example.com', 'correct-password')).toBeNull();
    });
  });

  describe('password storage', () => {
    it('never stores the plaintext password', () => {
      const { db, auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'super-secret-pw' });
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
      expect(row.password_hash).not.toContain('super-secret-pw');
      expect(row.password_hash.startsWith('scrypt:')).toBe(true);
    });
  });

  describe('sessions', () => {
    it('createSession then getSession round-trips', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      const sessionId = auth.createSession(u.id);
      const session = auth.getSession(sessionId);
      expect(session).toMatchObject({ id: sessionId, userId: u.id });
    });

    it('returns null and self-deletes an expired session', () => {
      let current = new Date('2026-01-01T00:00:00.000Z');
      const { auth, db } = makeStore({ now: () => current, sessionTtlHours: 1 });
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      const sessionId = auth.createSession(u.id);

      current = new Date('2026-01-01T02:00:00.000Z'); // 2h later, ttl was 1h
      expect(auth.getSession(sessionId)).toBeNull();
      expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)).toBeUndefined();
    });

    it('deleteSession removes the session', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      const sessionId = auth.createSession(u.id);
      auth.deleteSession(sessionId);
      expect(auth.getSession(sessionId)).toBeNull();
    });
  });

  describe('changePassword', () => {
    it('updates the hash and clears must_change_password on success', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
      auth.changePassword(u.id, { currentPassword: 'original-pw', newPassword: 'brand-new-pw' });

      expect(auth.verifyPassword('a@example.com', 'brand-new-pw')).not.toBeNull();
      expect(auth.verifyPassword('a@example.com', 'original-pw')).toBeNull();
      expect(auth.getUser(u.id).mustChangePassword).toBe(false);
    });

    it('rejects a wrong current password without changing anything', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
      expect(() => auth.changePassword(u.id, { currentPassword: 'nope', newPassword: 'brand-new-pw' })).toThrow(
        /incorrect/,
      );
      expect(auth.verifyPassword('a@example.com', 'original-pw')).not.toBeNull();
    });

    it('rejects a too-short new password', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
      expect(() => auth.changePassword(u.id, { currentPassword: 'original-pw', newPassword: 'short' })).toThrow(
        /at least 8 characters/,
      );
    });
  });

  describe('listByTenant / listSuperadmins', () => {
    it('listByTenant returns only that tenant\'s users, active and inactive', () => {
      const { auth } = makeStore();
      const a = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      auth.createUser({ tenantId: 't1', email: 'b@example.com', password: 'longpassword' });
      auth.createUser({ tenantId: 't2', email: 'c@example.com', password: 'longpassword' });
      auth.deactivate(a.id);

      const list = auth.listByTenant('t1');
      expect(list.map((u) => u.email).sort()).toEqual(['a@example.com', 'b@example.com']);
      expect(list.find((u) => u.email === 'a@example.com').active).toBe(false);
    });

    it('listSuperadmins returns only superadmins, active and inactive', () => {
      const { auth } = makeStore();
      auth.createUser({ tenantId: 't1', email: 'tenant-user@example.com', password: 'longpassword' });
      auth.createUser({ email: 'admin1@example.com', password: 'longpassword', isSuperadmin: true });
      auth.createUser({ email: 'admin2@example.com', password: 'longpassword', isSuperadmin: true });

      const list = auth.listSuperadmins();
      expect(list.map((u) => u.email).sort()).toEqual(['admin1@example.com', 'admin2@example.com']);
    });
  });

  describe('deactivate', () => {
    it('sets active to false and deletes the user\'s sessions', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      const sessionId = auth.createSession(u.id);

      const result = auth.deactivate(u.id);
      expect(result).toMatchObject({ ok: true, user: { active: false } });
      expect(auth.getSession(sessionId)).toBeNull();
    });

    it('returns notFound for an unknown id', () => {
      const { auth } = makeStore();
      expect(auth.deactivate('nope')).toEqual({ ok: false, notFound: true });
    });

    it('rejects deactivating the last active superadmin', () => {
      const { auth } = makeStore();
      const admin = auth.createUser({ email: 'admin@example.com', password: 'longpassword', isSuperadmin: true });

      const result = auth.deactivate(admin.id);
      expect(result).toEqual({ ok: false, error: 'cannot deactivate the last active superadmin' });
      expect(auth.getUser(admin.id).active).toBe(true);
    });

    it('allows deactivating a superadmin when another active one remains', () => {
      const { auth } = makeStore();
      const admin1 = auth.createUser({ email: 'admin1@example.com', password: 'longpassword', isSuperadmin: true });
      auth.createUser({ email: 'admin2@example.com', password: 'longpassword', isSuperadmin: true });

      const result = auth.deactivate(admin1.id);
      expect(result).toMatchObject({ ok: true });
    });

    it('is a harmless no-op when the superadmin is already inactive', () => {
      const { auth } = makeStore();
      const admin1 = auth.createUser({ email: 'admin1@example.com', password: 'longpassword', isSuperadmin: true });
      const admin2 = auth.createUser({ email: 'admin2@example.com', password: 'longpassword', isSuperadmin: true });
      auth.deactivate(admin2.id); // now admin1 is the only active superadmin

      const result = auth.deactivate(admin2.id); // deactivating the already-inactive one again
      expect(result).toMatchObject({ ok: true });
      expect(auth.getUser(admin1.id).active).toBe(true); // untouched
    });

    it('does not require a lockout guard for a tenant user', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      expect(auth.deactivate(u.id)).toMatchObject({ ok: true });
    });
  });

  describe('reactivate', () => {
    it('sets active back to true', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      auth.deactivate(u.id);

      const result = auth.reactivate(u.id);
      expect(result).toMatchObject({ ok: true, user: { active: true } });
    });

    it('returns notFound for an unknown id', () => {
      const { auth } = makeStore();
      expect(auth.reactivate('nope')).toEqual({ ok: false, notFound: true });
    });
  });

  describe('resetPassword', () => {
    it('rotates the password, forces must_change_password, and kills sessions', () => {
      const { auth } = makeStore();
      const u = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'original-pw' });
      const sessionId = auth.createSession(u.id);

      const result = auth.resetPassword(u.id);
      expect(result.ok).toBe(true);
      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LEN);

      expect(auth.verifyPassword('a@example.com', 'original-pw')).toBeNull();
      expect(auth.verifyPassword('a@example.com', result.temporaryPassword)).toMatchObject({
        email: 'a@example.com',
        mustChangePassword: true,
      });
      expect(auth.getSession(sessionId)).toBeNull();
    });

    it('returns notFound for an unknown id', () => {
      const { auth } = makeStore();
      expect(auth.resetPassword('nope')).toEqual({ ok: false, notFound: true });
    });
  });

  describe('deleteSessionsForUser', () => {
    it('removes every session for that user, leaving others untouched', () => {
      const { auth } = makeStore();
      const u1 = auth.createUser({ tenantId: 't1', email: 'a@example.com', password: 'longpassword' });
      const u2 = auth.createUser({ tenantId: 't1', email: 'b@example.com', password: 'longpassword' });
      const s1a = auth.createSession(u1.id);
      const s1b = auth.createSession(u1.id);
      const s2 = auth.createSession(u2.id);

      auth.deleteSessionsForUser(u1.id);

      expect(auth.getSession(s1a)).toBeNull();
      expect(auth.getSession(s1b)).toBeNull();
      expect(auth.getSession(s2)).not.toBeNull();
    });
  });
});

describe('generateTempPassword', () => {
  it('generates a URL-safe password meeting the minimum length', () => {
    const pw = generateTempPassword();
    expect(pw.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LEN);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates a different value each call', () => {
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});
