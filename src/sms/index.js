// sms/index.js — provider selector exposing a single sendSms() contract (spec §9).
//
// The processor never cares which provider is active. Whichever adapter runs,
// this wrapper guarantees the unified result shape and converts any thrown error
// into a transient failure (spec §7: a network throw must not abort the tenant).

import { createTermiiAdapter } from './termii.js';
import { createAfricasTalkingAdapter } from './africasTalking.js';
import { createTwilioAdapter } from './twilio.js';

/**
 * @typedef {{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }} SendResult
 */

/**
 * Build the sendSms function for the configured provider.
 * @param {import('../config.js').Config} config
 * @param {{ fetchFn?: typeof fetch }} [deps]
 * @returns {(to: string, message: string, options: { senderId: string, channel?: string }) => Promise<SendResult>}
 */
export function createSmsSender(config, deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;

  /** @type {(to: string, message: string, opts: any) => Promise<SendResult>} */
  let adapter;
  if (config.smsProvider === 'termii') {
    adapter = createTermiiAdapter({
      apiKey: config.termii.apiKey,
      baseUrl: config.termii.baseUrl,
      timeoutMs: config.httpTimeoutMs,
      fetchFn,
    });
  } else if (config.smsProvider === 'twilio') {
    adapter = createTwilioAdapter({
      accountSid: config.twilio.accountSid,
      authToken: config.twilio.authToken,
      fromNumber: config.twilio.fromNumber,
      timeoutMs: config.httpTimeoutMs,
      fetchFn,
    });
  } else {
    adapter = createAfricasTalkingAdapter({
      apiKey: config.africasTalking.apiKey,
      username: config.africasTalking.username,
      timeoutMs: config.httpTimeoutMs,
      fetchFn,
    });
  }

  return async function sendSms(to, message, options = {}) {
    try {
      const result = await adapter(to, message, options);
      if (result && result.ok === true) {
        return { ok: true, providerMessageId: result.providerMessageId };
      }
      return {
        ok: false,
        error: (result && result.error) || 'unknown send error',
        permanent: result?.permanent === true,
      };
    } catch (err) {
      // Defensive: a thrown adapter error is treated as transient (retry).
      return {
        ok: false,
        error: `sms adapter threw: ${err?.message ?? String(err)}`,
        permanent: false,
      };
    }
  };
}
