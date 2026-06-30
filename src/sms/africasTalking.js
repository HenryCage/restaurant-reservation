// sms/africasTalking.js — Africa's Talking SMS adapter (spec §9.2).
//
// Endpoint: POST /version1/messaging (live or sandbox, chosen by username).
// Form-urlencoded body. There is NO "channel" concept here, so options.channel
// is ignored. enqueue=true is included for reliable handling. On failure the
// per-recipient status is classified permanent vs transient (spec §9).

import { requestWithTimeout } from './httpClient.js';

const LIVE_URL = 'https://api.africastalking.com/version1/messaging';
const SANDBOX_URL = 'https://api.sandbox.africastalking.com/version1/messaging';

// Per-recipient statuses that will not change on retry.
const PERMANENT_STATUSES = new Set([
  'InvalidPhoneNumber',
  'InvalidSenderId',
  'UserInBlacklist',
  'UserDoesNotExist',
]);

/**
 * @param {string} status
 * @returns {boolean}
 */
export function classifyAtRecipientStatus(status) {
  return PERMANENT_STATUSES.has(status);
}

/**
 * @typedef {{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }} SendResult
 */

/**
 * Create an Africa's Talking send function.
 * @param {{ apiKey: string, username: string, timeoutMs: number, fetchFn?: typeof fetch }} deps
 * @returns {(toE164: string, message: string, opts: { senderId?: string }) => Promise<SendResult>}
 */
export function createAfricasTalkingAdapter({ apiKey, username, timeoutMs, fetchFn = fetch }) {
  const url = username === 'sandbox' ? SANDBOX_URL : LIVE_URL;

  return async function send(toE164, message, { senderId } = {}) {
    const form = new URLSearchParams();
    form.set('username', username);
    form.set('to', String(toE164)); // E.164 with "+"
    form.set('message', message);
    if (senderId) form.set('from', senderId);
    form.set('enqueue', 'true');

    let res;
    try {
      res = await requestWithTimeout(
        fetchFn,
        url,
        {
          method: 'POST',
          headers: {
            apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: form.toString(),
        },
        timeoutMs,
      );
    } catch (err) {
      return { ok: false, error: `africastalking request failed: ${err?.message ?? err}`, permanent: false };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    const recipient =
      data && data.SMSMessageData && Array.isArray(data.SMSMessageData.Recipients)
        ? data.SMSMessageData.Recipients[0]
        : null;

    if (res.ok && recipient && recipient.status === 'Success') {
      return {
        ok: true,
        providerMessageId: recipient.messageId != null ? String(recipient.messageId) : undefined,
      };
    }

    if (recipient && recipient.status) {
      return {
        ok: false,
        error: `africastalking status: ${recipient.status}`,
        permanent: classifyAtRecipientStatus(recipient.status),
      };
    }

    // Top-level error (auth, malformed request, etc.) — default to transient.
    const topMessage =
      data && data.SMSMessageData && data.SMSMessageData.Message
        ? String(data.SMSMessageData.Message)
        : `HTTP ${res.status}`;
    return { ok: false, error: topMessage, permanent: false };
  };
}
