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
`;

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
  return db;
}
