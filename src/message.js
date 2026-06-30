// message.js — build an SMS body from a per-tenant template and a row (pure, no I/O).
//
// Templating rules (spec §8):
//  - placeholders {name}, {orderId}, {amount} are replaced from the row;
//  - optional clauses wrapped in [[ ... ]] are dropped entirely if any
//    placeholder inside them is empty, otherwise the markers are removed and the
//    inner text kept (this is how "omit the amount clause" works cleanly);
//  - amount is parsed to whole naira and grouped with thousands separators;
//  - sheet-sourced text is sanitised (control chars stripped, length capped)
//    before substitution, since anyone with sheet access can type anything.

const MAX_NAME_LEN = 40;
const MAX_ORDER_ID_LEN = 40;

// Control characters (C0 range plus DEL) that must never reach the SMS body.
// Built from a string so the source contains no literal control bytes.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/**
 * @typedef {Object} MessageRow
 * @property {unknown} [name]
 * @property {unknown} [orderId]
 * @property {unknown} [amount]
 */

/**
 * Build the final SMS text.
 * @param {string} template
 * @param {MessageRow} row
 * @returns {string}
 */
export function buildMessage(template, row) {
  const tpl = template == null ? '' : String(template);

  /** @type {Record<string, string>} */
  const values = {
    name: sanitiseText(row?.name, MAX_NAME_LEN),
    orderId: sanitiseText(row?.orderId, MAX_ORDER_ID_LEN),
    amount: formatAmount(row?.amount),
  };

  // 1) Resolve optional [[ ... ]] clauses against placeholder emptiness.
  //    A clause is dropped if it references at least one placeholder that is empty.
  let out = tpl.replace(/\[\[([\s\S]*?)\]\]/g, (_match, inner) => {
    const referenced = [...String(inner).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const anyEmpty = referenced.some((key) => !values[key]);
    return anyEmpty ? '' : inner;
  });

  // 2) Substitute the remaining placeholders. Unknown placeholders are left as-is.
  out = out.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );

  // 3) Tidy whitespace left by dropped clauses (e.g. a double space) without
  //    disturbing intentional single spacing.
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Sanitise sheet-sourced text for safe inclusion in an SMS.
 * Strips control characters and newlines, collapses whitespace, caps length.
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
export function sanitiseText(value, maxLen) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/**
 * Parse and format an amount to grouped whole naira (e.g. "15000" -> "15,000").
 * Removes spaces and thousands separators, keeps the whole-naira integer part
 * (drops kobo). Returns "" for empty or non-numeric input (which drops its
 * optional clause). Deliberately NOT a naive "strip non-digits", which would
 * turn "15,000.00" into "1500000".
 * @param {unknown} raw
 * @returns {string}
 */
export function formatAmount(raw) {
  if (raw === null || raw === undefined) return '';
  const cleaned = String(raw).trim().replace(/[\s,]/g, '');
  if (cleaned === '') return '';

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return '';

  const whole = Math.trunc(Math.abs(n));
  // Locale-independent thousands grouping.
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
