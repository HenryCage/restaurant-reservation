// db.js — SQLite connection + schema bootstrap for contacts/campaigns (Foundation merge spec).
//
// Single schema version, no migration framework (YAGNI at this size — see
// docs/superpowers/specs/2026-07-16-foundation-merge-design.md). The sheet-driven
// engine (tenants.json + Google Sheets) is untouched by this store; it exists
// alongside it, not instead of it.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  UNIQUE(tenant_id, phone)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type = 'sms'),
  message        TEXT NOT NULL,
  send_to        TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  error          TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id),
  contact_id           TEXT NOT NULL REFERENCES contacts(id),
  phone                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  provider_message_id  TEXT,
  error                TEXT,
  sent_at              TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT,
  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL,
  is_superadmin         INTEGER NOT NULL DEFAULT 0,
  must_change_password  INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  active                   INTEGER NOT NULL DEFAULT 0,
  sheet_id                 TEXT NOT NULL,
  sheet_name               TEXT NOT NULL DEFAULT 'Orders',
  sender_id                TEXT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'dnd',
  notify_statuses_json     TEXT NOT NULL DEFAULT '[]',
  templates_json           TEXT NOT NULL DEFAULT '{}',
  test_number              TEXT NOT NULL DEFAULT '',
  sync_contacts_from_sheet INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
`;

/**
 * `users.active` is deliberately not in the CREATE TABLE literal above:
 * `users` already exists in every deployed database, so the literal alone
 * can't retroactively add a column to it. This self-healing step runs on
 * every open (fresh or pre-existing) and is the only place the column is
 * added, guarded so a second open of the same file never re-runs the ALTER.
 * @param {import('better-sqlite3').Database} db
 */
function ensureUsersActiveColumn(db) {
  const hasActive = db.prepare('PRAGMA table_info(users)').all().some((col) => col.name === 'active');
  if (!hasActive) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}

/**
 * Same self-healing pattern as ensureUsersActiveColumn -- `tenants` already
 * exists in every deployed database (including the just-migrated real one),
 * so these two columns can't be added via the CREATE TABLE literal either.
 * @param {import('better-sqlite3').Database} db
 */
function ensureTenantsSmsColumns(db) {
  const cols = db.prepare('PRAGMA table_info(tenants)').all().map((col) => col.name);
  if (!cols.includes('sms_provider')) {
    db.exec("ALTER TABLE tenants ADD COLUMN sms_provider TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('sms_credentials_json')) {
    db.exec("ALTER TABLE tenants ADD COLUMN sms_credentials_json TEXT NOT NULL DEFAULT '{}'");
  }
}

/**
 * Same self-healing pattern -- lets a bare (no "+") phone number in a
 * tenant's sheet/contacts/campaigns resolve against that tenant's own
 * country instead of the global DEFAULT_COUNTRY_CODE. Empty string means
 * "no override, use the global default" (existing tenants keep today's
 * behavior unchanged).
 * @param {import('better-sqlite3').Database} db
 */
function ensureTenantsDefaultCountryCodeColumn(db) {
  const hasCol = db.prepare('PRAGMA table_info(tenants)').all().some((col) => col.name === 'default_country_code');
  if (!hasCol) db.exec("ALTER TABLE tenants ADD COLUMN default_country_code TEXT NOT NULL DEFAULT ''");
}

/**
 * Open (or create) the SQLite database and ensure the schema exists.
 * @param {string} path - filesystem path, or ':memory:' for tests.
 * @returns {import('better-sqlite3').Database}
 */
export function createDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  ensureUsersActiveColumn(db);
  ensureTenantsSmsColumns(db);
  ensureTenantsDefaultCountryCodeColumn(db);
  return db;
}
