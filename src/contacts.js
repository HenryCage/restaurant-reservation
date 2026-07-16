// contacts.js — per-tenant contacts store (Foundation merge spec).
//
// Two write paths with different semantics: createContact() is a human/manual
// action (a future dashboard "add contact" button) and rejects an existing
// phone with a clear error; upsertContact() is the sheet-sync path and is
// silent/idempotent by design (see spec's "Sheet -> contacts sync" section).

import { randomUUID } from 'node:crypto';
import { normalisePhone } from './phone.js';

/**
 * @typedef {Object} Contact
 * @property {string} id
 * @property {string} tenantId
 * @property {string} name
 * @property {string} phone
 * @property {string[]} tags
 * @property {string} createdAt
 */

/** @param {any} row @returns {Contact} */
function toContact(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    phone: row.phone,
    tags: JSON.parse(row.tags),
    createdAt: row.created_at,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ defaultCountryCode?: string, now?: () => Date }} [deps]
 */
export function createContactsStore(db, deps = {}) {
  const defaultCountryCode = deps.defaultCountryCode ?? '234';
  const now = deps.now ?? (() => new Date());

  const insertStmt = db.prepare(
    'INSERT INTO contacts (id, tenant_id, name, phone, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const upsertStmt = db.prepare(`
    INSERT INTO contacts (id, tenant_id, name, phone, tags, created_at)
    VALUES (?, ?, ?, ?, '[]', ?)
    ON CONFLICT(tenant_id, phone) DO UPDATE SET name = excluded.name
  `);
  const findByPhoneStmt = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND phone = ?');
  const findByIdStmt = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND id = ?');
  const listStmt = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at');

  return {
    /**
     * Human-facing add: rejects an existing (tenant, phone) with a clear error.
     * @param {string} tenantId
     * @param {{ name: string, phone: string, tags?: string[] }} input
     * @returns {Contact}
     */
    createContact(tenantId, { name, phone, tags = [] }) {
      const e164 = normalisePhone(phone, defaultCountryCode);
      if (!e164) throw new Error(`invalid phone: ${phone}`);

      if (findByPhoneStmt.get(tenantId, e164)) {
        throw new Error(`a contact with phone ${e164} already exists for this tenant`);
      }

      const id = randomUUID();
      const createdAt = now().toISOString();
      insertStmt.run(id, tenantId, name, e164, JSON.stringify(tags), createdAt);
      return { id, tenantId, name, phone: e164, tags, createdAt };
    },

    /**
     * Sheet-sync path: silent insert-or-update-name, never throws on a duplicate.
     * @param {string} tenantId
     * @param {{ name: string, phone: string }} input
     * @returns {Contact|null} the resulting row, or null if the phone is invalid.
     */
    upsertContact(tenantId, { name, phone }) {
      const e164 = normalisePhone(phone, defaultCountryCode);
      if (!e164) return null;

      upsertStmt.run(randomUUID(), tenantId, name, e164, now().toISOString());
      return toContact(findByPhoneStmt.get(tenantId, e164));
    },

    /**
     * @param {string} tenantId
     * @returns {Contact[]}
     */
    listContacts(tenantId) {
      return listStmt.all(tenantId).map(toContact);
    },

    /**
     * @param {string} tenantId
     * @param {string} contactId
     * @returns {Contact|null}
     */
    getContact(tenantId, contactId) {
      const row = findByIdStmt.get(tenantId, contactId);
      return row ? toContact(row) : null;
    },
  };
}
