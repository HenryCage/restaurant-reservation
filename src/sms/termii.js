// sms/termii.js — Termii SMS adapter (spec §9.1).
//
// Endpoint: POST {baseUrl}/api/sms/send with a JSON body. The base URL is
// account-specific and comes from config (never hard-coded). On failure the
// adapter classifies the error as permanent (give up) vs transient (retry) per
// spec §9; when unsure it defaults to transient.

import { requestWithTimeout } from './httpClient.js';

/**
 * Decide whether a Termii failure is permanent (won't fix on retry).
 * @param {number} status - HTTP status (0 if unknown).
 * @param {string} message - provider/error message text.
 * @returns {boolean}
 */
export function classifyTermiiError(status, message) {
  // Throttling and server errors are transient.
  if (status === 429 || status >= 500) return false;
  // Auth/permission issues are operator-fixable; retry once corrected.
  if (status === 401 || status === 403) return false;
  // Clear recipient/sender rejections won't change on retry.
  if (/invalid.*(number|recipient|phone|msisdn|sender)|sender.?id|blacklist|opt(ed)?.?out|do(es)? not exist|not.*found/i.test(message)) {
    return true;
  }
  // Default: transient (safer to retry than to silently drop a notification).
  return false;
}

/**
 * @typedef {{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }} SendResult
 */

/**
 * Create a Termii send function.
 * @param {{ apiKey: string, baseUrl: string, timeoutMs: number, fetchFn?: typeof fetch }} deps
 * @returns {(toE164: string, message: string, opts: { senderId: string, channel?: string }) => Promise<SendResult>}
 */
export function createTermiiAdapter({ apiKey, baseUrl, timeoutMs, fetchFn = fetch }) {
  const url = baseUrl.replace(/\/+$/, '') + '/api/sms/send';

  return async function send(toE164, message, { senderId, channel }) {
    // Termii expects the country code without a leading "+".
    const to = String(toE164).replace(/^\+/, '');
    const body = {
      to,
      from: senderId,
      sms: message,
      type: 'plain',
      channel: channel || 'generic',
      api_key: apiKey,
    };

    let res;
    try {
      res = await requestWithTimeout(
        fetchFn,
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (err) {
      // Network failure / timeout / abort → transient.
      return { ok: false, error: `termii request failed: ${err?.message ?? err}`, permanent: false };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok && data && (data.code === 'ok' || data.message_id)) {
      return {
        ok: true,
        providerMessageId: data.message_id != null ? String(data.message_id) : undefined,
      };
    }

    const errText =
      data && (data.message || data.error) ? String(data.message || data.error) : `HTTP ${res.status}`;
    return { ok: false, error: errText, permanent: classifyTermiiError(res.status, errText) };
  };
}
