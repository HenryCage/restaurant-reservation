// sheets.js — Google Sheets read (header-mapped) + per-row cell write-back (spec §5.2/§7).
//
// Column mapping is by HEADER NAME (case-insensitive, trimmed), never by fixed
// position, because clients own and edit their sheets. The pure functions
// (parseOrders, buildColumnIndex, columnIndexToLetter) carry the mapping logic
// and are unit-tested without any network. The I/O wrapper (createSheetsClient)
// reads with FORMATTED_VALUE so Phone/Amount arrive as typed strings, and writes
// back only the three service-owned cells per row (never row-level writes).

import { google } from 'googleapis';
import { randomInt } from 'node:crypto';

const SPREADSHEET_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Logical field -> sheet header + whether the header must be present.
 * The three "service" fields (lastNotifiedStatus/notifiedAt/lastError) must exist
 * so the service can write its markers back.
 */
export const ORDER_COLUMNS = {
  orderId: { header: 'Order ID', required: true },
  name: { header: 'Customer Name', required: false },
  phone: { header: 'Phone', required: true },
  amount: { header: 'Amount', required: false },
  status: { header: 'Status', required: true },
  lastNotifiedStatus: { header: 'Last Notified Status', required: true },
  notifiedAt: { header: 'Notified At', required: true },
  lastError: { header: 'Last Error', required: true },
};

/** Fields the service writes back (must map to existing columns). */
export const SERVICE_FIELDS = ['lastNotifiedStatus', 'notifiedAt', 'lastError'];

/**
 * @param {unknown} h
 * @returns {string}
 */
function canonicalHeader(h) {
  return String(h ?? '').trim().toLowerCase();
}

/**
 * Convert a 0-based column index to an A1 column letter (0 -> A, 26 -> AA).
 * @param {number} index
 * @returns {string}
 */
export function columnIndexToLetter(index) {
  let n = index;
  let letter = '';
  do {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letter;
}

/**
 * Quote a sheet/tab name for an A1 range if it needs it.
 * @param {string} name
 * @returns {string}
 */
export function quoteSheetName(name) {
  if (/^[A-Za-z0-9_]+$/.test(name)) return name;
  return "'" + String(name).replace(/'/g, "''") + "'";
}

/**
 * Resolve each logical field to its column index from the header row.
 * @param {string[]} headerRow
 * @returns {{ ok: true, colIndex: Record<string, number> } | { ok: false, error: string }}
 */
export function buildColumnIndex(headerRow) {
  const header = headerRow.map(canonicalHeader);
  /** @type {Record<string, number>} */
  const colIndex = {};
  const missing = [];
  const duplicates = [];

  for (const [field, def] of Object.entries(ORDER_COLUMNS)) {
    const want = canonicalHeader(def.header);
    const matches = [];
    header.forEach((h, i) => {
      if (h === want) matches.push(i);
    });
    if (matches.length > 1) duplicates.push(def.header);
    else if (matches.length === 1) colIndex[field] = matches[0];
    else if (def.required) missing.push(def.header);
  }

  if (duplicates.length) return { ok: false, error: `duplicate header(s): ${duplicates.join(', ')}` };
  if (missing.length) return { ok: false, error: `missing required header(s): ${missing.join(', ')}` };
  return { ok: true, colIndex };
}

/**
 * @typedef {Object} OrderRow
 * @property {number} rowNumber - absolute 1-based sheet row.
 * @property {string} orderId
 * @property {string} name
 * @property {string} phone
 * @property {string} amount
 * @property {string} status
 * @property {string} lastNotifiedStatus
 * @property {string} lastError
 */

/**
 * Parse a raw 2D values array (incl. header row) into order rows (pure).
 * Reads everything as strings, pads ragged rows, and skips rows missing any of
 * Order ID / Phone / Status.
 * @param {any[][]} values
 * @returns {{ ok: true, colIndex: Record<string, number>, rows: OrderRow[] } | { ok: false, error: string }}
 */
export function parseOrders(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, error: 'sheet is empty (no header row)' };
  }

  const headerRow = (values[0] || []).map((h) => String(h ?? ''));
  const indexed = buildColumnIndex(headerRow);
  if (!indexed.ok) return indexed;
  const { colIndex } = indexed;

  /** @param {any[]} raw @param {string} field */
  const cell = (raw, field) => {
    const idx = colIndex[field];
    if (idx === undefined) return '';
    const v = raw[idx];
    return v === undefined || v === null ? '' : String(v);
  };

  /** @type {OrderRow[]} */
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = Array.isArray(values[i]) ? values[i] : [];
    const orderId = cell(raw, 'orderId').trim();
    const phone = cell(raw, 'phone');
    const status = cell(raw, 'status');
    // Skip rows that are blank in any required field (also skips trailing empties).
    if (orderId === '' || phone.trim() === '' || status.trim() === '') continue;

    rows.push({
      rowNumber: i + 1,
      orderId,
      name: cell(raw, 'name'),
      phone,
      amount: cell(raw, 'amount'),
      status,
      lastNotifiedStatus: cell(raw, 'lastNotifiedStatus'),
      lastError: cell(raw, 'lastError'),
    });
  }

  return { ok: true, colIndex, rows };
}

