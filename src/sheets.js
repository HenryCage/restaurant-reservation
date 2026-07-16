// sheets.js — Google Sheets read (header-mapped) + per-row cell write-back (spec §5.2/§7).
//
// Column mapping is by HEADER NAME (case-insensitive, trimmed), never by fixed
// position, because clients own and edit their sheets. The pure functions
// (parseOrders, buildColumnIndex, columnIndexToLetter) carry the mapping logic
// and are unit-tested without any network. The I/O wrapper (createSheetsClient)
// reads with FORMATTED_VALUE so Phone/Amount arrive as typed strings, and writes
// back only the three service-owned cells per row (never row-level writes).

import { google } from 'googleapis';

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

/**
 * Create an authenticated Sheets client with readOrders/writeRow.
 * @param {import('./config.js').Config} config
 * @param {{ sheetsApi?: any }} [deps] - inject a fake sheetsApi for tests.
 */
export function createSheetsClient(config, deps = {}) {
  const sheetsApi =
    deps.sheetsApi ??
    google.sheets({
      version: 'v4',
      auth: new google.auth.JWT({
        email: config.google.serviceAccountEmail,
        key: config.google.privateKey,
        scopes: [SPREADSHEET_SCOPE],
      }),
    });

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
  };
}
