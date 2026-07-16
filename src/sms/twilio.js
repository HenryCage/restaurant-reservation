// sms/twilio.js — Twilio SMS adapter (Foundation merge spec).
//
// Endpoint: POST /2010-04-01/Accounts/{AccountSid}/Messages.json, form-encoded,
// HTTP Basic Auth (AccountSid:AuthToken). No twilio npm SDK — this goes through
// the same requestWithTimeout() every other adapter uses, so there is one HTTP
// client path in the codebase, not two. On failure the error is classified
// permanent (won't change on retry) vs transient per Twilio's numeric `code`
// field; unknown/missing codes default to transient (spec §9's rule).

import { requestWithTimeout } from './httpClient.js';

const API_BASE = 'https://api.twilio.com/2010-04-01';

// Twilio error codes that will not change on retry.
const PERMANENT_CODES = new Set([
  21211, // invalid 'To' phone number
  21214, // 'To' is not a valid mobile number
  21408, // permission to send SMS not enabled for this region
  21606, // 'From' is not a valid, SMS-capable Twilio number
  21610, // recipient opted out (replied STOP)
  21614, // 'To' is not a valid, SMS-capable number
]);

/**
 * @param {number|undefined} code
 * @returns {boolean}
 */
export function classifyTwilioError(code) {
  return typeof code === 'number' && PERMANENT_CODES.has(code);
}

/**
 * @typedef {{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }} SendResult
 */

/**
 * Create a Twilio send function.
 * @param {{ accountSid: string, authToken: string, fromNumber: string, timeoutMs: number, fetchFn?: typeof fetch }} deps
 * @returns {(toE164: string, message: string, opts?: object) => Promise<SendResult>}
 */
export function createTwilioAdapter({ accountSid, authToken, fromNumber, timeoutMs, fetchFn = fetch }) {
  const url = `${API_BASE}/Accounts/${accountSid}/Messages.json`;
  const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  return async function send(toE164, message) {
    const form = new URLSearchParams();
    form.set('To', String(toE164));
    form.set('From', fromNumber);
    form.set('Body', message);

    let res;
    try {
      res = await requestWithTimeout(
        fetchFn,
        url,
        {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: form.toString(),
        },
        timeoutMs,
      );
    } catch (err) {
      // Network failure / timeout / abort → transient.
      return { ok: false, error: `twilio request failed: ${err?.message ?? err}`, permanent: false };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok && data && data.sid) {
      return { ok: true, providerMessageId: String(data.sid) };
    }

    const code = data && typeof data.code === 'number' ? data.code : undefined;
    const errText = data && data.message ? String(data.message) : `HTTP ${res.status}`;
    return { ok: false, error: errText, permanent: classifyTwilioError(code) };
  };
}
