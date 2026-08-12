// Shared harness for HTTP integration tests: a real Express app on an
// ephemeral port, driven with native fetch (no supertest dependency).

import { createDb } from '../../../src/db.js';
import { createAuthStore } from '../../../src/auth.js';
import { createContactsStore } from '../../../src/contacts.js';
import { createCampaignsStore } from '../../../src/campaigns.js';
import { createReservationsStore } from '../../../src/reservations.js';
import { createTenantRegistry } from '../../../src/tenants.js';
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
    dryRun: false,
    effectiveGlobalTestNumber: '',
    ...overrides,
  };
}

/**
 * @param {{ configOverrides?: object, now?: () => Date, registry?: object, sheets?: object, clientDistPath?: string }} [opts]
 */
export async function startTestServer(opts = {}) {
  const db = createDb(':memory:');
  const authStore = createAuthStore(db, opts.now ? { now: opts.now } : {});
  const contactsStore = createContactsStore(db, opts.now ? { now: opts.now } : {});
  const campaignsStore = createCampaignsStore(db, opts.now ? { now: opts.now } : {});
  const reservationsStore = createReservationsStore(db, opts.now ? { now: opts.now } : {});
  const config = baseTestConfig(opts.configOverrides);
  // Real SQLite-backed registry by default (same db as everything else) so
  // tenant CRUD tests exercise the actual store; tests that only care about
  // .load() (e.g. orders routes) can still pass a lighter opts.registry fake.
  const registry = opts.registry ?? createTenantRegistry({ db, logger: silentLogger() });
  const sheets = opts.sheets ?? { readOrders: async () => ({ ok: true, rows: [] }) };
  const sheetsClientFactory = { forTenant: () => sheets };
  const smsSenderFactory =
    opts.smsSenderFactory ??
    {
      forTenant: () => async () => ({ ok: true, providerMessageId: 'test-message-id' }),
    };
  const app = createHttpServer({
    config,
    logger: silentLogger(),
    authStore,
    contactsStore,
    campaignsStore,
    reservationsStore,
    registry,
    smsSenderFactory,
    sheetsClientFactory,
    ...(opts.clientDistPath ? { clientDistPath: opts.clientDistPath } : {}),
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();

  return {
    db,
    authStore,
    contactsStore,
    campaignsStore,
    reservationsStore,
    registry,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Pulls just the "name=value" part out of a Set-Cookie response header. */
export function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  return setCookie ? setCookie.split(';')[0] : null;
}
