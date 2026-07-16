#!/usr/bin/env node
// scripts/create-user.mjs — provisions a tenant user or a superadmin with a
// temporary password (Customer-auth spec's admin-provisioned v1 onboarding —
// no email-based invite/reset). All validated logic lives in src/auth.js,
// already covered by test/auth.test.js; this is a thin CLI wrapper.
//
// Usage:
//   node scripts/create-user.mjs --email=a@example.com --tenant=<tenant-id>
//   node scripts/create-user.mjs --email=admin@example.com --superadmin
//   node scripts/create-user.mjs --email=a@example.com --tenant=<id> --password=<explicit password>

import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createTenantRegistry } from '../src/tenants.js';
import { createDb } from '../src/db.js';
import { createAuthStore, generateTempPassword, MIN_PASSWORD_LEN } from '../src/auth.js';

/** @param {string[]} argv @returns {Record<string, string|true>} */
function parseArgs(argv) {
  /** @type {Record<string, string|true>} */
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, ...rest] = raw.slice(2).split('=');
    args[key] = rest.length > 0 ? rest.join('=') : true;
  }
  return args;
}

/** @param {string} message */
function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === 'string' ? args.email.trim() : '';
  const isSuperadmin = args.superadmin === true;
  const tenantId = typeof args.tenant === 'string' ? args.tenant.trim() : '';
  const password = typeof args.password === 'string' ? args.password : generateTempPassword();

  if (!email) return fail('--email=<email> is required');
  if (isSuperadmin && tenantId) return fail('--superadmin and --tenant are mutually exclusive');
  if (!isSuperadmin && !tenantId) return fail('--tenant=<id> is required unless --superadmin is set');
  if (password.length < MIN_PASSWORD_LEN) return fail(`--password must be at least ${MIN_PASSWORD_LEN} characters`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return fail(err?.message ?? String(err));
  }

  const db = createDb(config.dbPath);

  if (tenantId) {
    const logger = createLogger({ level: 'error' });
    const registry = createTenantRegistry({ db, logger });
    const knownActiveTenant = registry.load().some((t) => t.id === tenantId);
    if (!knownActiveTenant) {
      return fail(`tenant "${tenantId}" is not a known active tenant`);
    }
  }

  const authStore = createAuthStore(db, { sessionTtlHours: config.sessionTtlHours });

  let user;
  try {
    user = authStore.createUser({ tenantId: isSuperadmin ? null : tenantId, email, password, isSuperadmin });
  } catch (err) {
    return fail(err?.message ?? String(err));
  }

  console.log(`Created ${isSuperadmin ? 'superadmin' : `tenant user for "${tenantId}"`}:`);
  console.log(`  email:    ${user.email}`);
  console.log(`  password: ${password}`);
  console.log('This password is shown once — share it out-of-band. The user must change it on first login.');
}

main();
