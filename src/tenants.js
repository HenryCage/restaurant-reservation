// tenants.js — load and validate the per-tenant registry (spec §5.1).
//
// The registry lives in the `tenants` SQLite table (Tenant management spec:
// docs/superpowers/specs/2026-07-16-tenant-management-design.md) -- it was a
// hand-edited tenants.json file before that migration; see
// scripts/migrate-tenants.mjs for the one-time move. Two robustness rules
// from the original spec still apply, now against the DB instead of a file:
//   1) A whole-query read failure must NOT zero out the fleet — we keep the
//      last-known-good registry in memory and log (spec §4/§7).
//   2) An individual invalid tenant is skipped-and-logged, never crashes the run
//      (spec §14). senderId is format-validated and must be unique across active
//      tenants to guard against accidental cross-tenant impersonation (spec §2/§5.1).
//
// Canonical (trim + lower-case) lookups for statuses and templates are precomputed
// here so the processor's comparisons round-trip identically (spec §5.2).
//
// validateTenant/validateRegistry are deliberately unchanged by the SQLite
// migration -- they only ever operated on a plain "raw" object shape, and a
// SQLite row (JSON-decoded) is mapped into that exact same shape by
// rowToRaw() below, so no validation logic needed to move.

const SENDER_ID_RE = /^[A-Za-z0-9]{3,11}$/;
const DEFAULT_SHEET_NAME = 'Orders';
const DEFAULT_CHANNEL = 'dnd';

/**
 * Canonical form used for all status/template comparisons (spec §5.2).
 * @param {unknown} s
 * @returns {string}
 */
export function canonicalStatus(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * @typedef {Object} Tenant
 * @property {string} id
 * @property {string} name
 * @property {boolean} active
 * @property {string} sheetId
 * @property {string} sheetName
 * @property {string} senderId
 * @property {string} channel
 * @property {string} testNumber
 * @property {boolean} syncContactsFromSheet
 * @property {string[]} notifyStatuses
 * @property {Set<string>} notifyStatusesCanonical
 * @property {Record<string,string>} templates
 * @property {Record<string,string>} templatesByCanonical
 */

/**
 * Validate one raw tenant entry. Returns a normalised Tenant or null (and logs why).
 * @param {any} raw
 * @param {{ dupIds: Set<string>, dupSenderIds: Set<string> }} ctx
 * @param {import('./logger.js').Logger} logger
 * @returns {Tenant|null}
 */
export function validateTenant(raw, ctx, logger) {
  const skip = (reason, meta) => {
    const id = raw && typeof raw.id === 'string' ? raw.id : '(no id)';
    logger.error(`tenant "${id}" skipped: ${reason}`, meta);
    return null;
  };

  if (!raw || typeof raw !== 'object') return skip('entry is not an object');

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return skip('missing/empty "id"');
  if (ctx.dupIds.has(id)) return skip('duplicate "id" across registry');

  const active = raw.active === true;

  const sheetId = typeof raw.sheetId === 'string' ? raw.sheetId.trim() : '';
  if (sheetId === '') return skip('missing/empty "sheetId"');

  const sheetName =
    typeof raw.sheetName === 'string' && raw.sheetName.trim() !== ''
      ? raw.sheetName.trim()
      : DEFAULT_SHEET_NAME;

  const senderId = typeof raw.senderId === 'string' ? raw.senderId.trim() : '';
  if (!SENDER_ID_RE.test(senderId)) {
    return skip('invalid "senderId" (must be 3-11 alphanumeric chars)', { senderId });
  }
  if (active && ctx.dupSenderIds.has(senderId.toLowerCase())) {
    return skip('"senderId" is shared with another active tenant (impersonation guard)', { senderId });
  }

  if (!Array.isArray(raw.notifyStatuses) || raw.notifyStatuses.length === 0) {
    return skip('"notifyStatuses" must be a non-empty array');
  }
  const notifyStatuses = [];
  for (const s of raw.notifyStatuses) {
    if (typeof s !== 'string' || s.trim() === '') return skip('"notifyStatuses" contains an empty value');
    notifyStatuses.push(s);
  }

  if (!raw.templates || typeof raw.templates !== 'object' || Array.isArray(raw.templates)) {
    return skip('"templates" must be an object');
  }

  // Build canonical template map; every notify status must have a template.
  /** @type {Record<string,string>} */
  const templatesByCanonical = {};
  for (const [key, val] of Object.entries(raw.templates)) {
    if (typeof val !== 'string') return skip(`template for "${key}" must be a string`);
    templatesByCanonical[canonicalStatus(key)] = val;
  }
  /** @type {Set<string>} */
  const notifyStatusesCanonical = new Set();
  for (const s of notifyStatuses) {
    const c = canonicalStatus(s);
    notifyStatusesCanonical.add(c);
    if (!(c in templatesByCanonical)) {
      return skip(`missing template for notify status "${s}"`);
    }
  }

  const channel =
    typeof raw.channel === 'string' && raw.channel.trim() !== '' ? raw.channel.trim() : DEFAULT_CHANNEL;
  const testNumber = typeof raw.testNumber === 'string' ? raw.testNumber.trim() : '';
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id;
  // Opt-in only: absent, wrong type, or any non-true value all default to false
  // (Foundation merge spec's "Sheet -> contacts sync" section).
  const syncContactsFromSheet = raw.syncContactsFromSheet === true;

  return {
    id,
    name,
    active,
    sheetId,
    sheetName,
    senderId,
    channel,
    testNumber,
    syncContactsFromSheet,
    notifyStatuses,
    notifyStatusesCanonical,
    templates: { ...raw.templates },
    templatesByCanonical,
  };
}

/**
 * Validate a parsed registry object. Returns the list of valid ACTIVE tenants,
 * or null if the top-level shape is wrong (caller then keeps last-known-good).
 * @param {any} parsed
 * @param {import('./logger.js').Logger} logger
 * @returns {Tenant[]|null}
 */
export function validateRegistry(parsed, logger) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tenants)) {
    return null;
  }

  // Pre-scan duplicates: ids across all entries; senderIds across ACTIVE entries only
  // (an inactive leftover must not block an active tenant).
  const idCounts = new Map();
  const senderCounts = new Map();
  for (const t of parsed.tenants) {
    if (t && typeof t.id === 'string' && t.id.trim() !== '') {
      const k = t.id.trim();
      idCounts.set(k, (idCounts.get(k) ?? 0) + 1);
    }
    if (t && t.active === true && typeof t.senderId === 'string' && t.senderId.trim() !== '') {
      const k = t.senderId.trim().toLowerCase();
      senderCounts.set(k, (senderCounts.get(k) ?? 0) + 1);
    }
  }
  const dupIds = new Set([...idCounts].filter(([, n]) => n > 1).map(([k]) => k));
  const dupSenderIds = new Set([...senderCounts].filter(([, n]) => n > 1).map(([k]) => k));
  const ctx = { dupIds, dupSenderIds };

  /** @type {Tenant[]} */
  const active = [];
  for (const raw of parsed.tenants) {
    const t = validateTenant(raw, ctx, logger);
    if (t && t.active) active.push(t);
  }
  return active;
}

