# Implementation plan: Foundation merge

Spec: `docs/superpowers/specs/2026-07-16-foundation-merge-design.md`
Status: steps 1-8 implemented and committed; step 9 (manual smoke check)
done via a throwaway fake-deps integration script (not committed -- see
commit history). The live end-to-end check against real Google Sheets/SMS
credentials (the fuller version of step 9 described below) was deliberately
not run unattended and is still open -- see the final summary in the
conversation this plan came from.

## Sequencing rationale

Bottom-up: storage → adapters → scheduling → the one hook into the existing
engine → wiring. Each step ends with `npm test` green before starting the
next, and every step except the last two is fully additive — the existing
suite (`phone`, `message`, `config`, `tenants`, `sms`, `sheets`, `processor`)
must stay green and unmodified in its assertions until step 8.

## Step 1 — `better-sqlite3` dependency + `src/db.js`

- `npm install better-sqlite3`.
- `src/db.js`: `createDb(path)` — opens a `better-sqlite3` connection
  (`path === ':memory:'` supported for tests) and runs the three
  `CREATE TABLE IF NOT EXISTS` statements from the spec's Data model section
  (`contacts`, `campaigns`, `campaign_recipients`), inline SQL (no `schema.sql`
  file needed at this size). Returns the raw `Database` instance — callers
  build their own prepared statements.
- `test/db.test.js`: opens `:memory:`, asserts all three tables exist
  (`PRAGMA table_info` or a dummy insert/select round-trip per table),
  asserts the `UNIQUE(tenant_id, phone)` constraint on `contacts` actually
  throws on a duplicate insert.
- Checkpoint: `npx vitest run test/db.test.js` green.

## Step 2 — `src/contacts.js`

