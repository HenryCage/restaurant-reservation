// reservations.js - public reservation persistence.

import { randomUUID } from 'node:crypto';
import { sanitiseText } from './message.js';

const MAX_NAME_LEN = 80;
const MAX_NOTES_LEN = 240;
const MAX_PARTY_SIZE = 30;

/** @param {any} row */
function toReservation(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    name: row.name,
    phone: row.phone,
    partySize: row.party_size,
    reservationTime: row.reservation_time,
    notes: row.notes,
    smsStatus: row.sms_status,
    smsError: row.sms_error,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
  };
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function parsePartySize(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTY_SIZE) return null;
  return n;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseReservationTime(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: () => Date }} [deps]
 */
export function createReservationsStore(db, deps = {}) {
  const now = deps.now ?? (() => new Date());

  const insertStmt = db.prepare(
    `INSERT INTO reservations
       (id, tenant_id, contact_id, name, phone, party_size, reservation_time, notes, sms_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const findByIdStmt = db.prepare('SELECT * FROM reservations WHERE tenant_id = ? AND id = ?');
  const listStmt = db.prepare('SELECT * FROM reservations WHERE tenant_id = ? ORDER BY reservation_time DESC');
  const updateSmsStmt = db.prepare(
    `UPDATE reservations
        SET sms_status = ?, sms_error = ?, provider_message_id = ?
      WHERE tenant_id = ? AND id = ?`,
  );

  return {
    /**
     * @param {string} tenantId
     * @param {{ contactId: string, name: string, phone: string, partySize: unknown, reservationTime: string, notes?: string }} input
     */
    createReservation(tenantId, { contactId, name, phone, partySize, reservationTime, notes = '' }) {
      const cleanName = sanitiseText(name, MAX_NAME_LEN);
      if (cleanName === '') throw new Error('name is required');

      const parsedPartySize = parsePartySize(partySize);
      if (parsedPartySize === null) throw new Error(`partySize must be an integer from 1 to ${MAX_PARTY_SIZE}`);

      const reservationIso = parseReservationTime(reservationTime);
      if (!reservationIso) throw new Error('reservationTime must be a valid date/time');

      const id = randomUUID();
      const createdAt = now().toISOString();
      const cleanNotes = sanitiseText(notes, MAX_NOTES_LEN);
      insertStmt.run(id, tenantId, contactId, cleanName, phone, parsedPartySize, reservationIso, cleanNotes, createdAt);
      return toReservation(findByIdStmt.get(tenantId, id));
    },

    /** @param {string} tenantId */
    listReservations(tenantId) {
      return listStmt.all(tenantId).map(toReservation);
    },

    /**
     * @param {string} tenantId
     * @param {string} id
     * @param {{ status: string, error?: string|null, providerMessageId?: string|null }} result
     */
    recordSmsResult(tenantId, id, { status, error = null, providerMessageId = null }) {
      updateSmsStmt.run(status, error, providerMessageId, tenantId, id);
      return toReservation(findByIdStmt.get(tenantId, id));
    },
  };
}