/**
 * Map a `tenants` table row to the plain "raw" shape validateTenant expects
 * (the same shape a tenants.json array entry used to have).
 * @param {any} row
 * @returns {any}
 */
function rowToRaw(row) {
  return {
    id: row.id,
    name: row.name,
    active: !!row.active,
    sheetId: row.sheet_id,
    sheetName: row.sheet_name,
    senderId: row.sender_id,
    channel: row.channel,
    notifyStatuses: JSON.parse(row.notify_statuses_json),
    templates: JSON.parse(row.templates_json),
    testNumber: row.test_number,
    syncContactsFromSheet: !!row.sync_contacts_from_sheet,
  };
}

/**
 * A logger stand-in that records the last message passed to .error() so a
 * caller can surface it as an HTTP error body, without changing
 * validateTenant's signature (it only ever calls logger.error(msg, meta)).
 * @returns {{ logger: import('./logger.js').Logger, message: string|null }}
 */
function createCapturingLogger() {
  let message = null;
  const logger = {
    error: (msg) => {
      message = msg;
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger,
  };
  return {
    logger,
    get message() {
      return message;
    },
  };
}

/**
 * Simulate validateRegistry's whole-batch duplicate pre-scan for a single
 * incoming row being created or updated: does its id/senderId collide with
 * any *other* row currently in the table? (excludeId lets update() ignore
 * the row being updated against itself).
 * @param {any[]} existingRows - raw `tenants` table rows.
 * @param {any} candidateRaw - the raw shape being validated.
 * @param {string|null} excludeId
 */
function buildDupContext(existingRows, candidateRaw, excludeId) {
  const others = excludeId ? existingRows.filter((r) => r.id !== excludeId) : existingRows;
  const dupIds = others.some((r) => r.id === candidateRaw.id) ? new Set([candidateRaw.id]) : new Set();

  const candidateSenderLower = String(candidateRaw.senderId ?? '').trim().toLowerCase();
  const activeOtherSenderIds = others.filter((r) => r.active).map((r) => String(r.sender_id).trim().toLowerCase());
  const dupSenderIds =
    candidateRaw.active === true && activeOtherSenderIds.includes(candidateSenderLower)
      ? new Set([candidateSenderLower])
      : new Set();

  return { dupIds, dupSenderIds };
}

/**
 * Create a registry loader bound to the `tenants` table. `.load()` returns the
 * current active tenants, falling back to the last-known-good set on a query
 * failure. `.listAll()`/`.create()`/`.update()` back the admin UI.
 * @param {{ db: import('better-sqlite3').Database, logger: import('./logger.js').Logger }} deps
 */
export function createTenantRegistry({ db, logger }) {
  const selectAllStmt = db.prepare('SELECT * FROM tenants');
  const selectOneStmt = db.prepare('SELECT * FROM tenants WHERE id = ?');
  const insertStmt = db.prepare(
    `INSERT INTO tenants (id, name, active, sheet_id, sheet_name, sender_id, channel, notify_statuses_json, templates_json, test_number, sync_contacts_from_sheet, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStmt = db.prepare(
    `UPDATE tenants SET name = ?, active = ?, sheet_id = ?, sheet_name = ?, sender_id = ?, channel = ?, notify_statuses_json = ?, templates_json = ?, test_number = ?, sync_contacts_from_sheet = ?, updated_at = ?
     WHERE id = ?`,
  );

  /** @type {Tenant[]} */
  let lastGood = [];

  return {
    /** @returns {Tenant[]} */
    load() {
      let rows;
      try {
        rows = selectAllStmt.all();
      } catch (err) {
        logger.error(`tenants: cannot read the tenants table; keeping last-known-good (${lastGood.length} tenant(s))`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return lastGood;
      }

      const result = validateRegistry({ tenants: rows.map(rowToRaw) }, logger);
      if (result === null) {
        logger.error(
          `tenants: the tenants table produced no valid "tenants" array; keeping last-known-good (${lastGood.length} tenant(s))`,
        );
        return lastGood;
      }

      lastGood = result;
      return result;
    },

    /** Every tenant, active or not -- for the admin list view. @returns {any[]} */
    listAll() {
      return selectAllStmt.all().map(rowToRaw);
    },

    /**
     * @param {any} raw
     * @returns {{ ok: true, tenant: any } | { ok: false, error: string }}
     */
    create(raw) {
      const ctx = buildDupContext(selectAllStmt.all(), raw, null);
      const capturing = createCapturingLogger();
      const validated = validateTenant(raw, ctx, capturing.logger);
      if (!validated) return { ok: false, error: capturing.message };

      const now = new Date().toISOString();
      insertStmt.run(
        validated.id,
        validated.name,
        validated.active ? 1 : 0,
        validated.sheetId,
        validated.sheetName,
        validated.senderId,
        validated.channel,
        JSON.stringify(validated.notifyStatuses),
        JSON.stringify(validated.templates),
        validated.testNumber,
        validated.syncContactsFromSheet ? 1 : 0,
        now,
        now,
      );
      return { ok: true, tenant: rowToRaw(selectOneStmt.get(validated.id)) };
    },

    /**
     * Partial/merge update -- `patch` carries only the fields being changed.
     * `id` in `patch` is ignored (renaming would orphan existing
     * contacts/campaigns/users foreign keys); the row's id never changes.
     * @param {string} id
     * @param {any} patch
     * @returns {{ ok: true, tenant: any } | { ok: false, error: string } | { ok: false, notFound: true }}
     */
    update(id, patch) {
      const existingRow = selectOneStmt.get(id);
      if (!existingRow) return { ok: false, notFound: true };

      const { id: _ignoredId, ...safePatch } = patch ?? {};
      const merged = { ...rowToRaw(existingRow), ...safePatch, id };

      const ctx = buildDupContext(selectAllStmt.all(), merged, id);
      const capturing = createCapturingLogger();
      const validated = validateTenant(merged, ctx, capturing.logger);
      if (!validated) return { ok: false, error: capturing.message };

      updateStmt.run(
        validated.name,
        validated.active ? 1 : 0,
        validated.sheetId,
        validated.sheetName,
        validated.senderId,
        validated.channel,
        JSON.stringify(validated.notifyStatuses),
        JSON.stringify(validated.templates),
        validated.testNumber,
        validated.syncContactsFromSheet ? 1 : 0,
        new Date().toISOString(),
        id,
      );
      return { ok: true, tenant: rowToRaw(selectOneStmt.get(id)) };
    },
  };
}