- `createContactsStore(db)` returning:
  - `createContact(tenantId, { name, phone, tags? })` — normalizes `phone` via
    `normalisePhone` from `phone.js` (reuse, don't reimplement); throws a
    plain `Error` with a clear message (not a raw SQLite constraint error) on
    a duplicate `(tenant_id, phone)`; throws if `normalisePhone` returns
    `null` (invalid phone).
  - `upsertContact(tenantId, { name, phone })` — same phone normalization;
    `INSERT ... ON CONFLICT(tenant_id, phone) DO UPDATE SET name = excluded.name`;
    silent, idempotent, never throws on a duplicate.
  - `listContacts(tenantId)` — all contacts for a tenant, `tags` JSON-parsed
    back into an array.
- `test/contacts.test.js` (`better-sqlite3(':memory:')` + `createDb`):
  - `createContact` normalizes phone, rejects invalid phone, rejects duplicate
    `(tenant, phone)` with a clear error, does not leak across tenants.
  - `upsertContact` inserts new, updates `name` in place on existing phone,
    scoped per tenant (same phone under two different tenants = two rows).
  - `listContacts` returns only the requesting tenant's rows.
- Checkpoint: `npx vitest run test/contacts.test.js` green.

## Step 3 — `src/campaigns.js`

- `createCampaignsStore(db)` returning:
  - `createCampaign(tenantId, { name, message, sendTo, scheduledTime })` —
    `type` is always `'sms'` at this stage (hardcoded, not a caller param, so
    it's impossible to accidentally insert `'call'` before voice exists);
    `message` sanitized via the existing `message.js` helpers before storage.
  - `listDueCampaigns(now)` — all campaigns with
    `status IN ('pending','processing') AND scheduled_time <= now`, one row
    per campaign (the scheduler groups by `tenant_id` itself).
  - `ensureRecipients(campaignId, tenantId, sendTo)` — resolves `sendTo`
    (`'all'` → every `contacts` row for `tenantId`; otherwise the one
    `contact_id`) and inserts `campaign_recipients` rows (`status='pending'`)
    that don't already exist for that campaign — idempotent, safe to call
    every tick.
  - `pendingRecipients(campaignId, limit)` — up to `limit` rows with
    `status='pending'` (the bulk-guard cap is applied by the caller passing
    `limit`).
  - `recordRecipientResult(recipientId, { status, providerMessageId?, error? })`
    — one-row update, called immediately after each send.
  - `recomputeCampaignStatus(campaignId)` — reads all recipients for the
    campaign, sets `campaigns.status` to `sent` (all sent) / `partial` (mixed)
    / `failed` (all failed); no-op (stays `processing`) if any are still
    `pending`.
- `test/campaigns.test.js`:
  - `createCampaign` rejects `sendTo` pointing at a nonexistent/other-tenant
    contact id (fail fast at creation, not at send time).
  - `ensureRecipients('all', ...)` creates one recipient per tenant contact,
    is idempotent on a second call (no duplicate rows).
  - `ensureRecipients(<contact.id>, ...)` creates exactly one recipient.
  - `pendingRecipients` respects `limit` and only returns `status='pending'`.
  - `recomputeCampaignStatus` covers all three derived states plus the
    "still processing" no-op case.
- Checkpoint: `npx vitest run test/campaigns.test.js` green.

## Step 4 — `src/sms/twilio.js` + `config.js` + `sms/index.js`

- `src/sms/twilio.js`: `createTwilioAdapter({ accountSid, authToken, fromNumber, timeoutMs, fetchFn })`
  matching the exact `(to, message, opts) => Promise<SendResult>` contract of
  `termii.js`/`africasTalking.js`. POST to
  `https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json`
  (form-encoded body: `To`, `From`, `Body`), `Authorization: Basic
  base64(accountSid:authToken)`, through `requestWithTimeout`. Classify by
  Twilio's numeric `code` field: known permanent codes (21211 invalid `To`,
  21610 unsubscribed recipient, 21408/21606 unverified/invalid `From`) →
  `permanent: true`; everything else (429, 5xx, auth, network, unknown code)
  → transient, matching the existing "default to transient" rule.
- `src/config.js`: add `'twilio'` to `VALID_PROVIDERS`; add
  `twilio = { accountSid, authToken, fromNumber }` parsed the same way as
  `termii`/`africasTalking`; require all three only when
  `smsProvider === 'twilio'`; include `twilio` in the frozen return object.
- `src/sms/index.js`: add an `else if (config.smsProvider === 'twilio')`
  branch building `createTwilioAdapter(...)` — no change to the `termii`/
  default branch or the outer `sendSms` wrapper.
- Tests, all in the existing files (extend, don't create new ones):
  - `test/sms.test.js`: new `describe('Twilio adapter', ...)` block — success
    payload/auth header shape, permanent-code classification, transient
    default, network-throw handling, timeout handling (mirror the existing
    Termii/AT cases).
  - `test/config.test.js`: `SMS_PROVIDER=twilio` requires all three
    `TWILIO_*` vars (each missing one at a time → collected error); valid
    Twilio config loads cleanly; existing Termii/AT cases untouched.
- Checkpoint: `npx vitest run test/sms.test.js test/config.test.js` green.

## Step 5 — `src/campaignScheduler.js`

- `createCampaignScheduler({ config, logger, db (or campaignsStore), sendSms, now?, sleep? })`
  — mirrors `processor.js`'s shape closely enough that someone who already
  understands `processor.js` can read this in one pass:
  - `running` single-flight flag, same skip-if-overrunning behavior.
  - `run()`: `listDueCampaigns(now())`, group by `tenant_id`, per-tenant
    try/catch isolation (one tenant's DB/send error never stops another's
    campaigns).
  - Per tenant: for each due campaign, set `status='processing'` if still
    `pending` (persisted immediately), call `ensureRecipients(...)`, then
    `pendingRecipients(campaignId, config.maxCampaignRecipientsPerTick)` and
    send each via `sendSms` — reusing `config.dryRun` /
    `config.effectiveGlobalTestNumber` exactly the way `processor.js` does
    (same override-resolution logic; consider extracting `resolveRecipient`
    out of `processor.js` into a shared tiny helper if that avoids copy-paste
    — judgment call at implementation time, not a spec change).
  - `recordRecipientResult` immediately after each send; `recomputeCampaignStatus`
    once the tenant's due campaigns for this tick are processed.
- `test/campaignScheduler.test.js` (fake `db`/stores, fake `sendSms`, fake
  `now`), covering: single-flight skip, per-tenant isolation (one tenant
  throws, others still process), transient failure leaves recipient
  `pending`, permanent failure marks `failed` and doesn't retry, bulk-guard
  caps sends per tick and leaves the remainder `pending`, `DRY_RUN` marks sent
  without calling `sendSms`, `campaigns.status` ends up correct in all-sent /
  partial / all-failed scenarios, a crash between two sends (simulated by
  throwing after N calls) leaves exactly the un-sent recipients `pending` on
  the next `run()`.
- Checkpoint: `npx vitest run test/campaignScheduler.test.js` green.

## Step 6 — `tenants.js`: `syncContactsFromSheet`

- In `validateTenant`, add (near the existing `channel`/`testNumber` optional
  parsing): `syncContactsFromSheet: raw.syncContactsFromSheet === true`
  (defaults to `false` for anything else — absent, wrong type, truthy
  non-boolean — same permissive-default style as the other optional fields).
  Add to the `Tenant` typedef and the returned object.
- `tenants.example.json`: add `"syncContactsFromSheet": false` to the example
  entry with a one-line comment-equivalent (the file is pure JSON, so put the
  explanation in `README.md`'s tenant-config section instead, if one exists —
  check at implementation time).
- `test/tenants.test.js`: add a case asserting the field defaults to `false`
  when absent and parses `true` when present; confirm an existing fixture
  tenant without the field still validates identically to before.
- Checkpoint: `npx vitest run test/tenants.test.js` green.

## Step 7 — `processor.js`: the `onNotified` hook

- The **only** change to `processor.js`: `createProcessor(deps)` destructures
  an optional `deps.onNotified`. Inside `processRow`, in the `if (result.ok)`
  branch, immediately after the existing `safeWrite(...)` call and
  `summary.sentOk += 1`, add:
  ```js
  if (deps.onNotified && !config.dryRun) {
    try {
      deps.onNotified(tenant, { name: row.name, phone: e164 });
    } catch (err) {
      log.error('onNotified hook failed (isolated)', { orderId: row.orderId, error: err?.message ?? String(err) });
    }
  }
  ```
  (Placement/exact wording at implementation time — the binding constraints
  from the spec are: only on `result.ok`, never during `dryRun`, uses `e164`
  not `recipient`, wrapped so it can't fail the row/tick.)
- `test/processor.test.js`: add cases — `onNotified` called with
  `(tenant, {name, phone})` on success; not called on transient failure; not
  called on permanent failure; not called when `config.dryRun` is true; a
  throwing `onNotified` doesn't fail the row (send-success bookkeeping
  — `summary.sentOk`, the write-back — still happens); **every existing test
  in this file passes unmodified** (they don't pass `onNotified`, so this is
  the regression check that the hook is truly optional).
- Checkpoint: `npx vitest run test/processor.test.js` green, plus a full
  `npm test` to confirm nothing else regressed.

## Step 8 — `index.js` wiring + `.env.example`

- `src/index.js`: after building `sendSms`, construct `const db =
  createDb(config.dbPath)`, `const contactsStore = createContactsStore(db)`,
  `const campaignsStore = createCampaignsStore(db)`. Define
  `onNotified(tenant, contact)` as a closure: `if
  (!tenant.syncContactsFromSheet) return;` then call
  `contactsStore.upsertContact(tenant.id, contact)` (already synchronous;
  no promise to await, but still guard with try/catch — `better-sqlite3`
  throws synchronously on constraint errors, and this call sits inside the
  `onNotified` try/catch added in Step 7 either way). Pass `onNotified` into
  `createProcessor({...})`.
- Construct `const campaignScheduler = createCampaignScheduler({ config,
  logger, campaignsStore, sendSms })` and start a second `setInterval` at
  `config.campaignTickIntervalMs`, running immediately like the existing
  `tick()` does, with its own try/catch-and-log wrapper. Both intervals are
  cleared in the existing `shutdown()` handler.
- `config.js`: add `dbPath` (default `data/platform.db`),
  `campaignTickIntervalMs` (`parseIntEnv`, default `10000`),
  `maxCampaignRecipientsPerTick` (`parseIntEnv`, default `50`) — same
  fail-fast collection pattern as the existing interval/cap options.
- `.env.example`: document `DB_PATH`, `CAMPAIGN_TICK_INTERVAL_MS`,
  `MAX_CAMPAIGN_RECIPIENTS_PER_TICK`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
- No dedicated test file for `index.js` (matches current convention — it's
  the composition root and isn't unit-tested today either); verified instead
  by the full suite plus a manual smoke run (Step 9).
- Checkpoint: `npm test` (full suite) green.

## Step 9 — manual smoke check

- Copy `.env.example` → local test `.env` with `DRY_RUN=true` and a scratch
  `tenants.json` with one tenant that has `syncContactsFromSheet: true`
  pointed at a small real or dummy sheet.
- `npm run dev`; confirm in the logs: the sheet tick runs as before; the new
  campaign tick starts on its own interval and logs "no due campaigns" (empty
  `campaigns` table); `data/platform.db` is created on disk automatically.
- Manually insert one test contact and one immediately-due campaign via a
  throwaway Node REPL/script calling `createContactsStore`/`createCampaignsStore`
  directly (there's no HTTP API yet — that's expected, per the spec's
  explicit out-of-scope list); confirm the next campaign tick sends it (or,
  under `DRY_RUN`, logs it) and `campaign_recipients`/`campaigns.status`
  update correctly.
- This step has no automated checkpoint by design (no UI/API exists yet to
  drive it any other way) — it's a one-time manual confirmation that the
  wiring in Step 8 actually runs end-to-end, not a repeatable test.

## Out of scope reminders (carried from the spec)

No dashboard UI, no auth, no HTTP API, no voice channel in this plan — those
are later sub-projects per the spec's Context section.
