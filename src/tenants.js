// tenants.js — load and validate the per-tenant registry (spec §5.1).
//
// The registry is a swappable source (a JSON file in v1) re-read each tick.
// Two robustness rules from the spec live here:
//   1) A whole-file read/parse error must NOT zero out the fleet — we keep the
//      last-known-good registry in memory and log (spec §4/§7).
//   2) An individual invalid tenant is skipped-and-logged, never crashes the run
//      (spec §14). senderId is format-validated and must be unique across active
//      tenants to guard against accidental cross-tenant impersonation (spec §2/§5.1).
//
// Canonical (trim + lower-case) lookups for statuses and templates are precomputed
// here so the processor's comparisons round-trip identically (spec §5.2).

import { readFileSync } from 'node:fs';

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
 * Create a registry loader bound to a file path. `.load()` returns the current
 * active tenants, falling back to the last-known-good set on read/parse failure.
 * @param {{ filePath: string, logger: import('./logger.js').Logger, readFile?: (p: string) => string }} deps
 */
export function createTenantRegistry({ filePath, logger, readFile = (p) => readFileSync(p, 'utf8') }) {
  /** @type {Tenant[]} */
  let lastGood = [];

  return {
    /** @returns {Tenant[]} */
    load() {
      let text;
      try {
        text = readFile(filePath);
      } catch (err) {
        logger.error(`tenants: cannot read ${filePath}; keeping last-known-good (${lastGood.length} tenant(s))`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return lastGood;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        logger.error(`tenants: invalid JSON in ${filePath}; keeping last-known-good (${lastGood.length} tenant(s))`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return lastGood;
      }

      const result = validateRegistry(parsed, logger);
      if (result === null) {
        logger.error(
          `tenants: ${filePath} has no valid "tenants" array; keeping last-known-good (${lastGood.length} tenant(s))`,
        );
        return lastGood;
      }

      lastGood = result;
      return result;
    },
  };
}
