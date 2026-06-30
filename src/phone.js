// phone.js — phone normalisation & validation (pure, no I/O).
//
// Converts the common Nigerian phone formats a dispatcher might type into a
// canonical E.164 string, then validates it. See spec §10.
//
// The function is intentionally tolerant on input (it strips formatting) but
// strict on output: an invalid result returns null so the caller skips the row
// and logs, rather than sending to a malformed/expensive destination.

/**
 * Normalise a raw phone value to canonical E.164 (e.g. "+2348012345678").
 *
 * Rules (spec §10):
 *  - coerce to string first (the Sheets value may arrive as a number);
 *  - remove every character except digits and a single leading "+"
 *    (covers spaces, dashes, dots, parentheses, stray commas from formatting);
 *  - drop a single leading "0" for national format;
 *  - prepend "+<countryCode>" if no country code is present;
 *  - validate; return null if invalid.
 *
 * @param {unknown} raw - the raw cell value (string or number).
 * @param {string} [countryCode] - default country calling code, digits only (e.g. "234").
 * @returns {string|null} canonical E.164 string, or null if invalid.
 */
export function normalisePhone(raw, countryCode = '234') {
  if (raw === null || raw === undefined) return null;

  const cc = String(countryCode).replace(/\D/g, '');
  if (cc === '') return null;

  const original = String(raw).trim();
  if (original === '') return null;

  // Preserve the intent of a leading "+" (international) before stripping it out.
  const hadPlus = original.startsWith('+');
  const digits = original.replace(/\D/g, '');
  if (digits === '') return null;

  let national;
  if (hadPlus) {
    // Already international: trust the country code embedded in the number.
    national = digits;
  } else if (digits.startsWith('0')) {
    // Local format like 08012345678 -> drop the single trunk "0", add country code.
    national = cc + digits.slice(1);
  } else if (digits.startsWith(cc)) {
    // Country code typed without "+" (e.g. 2348012345678).
    national = digits;
  } else {
    // Bare national significant number (e.g. 8012345678).
    national = cc + digits;
  }

  const e164 = '+' + national;
  return isValidE164(e164, cc) ? e164 : null;
}

/**
 * Validate a canonical E.164 string.
 *
 * For Nigeria (country code 234) we enforce the real mobile shape:
 * "+234" followed by a 10-digit national number starting 7/8/9. This rejects
 * landline/invalid prefixes that would silently waste paid (DND-route) sends.
 *
 * For any other country code we fall back to a generic E.164 length check
 * (8–15 total digits) anchored on the expected country code.
 *
 * @param {string} e164
 * @param {string} countryCode - digits only.
 * @returns {boolean}
 */
export function isValidE164(e164, countryCode = '234') {
  if (typeof e164 !== 'string' || !e164.startsWith('+' + countryCode)) return false;

  if (countryCode === '234') {
    return /^\+234[789]\d{9}$/.test(e164);
  }

  // Generic E.164: "+" then 8..15 digits total, starting with the country code.
  return /^\+\d{8,15}$/.test(e164);
}
