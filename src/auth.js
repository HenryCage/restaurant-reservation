// auth.js — users/sessions store (Customer-facing auth spec).
//
// Same shape as contacts.js/campaigns.js: takes `db`, fully testable against
// `:memory:` SQLite, no HTTP awareness. Password hashing uses node:crypto's
// scrypt (no new native dependency alongside better-sqlite3). A user is
// either a tenant user (tenantId set) or a superadmin (tenantId null) --
// never both, never neither.

import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 64;
export const MIN_PASSWORD_LEN = 8;

/** URL-safe, no ambiguous separators to read out loud -- shared by the CLI and the admin-triggered create/reset HTTP routes. */
export function generateTempPassword() {
  return randomBytes(12).toString('base64url');
}

/** @param {string} plain @returns {string} */
function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * @param {string} plain
 * @param {string} stored - "scrypt:<saltHex>:<hashHex>"
 * @returns {boolean}
 */
function verifyPasswordHash(plain, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(plain, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** @param {any} row */
function toUser(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    isSuperadmin: !!row.is_superadmin,
    mustChangePassword: !!row.must_change_password,
    active: !!row.active,
    createdAt: row.created_at,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: () => Date, sessionTtlHours?: number }} [deps]
 */
export function createAuthStore(db, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const sessionTtlHours = deps.sessionTtlHours ?? 168;

  const insertUserStmt = db.prepare(
    `INSERT INTO users (id, tenant_id, email, password_hash, is_superadmin, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  const findUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
  const findUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const updatePasswordStmt = db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
  );
  const resetPasswordStmt = db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
  );
  const listByTenantStmt = db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY email');
  const listSuperadminsStmt = db.prepare('SELECT * FROM users WHERE is_superadmin = 1 ORDER BY email');
  const countOtherActiveSuperadminsStmt = db.prepare(
    'SELECT COUNT(*) AS c FROM users WHERE is_superadmin = 1 AND active = 1 AND id != ?',
  );
  const setActiveStmt = db.prepare('UPDATE users SET active = ? WHERE id = ?');

  const insertSessionStmt = db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  );
  const findSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const deleteSessionsForUserStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');

  return {
    /**
     * @param {{ tenantId?: string|null, email: string, password: string, isSuperadmin?: boolean }} input
     */
    createUser({ tenantId = null, email, password, isSuperadmin = false }) {
      if (isSuperadmin && tenantId) throw new Error('a superadmin must not have a tenantId');
      if (!isSuperadmin && !tenantId) throw new Error('tenantId is required for a non-superadmin user');
      if (typeof email !== 'string' || email.trim() === '') throw new Error('email is required');
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
        throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
      }

      const normalizedEmail = email.trim().toLowerCase();
      if (findUserByEmailStmt.get(normalizedEmail)) {
        throw new Error(`a user with email ${normalizedEmail} already exists`);
      }

      const id = randomUUID();
      const createdAt = now().toISOString();
      insertUserStmt.run(id, tenantId, normalizedEmail, hashPassword(password), isSuperadmin ? 1 : 0, createdAt);
      return toUser(findUserByIdStmt.get(id));
    },

    /**
     * Returns the user on success, null on an unknown email OR a wrong
     * password -- identical shape either way (never reveal which).
     * @param {string} email
     * @param {string} password
     */
    verifyPassword(email, password) {
      const row = findUserByEmailStmt.get(String(email ?? '').trim().toLowerCase());
      if (!row || !verifyPasswordHash(password, row.password_hash)) return null;
      // A deactivated user's correct password produces the exact same null
      // as a wrong password -- never reveal which (same convention as the
      // unknown-email case above).
      if (!row.active) return null;
      return toUser(row);
    },

    /** @param {string} userId */
    getUser(userId) {
      const row = findUserByIdStmt.get(userId);
      return row ? toUser(row) : null;
    },

    /** @param {string} userId @returns {string} the session id */
    createSession(userId) {
      const id = randomUUID();
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + sessionTtlHours * 3600 * 1000);
      insertSessionStmt.run(id, userId, createdAt.toISOString(), expiresAt.toISOString());
      return id;
    },

    /** @param {string} sessionId */
    getSession(sessionId) {
      const row = findSessionStmt.get(sessionId);
      if (!row) return null;
      if (new Date(row.expires_at).getTime() <= now().getTime()) {
        deleteSessionStmt.run(sessionId); // lazy cleanup, no cron needed
        return null;
      }
      return { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
    },

    /** @param {string} sessionId */
    deleteSession(sessionId) {
      deleteSessionStmt.run(sessionId);
    },

    /**
     * @param {string} userId
     * @param {{ currentPassword: string, newPassword: string }} input
     */
    changePassword(userId, { currentPassword, newPassword }) {
      const row = findUserByIdStmt.get(userId);
      if (!row) throw new Error('user not found');
      if (!verifyPasswordHash(currentPassword, row.password_hash)) {
        throw new Error('current password is incorrect');
      }
      if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LEN) {
        throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
      }
      updatePasswordStmt.run(hashPassword(newPassword), userId);
    },

    /** @param {string} tenantId */
    listByTenant(tenantId) {
      return listByTenantStmt.all(tenantId).map(toUser);
    },

    listSuperadmins() {
      return listSuperadminsStmt.all().map(toUser);
    },

    /** @param {string} userId */
    deleteSessionsForUser(userId) {
      deleteSessionsForUserStmt.run(userId);
    },

    /**
     * Soft-deactivates a user: blocks future logins and kills any session(s)
     * they currently hold. Rejected if the target is the last active
     * superadmin (an already-inactive superadmin is never "the last active"
     * one, so re-deactivating one is always a harmless no-op).
     * @param {string} userId
     */
    deactivate(userId) {
      const row = findUserByIdStmt.get(userId);
      if (!row) return { ok: false, notFound: true };
      if (row.is_superadmin && row.active) {
        const { c: otherActiveSuperadmins } = countOtherActiveSuperadminsStmt.get(userId);
        if (otherActiveSuperadmins === 0) {
          return { ok: false, error: 'cannot deactivate the last active superadmin' };
        }
      }
      setActiveStmt.run(0, userId);
      deleteSessionsForUserStmt.run(userId);
      return { ok: true, user: toUser(findUserByIdStmt.get(userId)) };
    },

    /** @param {string} userId */
    reactivate(userId) {
      const row = findUserByIdStmt.get(userId);
      if (!row) return { ok: false, notFound: true };
      setActiveStmt.run(1, userId);
      return { ok: true, user: toUser(findUserByIdStmt.get(userId)) };
    },

    /**
     * Admin-triggered reset: generates a fresh temporary password, forces
     * must_change_password, and kills existing sessions -- same shape as a
     * freshly created user, just for an existing one.
     * @param {string} userId
     */
    resetPassword(userId) {
      const row = findUserByIdStmt.get(userId);
      if (!row) return { ok: false, notFound: true };
      const temporaryPassword = generateTempPassword();
      resetPasswordStmt.run(hashPassword(temporaryPassword), userId);
      deleteSessionsForUserStmt.run(userId);
      return { ok: true, temporaryPassword };
    },
  };
}
