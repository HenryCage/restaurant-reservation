# Foundation merge: contacts, campaigns, Twilio adapter

Date: 2026-07-16
Status: approved (design), not yet implemented

## Context

This repo (`SMS_Dispatch_MVP`) is a headless, multi-tenant service that polls each
tenant's Google Sheet and sends a templated SMS when an order's `Status` enters a
notifiable value (Termii / Africa's Talking). It has no UI, no database — the
sheet plus `tenants.json` are the only state (see `CLAUDE.md`).

A colleague built a separate prototype, **autoNotify** (`sms-automation-main.zip`):
a React/Vite/Tailwind dashboard + Express/CommonJS backend that stores contacts and
manual/scheduled "automations" in a flat `db.json`, and sends via Twilio (SMS and
voice calls).

Decision: combine both into one product — a **communications platform** where the
existing reactive sheet→SMS engine and a new manual/scheduled campaign-to-contacts
flow are equal first-class features, scoped per tenant. This is a large effort, so
it is split into sequential sub-projects:

1. **Foundation merge** (this spec) — persistence, contacts, campaigns, Twilio
   adapter. No UI, no accounts, no voice.
2. Customer-facing auth — each tenant's own employees get logins, scoped to their
   tenant's data.
3. Dashboard UI — autoNotify's React app adapted to read/write against (1) and (2):
   automatic-notification history (read-only) plus manual campaign composition.
4. Voice channel (Twilio TwiML) — explicitly deferred past v1.

This spec covers only (1).

## Decisions made during brainstorming

- Combined product is a full communications platform (automatic + manual sends as
  equal features), not just an ops add-on to the existing engine.
- Persistence: SQLite (`better-sqlite3`), not Postgres and not a formalized
  `db.json`-per-tenant file — matches the current "one instance, zero infra" model
  and stays synchronous/testable like the rest of the codebase.
- Contacts and campaigns are scoped **per tenant** (tenant id from `tenants.json`),
  matching the existing multi-tenant model.
- SMS/voice providers share **one adapter layer**: Termii, Africa's Talking, and
  Twilio are all adapters behind the existing `createSmsSender()`, usable by both
  the sheet-driven engine and campaigns.
- Voice calls are deferred to a later stage; only `type = 'sms'` exists in v1.
- Campaign dashboard access will eventually be per-tenant login for the tenant's
  own employees (a real external multi-user product) — that's sub-project 2, out
  of scope here.
- Campaign targeting is restricted to **saved contacts only** (`all` or one
  `contact.id`) — no ad-hoc, not-yet-saved phone numbers, to avoid a second
  validation path and keep `campaign_recipients` cleanly tied to `contacts`.
- Contacts are also populated automatically from the sheet: whenever a
  sheet-triggered SMS is sent successfully, that customer is upserted into
  `contacts` for that tenant. This is **opt-in per tenant** (a tenant whose
  transactional order data shouldn't feed a contactable list stays unaffected)
  and only fires for customers who were actually messaged — not every row in the
  sheet. See "Sheet → contacts sync" below.

## Architecture

New code is an **additive layer**, not a modification of the existing engine.
`processor.js`'s single-flight and per-tenant isolation guarantees stay exactly as
they are; it gains exactly one small, optional extension point (the contacts-sync
hook below), no other change to its control flow. A sibling scheduler for
campaigns follows the same discipline independently.

```
src/
  db.js                    # new: better-sqlite3 connection factory (injectable)
  contacts.js               # new: pure logic + createContactsStore(db)
  campaigns.js                # new: pure logic + createCampaignsStore(db)
  campaignScheduler.js          # new: createCampaignScheduler(), own setInterval tick
  sms/
    twilio.js                # new: third adapter, same {ok, providerMessageId?, error?, permanent?} contract
    index.js                  # modified: createSmsSender() gains a 'twilio' case
  processor.js               # modified (minimal): optional deps.onNotified(tenant, contact) hook, see below
  tenants.js                 # modified (minimal): new optional per-tenant field syncContactsFromSheet
  sheets.js, message.js, phone.js, config.js, logger.js   # untouched
```

`src/index.js` starts two independent `setInterval` loops in the same process:
the existing sheet-poll loop, and a new campaign-tick loop with its own interval
(`CAMPAIGN_TICK_INTERVAL_MS`, default 10s — campaigns are time-sensitive scheduled
sends, unlike sheet polling).

SQLite file: `data/platform.db`, gitignored like `tenants.json`/`.env`, created
automatically on first run via schema bootstrap (see Deployment section).

## Data model

```sql
CREATE TABLE contacts (
  id          TEXT PRIMARY KEY,        -- crypto.randomUUID()
  tenant_id   TEXT NOT NULL,           -- matches tenants.json 'id'
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,           -- E.164, normalized via existing phone.js before insert
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_at  TEXT NOT NULL,
  UNIQUE(tenant_id, phone)
);

CREATE TABLE campaigns (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type = 'sms'),   -- 'call' intentionally rejected in v1
  message        TEXT NOT NULL,          -- sanitized via existing message.js helpers
  send_to        TEXT NOT NULL,          -- 'all' or a specific contacts.id
  scheduled_time TEXT NOT NULL,          -- ISO8601
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | sent | partial | failed
  error          TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE campaign_recipients (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id),
  contact_id           TEXT NOT NULL REFERENCES contacts(id),
  phone                TEXT NOT NULL,     -- snapshot at send time; later contact edits don't rewrite history
  status               TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  provider_message_id  TEXT,
  error                TEXT,
  sent_at              TEXT
);
```

`campaign_recipients` exists as its own table (rather than autoNotify's aggregate
`successCount`/`failCount`/`lastError` string) so each recipient's outcome is
individually auditable and crash-safe: if the process dies mid-send, only the rows
still `pending` are retried on the next tick, not the whole campaign.
`campaigns.status` is derived from its recipients: all `sent` → `sent`; mixed →
`partial`; all `failed` → `failed`.

## Data flow

### Campaign lifecycle (`campaignScheduler.js`, tick every `CAMPAIGN_TICK_INTERVAL_MS`)

1. `running` single-flight flag (mirrors `processor.js`) — an overrunning tick
   skips the next fire rather than overlapping.
2. Query: `campaigns` where `status IN ('pending','processing')` and
   `scheduled_time <= now`, grouped by `tenant_id`.
3. Per tenant (try/catch isolation, mirrors the existing per-tenant guard):
   - Set `status = 'processing'`, persist immediately (crash-duplication guard,
     same intent as autoNotify's immediate write but via a SQLite transaction).
   - Resolve recipients (`send_to = 'all'` → every contact for that tenant, or the
     one named `contact.id`); insert `campaign_recipients` rows with
     `status='pending'` if not already created (idempotent — a re-run tick won't
     create duplicates).
   - For each **pending** recipient: send via the same process-wide
     `createSmsSender()` instance the sheet engine uses (provider selection is
     global — one `SMS_PROVIDER` for the whole process, not per tenant; see
     Config additions); write the outcome back to that recipient row
     **immediately** (send-then-write-back-immediately, same principle as
     `sheets.js`'s cell-scoped write-back).
   - After processing recipients, recompute `campaigns.status`.
4. **Bulk-guard**: if `send_to = 'all'` and the contact count exceeds
   `MAX_CAMPAIGN_RECIPIENTS_PER_TICK`, only send up to the cap this tick; the rest
   stay `pending` and are picked up next tick (mirrors the existing
   `MAX_SENDS_PER_TENANT_PER_TICK` guard on the sheet engine).

### Contacts CRUD (`contacts.js`)

Plain synchronous `better-sqlite3` operations, no scheduler involved:
`createContact`, `listContacts(tenantId)`. Phone is normalized via the existing
`phone.js` before `INSERT`; a `UNIQUE(tenant_id, phone)` violation is surfaced as a
clear caller-facing error, not a 500.

### Twilio adapter (`src/sms/twilio.js`)

Matches the `termii.js` / `africasTalking.js` contract exactly. No `twilio` npm
SDK — calls Twilio's REST API directly through the existing `requestWithTimeout`
(`httpClient.js`) with HTTP Basic Auth (`Account SID:Auth Token`), so there's a
single HTTP client path in the codebase, not two. Error classification: Twilio's
numeric `code` field distinguishes permanent (e.g. 21211 invalid `To` number) from
transient (429/5xx/auth/network); default is transient when unsure, same rule as
the existing adapters.

### Sheet → contacts sync (opt-in)

A tenant can opt in to automatically populating its `contacts` list from the
customers its sheet-driven engine actually messages — so campaigns have a
contact list to send to without anyone re-typing customer data by hand.

- **New tenant field** (`tenants.js`, `tenants.example.json`):
  `syncContactsFromSheet: boolean`, default `false` when absent. Parsed and
  validated alongside the other optional per-tenant settings (`channel`,
  `testNumber`); no new required field, existing `tenants.json` files keep
  working unchanged.
- **Trigger point**: inside `processor.js`'s `processRow()`, only in the branch
  where `result.ok === true` (a message was actually, successfully sent) —
  never for transient/permanent failures, and never while `config.dryRun` is
  true (dry runs mark rows as notified without a real send; they must not
  populate a real contact list). The synced phone is `e164` (the validated
  customer number), never the test-number-overridden `recipient` — so
  `GLOBAL_TEST_NUMBER`/`testNumber` redirection never leaks a test number into
  a tenant's contacts.
- **Extension point**: `createProcessor(deps)` gains one new optional
  dependency, `deps.onNotified?: (tenant, contact: {name, phone}) => void`.
  When absent (as in every existing test), behavior is byte-for-byte identical
  to today. When present, it's called once per successful send, wrapped in its
  own try/catch so a contacts-sync failure is logged and isolated — it can
  never turn a successful sheet notification into a failed tick.
- **Wiring** (`index.js`, the composition root): `onNotified` is defined once,
  checks `tenant.syncContactsFromSheet` itself, and calls
  `contactsStore.upsertContact(tenant.id, { name, phone })` — so `processor.js`
  itself never needs to know the opt-in flag exists, keeping its dependency
  surface (and its existing tests) unchanged.
- **Upsert semantics**: `contacts.js` gains `upsertContact(tenantId, {name,
  phone})` (`INSERT ... ON CONFLICT(tenant_id, phone) DO UPDATE SET name =
  excluded.name`), distinct from the human-facing `createContact` (used by a
  future dashboard "add contact" action), which instead rejects an existing
  phone with a clear error. Auto-sync is idempotent and silent by design; a
  manual add is an explicit user action that should surface a duplicate.

## Error handling & safety modes

Transient vs. permanent semantics for campaign sends are identical to
`processor.js`: transient leaves the recipient `pending` (retried next tick);
permanent marks it `failed` immediately (parked, no attempts counter — the row
itself is the state machine).

Existing safety modes apply to campaigns too, reusing the logic already in
`sms/index.js` rather than duplicating it: `DRY_RUN=true` marks recipients `sent`
without a real send (logged); `GLOBAL_TEST_NUMBER` / per-tenant `testNumber`
redirect campaign SMS the same way they redirect sheet-triggered SMS, and are
ignored when `NODE_ENV=production`.

## Config additions

Provider-conditional, fail-fast, collected-and-thrown-once — same pattern as the
rest of `loadConfig`:

- `VALID_PROVIDERS` in `config.js` gains `'twilio'` alongside `'termii'` /
  `'africastalking'`. Provider selection stays global and process-wide
  (`SMS_PROVIDER` env var) exactly as it is today — there is no per-tenant
  provider field, and campaigns reuse the same `createSmsSender()` instance the
  sheet engine already creates in `index.js`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — required
  only when `SMS_PROVIDER=twilio`, following the exact same provider-conditional
  pattern already used for `TERMII_*` / `AT_*`.
- `DB_PATH` — default `data/platform.db`.
- `CAMPAIGN_TICK_INTERVAL_MS` — default `10000`.
- `MAX_CAMPAIGN_RECIPIENTS_PER_TICK` — default `50`.

## Testing

`test/` continues to mirror `src/` 1:1, no network in any suite:

- `contacts.test.js`, `campaigns.test.js` — `better-sqlite3(':memory:')` injected
  as the `db` dependency (`createContactsStore(db)`, `createCampaignsStore(db)`).
- `campaignScheduler.test.js` — mirrors `processor.test.js`: fake `db`, fake
  `smsSender`, fake `clock`; covers transient retry, permanent park, bulk-guard,
  per-tenant isolation, and crash-safety at the per-recipient level.
- Twilio adapter tests are added as a new `describe('Twilio adapter', ...)`
  block in the existing `test/sms.test.js` (which already covers Termii,
  Africa's Talking, and the `createSmsSender` selector in one file — there's no
  `test/sms/` subfolder to mirror). Same style: injected fake `fetch`, verifies
  permanent/transient error classification.
- `contacts.test.js` also covers `upsertContact` (insert new, update name on
  existing phone, isolated per `tenant_id`).
- `processor.test.js` gains cases for the new `onNotified` hook: called with
  `(tenant, {name, phone})` only on a successful, non-dry-run send; not called
  on transient/permanent failure or during `DRY_RUN`; a throwing `onNotified`
  does not fail the row or the tick; omitting it entirely leaves all existing
  assertions passing unchanged.
- `tenants.test.js` gains a case for parsing/defaulting `syncContactsFromSheet`.

## Deployment

`src/db.js` exports `createDb(path)`, which opens a `better-sqlite3` connection
and runs `CREATE TABLE IF NOT EXISTS` schema (inline or `schema.sql`) on startup.
No migration framework in v1 — a single schema version is enough; a version-
tracking table can be added later if the schema needs to evolve post-launch.
`data/platform.db` is a new gitignored path, created automatically on first run.
`better-sqlite3` is added to `package.json` dependencies.

## Explicitly out of scope for this sub-project

- Dashboard UI (sub-project 3).
- Auth / accounts (sub-project 2).
- Voice channel (deferred past v1).
- HTTP API for contacts/campaigns — this stage exposes contacts/campaigns only as
  direct function calls (`createContactsStore`, `createCampaignsStore`); an HTTP
  layer arrives with the dashboard sub-project, once there's an auth story to put
  in front of it.
