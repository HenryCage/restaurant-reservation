// sms/index.js — per-tenant provider selector exposing a single sendSms()
// contract (Per-tenant SMS provider spec).
//
// The processor never cares which provider is active. Whichever adapter runs,
// this wrapper guarantees the unified result shape and converts any thrown error
// into a transient failure (spec §7: a network throw must not abort the tenant).
//
// Provider + credentials are read per-tenant (tenant.smsProvider/
// smsCredentials), not from a single global config -- there is no fallback.
// httpTimeoutMs/fetchFn remain shared/global (transport-level, not
// provider-specific). The three adapter modules themselves are untouched;
// only where their constructor arguments come from changed.

import { createTermiiAdapter } from './termii.js';
import { createAfricasTalkingAdapter } from './africasTalking.js';
import { createTwilioAdapter } from './twilio.js';

/**
 * @typedef {{ ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }} SendResult
 */

/**
 * @param {import('../tenants.js').Tenant} tenant
 * @param {{ timeoutMs: number, fetchFn: typeof fetch }} shared
 * @returns {(to: string, message: string, opts: any) => Promise<any>}
 */
function buildAdapter(tenant, { timeoutMs, fetchFn }) {
  const creds = tenant.smsCredentials ?? {};
  if (tenant.smsProvider === 'termii') {
    return createTermiiAdapter({ apiKey: creds.apiKey, baseUrl: creds.baseUrl, timeoutMs, fetchFn });
  }
  if (tenant.smsProvider === 'twilio') {
    return createTwilioAdapter({
      accountSid: creds.accountSid,
      authToken: creds.authToken,
      fromNumber: creds.fromNumber,
      timeoutMs,
      fetchFn,
    });
  }
  if (tenant.smsProvider === 'africastalking') {
    return createAfricasTalkingAdapter({ apiKey: creds.apiKey, username: creds.username, timeoutMs, fetchFn });
  }
  return null; // unconfigured -- caller (processor/campaignScheduler) must not reach this
}

/**
 * @param {{ config: import('../config.js').Config, deps?: { fetchFn?: typeof fetch } }} args
 * @returns {{ forTenant: (tenant: import('../tenants.js').Tenant) => (to: string, message: string, options: { senderId: string, channel?: string }) => Promise<SendResult> }}
 */
export function createSmsSenderFactory({ config, deps = {} }) {
  const fetchFn = deps.fetchFn ?? fetch;
  const shared = { timeoutMs: config.httpTimeoutMs, fetchFn };

  return {
    forTenant(tenant) {
      const adapter = buildAdapter(tenant, shared);

      return async function sendSms(to, message, options = {}) {
        if (!adapter) {
          return { ok: false, error: `tenant "${tenant.id}" has no SMS provider configured`, permanent: false };
        }
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
    },
  };
}
