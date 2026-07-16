// Shared harness for HTTP integration tests: a real Express app on an
// ephemeral port, driven with native fetch (no supertest dependency).

import { createDb } from '../../../src/db.js';
import { createAuthStore } from '../../../src/auth.js';
import { createContactsStore } from '../../../src/contacts.js';
import { createCampaignsStore } from '../../../src/campaigns.js';
import { createHttpServer } from '../../../src/http/server.js';

export function silentLogger() {
  const l = { error() {}, warn() {}, info() {}, debug() {}, child: () => l };
  return l;
}

/** @param {object} [overrides] */
export function baseTestConfig(overrides = {}) {
  return {
    isProduction: false,
    sessionTtlHours: 168,
    corsOrigin: '',
    loginRateLimitMax: 10,
    loginRateLimitWindowMinutes: 15,
    defaultCountryCode: '234',
    ...overrides,
  };
}

/**
 * @param {{ configOverrides?: object, now?: () => Date, registry?: object, sheets?: object }} [opts]
 */
export async function startTestServer(opts = {}) {
  const db = createDb(':memory:');
  const authStore = createAuthStore(db, opts.now ? { now: opts.now } : {});
  const contactsStore = createContactsStore(db, opts.now ? { now: opts.now } : {});
  const campaignsStore = createCampaignsStore(db, opts.now ? { now: opts.now } : {});
  const config = baseTestConfig(opts.configOverrides);
  const registry = opts.registry ?? { load: () => [] };
  const sheets = opts.sheets ?? { readOrders: async () => ({ ok: true, rows: [] }) };
  const app = createHttpServer({ config, logger: silentLogger(), authStore, contactsStore, campaignsStore, registry, sheets });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();

  return {
    db,
    authStore,
    contactsStore,
    campaignsStore,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Pulls just the "name=value" part out of a Set-Cookie response header. */
export function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : null;
}