/**
 * Build the batchUpdate "data" payload for a per-row service-cell write (pure).
 * @param {string} sheetName
 * @param {number} rowNumber
 * @param {Record<string, number>} colIndex - field -> column index.
 * @param {Partial<Record<'lastNotifiedStatus'|'notifiedAt'|'lastError', string>>} fields
 * @returns {{ range: string, values: string[][] }[]}
 */
export function buildWriteData(sheetName, rowNumber, colIndex, fields) {
  const data = [];
  for (const field of SERVICE_FIELDS) {
    if (!(field in fields)) continue;
    const idx = colIndex[field];
    if (idx === undefined) continue;
    const range = `${quoteSheetName(sheetName)}!${columnIndexToLetter(idx)}${rowNumber}`;
    data.push({ range, values: [[fields[field] ?? '']] });
  }
  return data;
}

const ORDER_ID_SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** @returns {string} 4 random uppercase alphanumeric characters. */
function defaultRandomSuffix() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ORDER_ID_SUFFIX_CHARS[randomInt(ORDER_ID_SUFFIX_CHARS.length)];
  return s;
}

/**
 * Generate a new Order ID for a UI-created order: `ORD-YYYYMMDD-XXXX` (4
 * random uppercase alphanumeric characters). Retries on a collision against
 * `existingIds` (astronomically unlikely, capped so a pathological test
 * can never loop forever) -- Order ID is immutable and must be unique
 * within the sheet once assigned (Sheets-mode order editing spec).
 * @param {Set<string>|string[]} existingIds
 * @param {{ now?: () => Date, randomSuffix?: () => string }} [deps]
 * @returns {string}
 */
export function generateOrderId(existingIds, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const randomSuffix = deps.randomSuffix ?? defaultRandomSuffix;
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);

  const d = now();
  const yyyymmdd =
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');

  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `ORD-${yyyymmdd}-${randomSuffix()}`;
    if (!existing.has(id)) return id;
  }
  throw new Error('failed to generate a unique order id after 20 attempts');
}

/**
 * Build a single sparse row for a new-order `values.append` call: one
 * element longer than the highest column index in `colIndex`, each `fields`
 * value placed at its mapped position, blank string everywhere else. A
 * `fields` key with no matching `colIndex` entry (e.g. this tenant's sheet
 * has no "Amount" column) is silently ignored.
 * @param {Record<string, number>} colIndex
 * @param {Record<string, string>} fields
 * @returns {string[]}
 */
export function buildAppendData(colIndex, fields) {
  const maxIndex = Math.max(-1, ...Object.values(colIndex));
  const row = new Array(maxIndex + 1).fill('');
  for (const [field, value] of Object.entries(fields)) {
    const idx = colIndex[field];
    if (idx === undefined) continue;
    row[idx] = value ?? '';
  }
  return row;
}

/**
 * Like buildWriteData, but for any order-data field present in `fields`
 * (Order ID/Name/Phone/Amount/Status), not just the fixed SERVICE_FIELDS
 * list. Kept as a separate function rather than widening buildWriteData
 * itself, so the notification engine's own write-back stays exactly as
 * narrowly scoped as it is today -- this is a distinct, HTTP-triggered path
 * (Sheets-mode order editing spec).
 * @param {string} sheetName
 * @param {number} rowNumber
 * @param {Record<string, number>} colIndex
 * @param {Record<string, string>} fields
 * @returns {{ range: string, values: string[][] }[]}
 */
export function buildOrderWriteData(sheetName, rowNumber, colIndex, fields) {
  const data = [];
  for (const [field, value] of Object.entries(fields)) {
    const idx = colIndex[field];
    if (idx === undefined) continue;
    const range = `${quoteSheetName(sheetName)}!${columnIndexToLetter(idx)}${rowNumber}`;
    data.push({ range, values: [[value ?? '']] });
  }
  return data;
}

