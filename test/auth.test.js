import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { createAuthStore } from '../src/auth.js';

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
});
