#!/usr/bin/env node
// scripts/migrate-tenants.mjs — one-time move of tenant config from a
// tenants.json file into the `tenants` SQLite table (Tenant management spec:
// docs/superpowers/specs/2026-07-16-tenant-management-design.md). Run once,
// manually, after deploying that change. Deliberately not coupled to
// config.tenantsFile (which was removed) -- this is a standalone tool with
// its own --file argument, not something the running server depends on.
//
// Usage:
//   node scripts/migrate-tenants.mjs
//   node scripts/migrate-tenants.mjs --file=./tenants.json

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createDb } from '../src/db.js';
import { createTenantRegistry } from '../src/tenants.js';

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = typeof args.file === 'string' ? args.file : './tenants.json';

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Error: cannot read ${filePath}: ${err?.message ?? err}`);
    process.exit(1);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`Error: invalid JSON in ${filePath}: ${err?.message ?? err}`);
    process.exit(1);
    return;
  }

  if (!parsed || !Array.isArray(parsed.tenants)) {
    console.error(`Error: ${filePath} has no "tenants" array`);
    process.exit(1);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Error: ${err?.message ?? err}`);
    process.exit(1);
    return;
  }

  const db = createDb(config.dbPath);
  const registry = createTenantRegistry({ db, logger: createLogger({ level: 'error' }) });

  let successCount = 0;
  let failCount = 0;
  for (const raw of parsed.tenants) {
    const id = raw && typeof raw.id === 'string' ? raw.id : '(no id)';
    const result = registry.create(raw);
    if (result.ok) {
      successCount += 1;
      console.log(`OK    ${id}`);
    } else {
      failCount += 1;
      console.log(`FAIL  ${id}: ${result.error}`);
    }
  }

  console.log(`\n${successCount} migrated, ${failCount} failed, out of ${parsed.tenants.length} entries.`);
  if (failCount > 0) {
    console.error('\nMigration incomplete -- fix the failed entries in tenants.json and re-run (already-migrated entries will fail as duplicates; remove them from the file first, or edit them directly via the tenant management UI/API instead of re-running this script).');
    process.exit(1);
  }
}

main();