/**
 * Extract the 1-based row number Sheets actually inserted into, from a
 * `values.append` response's `updates.updatedRange` (e.g. "Orders!A5:E5" or
 * "'My Sheet'!A5:E5"). More reliable than guessing client-side from the
 * parsed row count, since `INSERT_ROWS` appends after the last row with
 * *any* data in the target range -- which can differ if trailing junk rows
 * exist below the last row `parseOrders` considered valid.
 * @param {string} updatedRange
 * @returns {number|null}
 */
export function parseAppendedRowNumber(updatedRange) {
  const match = /![A-Za-z]+(\d+)/.exec(updatedRange ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Read/write methods for one authenticated sheetsApi instance. Shared by
 * createSheetsClientFactory().forTenant() -- the per-tenant JWT auth differs,
 * the methods themselves don't.
 * @param {any} sheetsApi
 */
function buildClient(sheetsApi) {
  return {
    /**
     * Read & parse a tenant's orders.
     * @param {string} sheetId
     * @param {string} sheetName
     */
    async readOrders(sheetId, sheetName) {
      const res = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: sheetName,
        valueRenderOption: 'FORMATTED_VALUE',
      });
      return parseOrders(res?.data?.values ?? []);
    },

    /**
     * Write only the service-owned cells for one row (cell-scoped, never row-scoped).
     * @param {string} sheetId
     * @param {string} sheetName
     * @param {number} rowNumber
     * @param {Record<string, number>} colIndex
     * @param {Partial<Record<'lastNotifiedStatus'|'notifiedAt'|'lastError', string>>} fields
     */
    async writeRow(sheetId, sheetName, rowNumber, colIndex, fields) {
      const data = buildWriteData(sheetName, rowNumber, colIndex, fields);
      if (data.length === 0) return;
      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { valueInputOption: 'RAW', data },
      });
    },

    /**
     * Append a brand-new order row (Sheets-mode order editing). Leaves the
     * service columns (Last Notified Status/Notified At/Last Error) blank,
     * so a subsequent processor tick treats it exactly like a row a person
     * typed in by hand.
     * @param {string} sheetId
     * @param {string} sheetName
     * @param {Record<string, number>} colIndex
     * @param {Record<string, string>} fields
     */
    async appendOrder(sheetId, sheetName, colIndex, fields) {
      const values = buildAppendData(colIndex, fields);
      const res = await sheetsApi.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: quoteSheetName(sheetName),
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      });
      return { rowNumber: parseAppendedRowNumber(res?.data?.updates?.updatedRange) };
    },

    /**
     * Write any order-data field(s) for one existing row (cell-scoped, like
     * writeRow, but for Name/Phone/Amount/Status rather than the fixed
     * service columns). A distinct, HTTP-triggered path from writeRow --
     * the notification engine's own write-back never widens because of this.
     * @param {string} sheetId
     * @param {string} sheetName
     * @param {number} rowNumber
     * @param {Record<string, number>} colIndex
     * @param {Record<string, string>} fields
     */
    async writeOrderFields(sheetId, sheetName, rowNumber, colIndex, fields) {
      const data = buildOrderWriteData(sheetName, rowNumber, colIndex, fields);
      if (data.length === 0) return;
      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { valueInputOption: 'RAW', data },
      });
    },
  };
}

/**
 * Create a factory that builds a Sheets client scoped to one tenant's own
 * Google service-account credentials (Per-tenant Google credentials spec --
 * replaces the single global GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY
 * that used to serve every tenant). No fallback to any global config: a
 * tenant with no credentials configured is the caller's responsibility to
 * skip before ever calling .forTenant() (processor.js/orders.js do, mirroring
 * the "no SMS provider configured" skip).
 * @param {{ sheetsApi?: any }} [deps] - inject a fake sheetsApi for tests (used for every tenant).
 */
export function createSheetsClientFactory(deps = {}) {
  return {
    /**
     * @param {{ googleServiceAccountEmail: string, googlePrivateKey: string }} tenant
     */
    forTenant(tenant) {
      const sheetsApi =
        deps.sheetsApi ??
        google.sheets({
          version: 'v4',
          auth: new google.auth.JWT({
            email: tenant.googleServiceAccountEmail,
            // A tenant may paste their key with literal \n sequences (e.g.
            // copied out of the downloaded JSON file's string value) just
            // like .env used to require; un-escape them the same way.
            key: tenant.googlePrivateKey.replace(/\\n/g, '\n'),
            scopes: [SPREADSHEET_SCOPE],
          }),
        });
      return buildClient(sheetsApi);
    },
  };
}
