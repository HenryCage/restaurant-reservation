# Implementation plan: Per-tenant SMS provider

Spec: `docs/superpowers/specs/2026-07-16-per-tenant-sms-provider-design.md`
Status: implemented and committed (all 8 steps). Step 8's live browser
walkthrough (Playwright, production build, scratch tenant) passed 17/17
real checks: an unconfigured tenant shows a "not configured" badge and is
skipped at send time with a warning log (confirmed in the server's own
output, not just a unit test); configuring Termii then re-editing without
touching the API Key field preserves the real stored value (confirmed via
a direct read of the scratch SQLite file); switching to Twilio drops the
stale Termii fields/helper text, requires Twilio's own fields client-side,
and the final stored row exactly matches what was submitted.

## Sequencing rationale

Schema (self-healing, riskiest since `tenants` is already deployed) → pure
validation/masking/merge logic in `tenants.js` → the adapter-selection
factory in `sms/index.js` (adapters themselves untouched) → sending-path
wiring in `processor.js`/`campaignScheduler.js`/`index.js` → removal of the
now-dead global config → HTTP masking → frontend → live smoke check.
`npm test` (backend) and `cd client && npm test` stay green after their
respective steps.

Three implementation-level decisions the spec left open, resolved here:

1. **How `smsCredentials`'s per-key "empty means keep existing" merge is
   implemented.** `tenants.js`'s `update()` currently does a flat
   `{ ...rowToRaw(existingRow), ...safePatch, id }` spread, which for every
   other field is exactly "whole value replaces whole value." A new private
   helper `mergeSmsCredentials(existing, incoming)` is applied specifically
   to `safePatch.smsCredentials` (when present) before that spread: it
   iterates **only `incoming`'s keys** (exactly the fields the form
   rendered for the currently-selected provider) and for each takes the
   incoming value if it's a non-empty string, else falls back to
   `existing`'s value under that same key. A key that exists only in
   `existing` (a previous, now-unselected provider's field) is dropped, not
   carried forward — caught by a test expecting a provider switch to leave
   the new provider's `smsCredentials` containing *only* that provider's
   fields, which failed against a first union-based implementation that
   left the old provider's stale keys lingering.
2. **How the sending path avoids a large mechanical rewrite of
   `test/processor.test.js`/`test/campaignScheduler.test.js`.** Both files
   inject a single `sendSms` function today and have ~20-25 call sites each
   building `createProcessor({ ..., sendSms, ... })` /
   `createCampaignScheduler({ ..., sendSms, ... })`. Rather than change what
   gets passed to `sendSms` itself (which would touch every assertion that
   reads `sendSms.calls[i].opts...`), the injected **dependency name**
   changes from `sendSms` to `smsSenderFactory` (an object,
   `{ forTenant(tenant) => sendSmsFn }`), and each test's existing
   `makeSendSms()`-built fake is wrapped with a new one-line helper
   `makeSmsSenderFactory(sendSms) => ({ forTenant: () => sendSms })`. Every
   call site changes exactly one line (`sendSms,` →
   `smsSenderFactory: makeSmsSenderFactory(sendSms),`); every existing
   assertion on `sendSms.calls[...]` is untouched, since `sendSms` still
   records calls exactly as it always did.
3. **Where the "unconfigured tenant" skip happens.** Both `processor.js`'s
   `processTenant(tenant)` and `campaignScheduler.js`'s
   `processTenantCampaigns(tenant, campaigns)` gain an early check —
   `if (tenant.smsProvider === '') { log.warn(...); return <empty summary>; }`
   — **before** any Sheets/DB read for that tenant, so an unconfigured
   tenant costs nothing per tick beyond one log line, and no row/recipient
   state is touched at all.

## Step 1 — self-healing `sms_provider`/`sms_credentials_json` columns

- `src/db.js`: new `ensureTenantsSmsColumns(db)`, sibling to the existing
  `ensureUsersActiveColumn(db)`, same `PRAGMA table_info` guard pattern —
  `ALTER TABLE tenants ADD COLUMN sms_provider TEXT NOT NULL DEFAULT ''`
  and `ALTER TABLE tenants ADD COLUMN sms_credentials_json TEXT NOT NULL DEFAULT '{}'`,
  each only if missing. Called from `createDb()` alongside the existing call.
- `test/db.test.js`: extend the existing tenants round-trip test to assert
  the two new columns default correctly; new reopen-the-same-file case
  (same pattern as `users.active`'s test) proving a second `createDb()`
  call against a file that already has the columns doesn't throw.
- Checkpoint: `npx vitest run test/db.test.js`.

## Step 2 — `src/tenants.js`: fields, validation, masking, merge

- `rowToRaw(row)`: add `smsProvider: row.sms_provider` and
  `smsCredentials: JSON.parse(row.sms_credentials_json)`.
- `validateTenant`: new `PROVIDER_REQUIRED_FIELDS` map
  (`termii: ['apiKey','baseUrl']`, `africastalking: ['apiKey','username']`,
  `twilio: ['accountSid','authToken','fromNumber']`); `smsProvider` must be
  `''` or a key of that map (else `skip('unknown "smsProvider" value')`);
  if non-empty, every field in that provider's list must be a non-empty
  string in `smsCredentials` (else `skip('"smsCredentials.<field>" is required when smsProvider is "<provider>"')`).
  Both land in the returned `Tenant` shape as `smsProvider`/`smsCredentials`.
- New exported pure helper `maskSmsCredentials(provider, credentials)`:
  looks up the one secret field per provider (`apiKey` for termii/
  africastalking, `authToken` for twilio), returns a shallow copy with that
  field replaced by `'••••' + last4` (or `'••••'` alone if shorter than 4
  chars); every other field passes through unchanged. Used only by the HTTP
  layer in step 6, not by `load()`/`listAll()`.
- New private helper `mergeSmsCredentials(existing, incoming)` per
  sequencing decision 1 above.
- `createTenantRegistry`'s `insertStmt`/`updateStmt`: add
  `sms_provider`/`sms_credentials_json` to the column lists and
  `.run(...)` argument lists (`JSON.stringify(validated.smsCredentials)`).
- `update(id, patch)`: after building `safePatch`, if
  `safePatch.smsCredentials` is a plain object, replace it with
  `mergeSmsCredentials(rowToRaw(existingRow).smsCredentials, safePatch.smsCredentials)`
  before the existing `{ ...rowToRaw(existingRow), ...safePatch, id }`
  spread runs.
- `test/tenants.test.js`: new cases — each provider's required-field
  rejection (one at a time missing); unknown provider name rejected; empty
  provider allowed through unchanged; `maskSmsCredentials` for all three
  providers plus a short-value edge case; `update()`'s merge — blank secret
  field preserves the stored value, non-blank overwrites, switching
  provider leaves the new provider's required fields correctly blank (and
  therefore rejected if not filled in the same patch).
- Checkpoint: `npx vitest run test/tenants.test.js`.

## Step 3 — `src/sms/index.js`: per-tenant adapter factory

- Replace `createSmsSender(config, deps)` with
  `createSmsSenderFactory({ config, deps })` returning
  `{ forTenant(tenant) }`. `forTenant` switches on `tenant.smsProvider`
  (`'termii' | 'africastalking' | 'twilio'`) and builds the matching
  adapter using `tenant.smsCredentials`'s fields instead of
  `config.termii`/`config.africasTalking`/`config.twilio` — `httpTimeoutMs`
  and `fetchFn` still come from the shared `config`/`deps`. The returned
  `sendSms` function's own body (try/catch → unified `SendResult` shape) is
  unchanged; it's only the "which adapter, which credentials" selection
  that moves from config-time to call-time. **`termii.js`/
  `africasTalking.js`/`twilio.js` are not touched at all.**
- `test/sms.test.js`: the existing `describe('createSmsSender (provider
  selector)')` block becomes `describe('createSmsSenderFactory')`, its
  cases rewritten to build a fake tenant (`{ smsProvider, smsCredentials }`)
  and call `.forTenant(tenant)`, asserting the right adapter/credentials
  were used — same assertions as today, just tenant-shaped input instead of
  config-shaped. Per-adapter describe blocks (Termii/Africa's Talking/
  Twilio request-shape and error-classification tests) are untouched.
- Checkpoint: `npx vitest run test/sms.test.js`.

## Step 4 — sending-path wiring: `processor.js`, `campaignScheduler.js`, `index.js`

- `processor.js`: `deps.sendSms` → `deps.smsSenderFactory`. In
  `processTenant(tenant)`, immediately after `const log = logger.child(tenant.id)`:
  if `tenant.smsProvider === ''`, `log.warn('tenant has no SMS provider configured; skipping this tick')`
  and return the (still-zeroed) `summary` before any Sheets read. Otherwise
  `const sendSms = smsSenderFactory.forTenant(tenant);` right after that
  check, passed through to `processRow(tenant, log, colIndex, row,
  canonStatus, e164, summary, sendSms)` (new trailing parameter), replacing
  `processRow`'s current closure-captured reference.
- `campaignScheduler.js`: same shape — `deps.smsSenderFactory`;
  `processTenantCampaigns(tenant, campaigns)` gets the same early
  unconfigured check before touching `campaignsStore`, then
  `const sendSms = smsSenderFactory.forTenant(tenant);` passed as a new
  trailing parameter into `sendToRecipient(tenant, log, campaign, recipient, sendSms)`.
- `index.js`: `const sendSms = createSmsSender(config);` →
  `const smsSenderFactory = createSmsSenderFactory({ config });`; both
  `createProcessor({ ... })` and `createCampaignScheduler({ ... })` receive
  `smsSenderFactory` instead of `sendSms`.
- `test/processor.test.js` / `test/campaignScheduler.test.js`: mechanical
  rename per sequencing decision 2 (`makeSmsSenderFactory` helper added,
  every `sendSms,` in a `createProcessor`/`createCampaignScheduler` call
  becomes `smsSenderFactory: makeSmsSenderFactory(sendSms),`); one new test
  per file — a tenant with `smsProvider: ''` produces zero `sendSms` calls,
  a warning log, and (for processor.js) leaves `Last Notified Status`
  untouched on its pending rows.
- Checkpoint: `npm test` (full backend suite).

## Step 5 — remove the now-dead global SMS config

- `src/config.js`: delete `VALID_PROVIDERS`, the `smsProvider`/`termii`/
  `africasTalking`/`twilio` locals and their provider-conditional
  validation block, and their keys from the returned frozen object.
  `describeConfig()`: drop the `sandbox`/`provider=` banner segments (no
  longer meaningful at the global level).
- `.env.example`: remove the `SMS_PROVIDER`/Termii/Africa's Talking/Twilio
  block; add a short comment pointing at the tenant edit form instead
  (mirrors how `TENANTS_FILE`'s removal was documented).
- `test/config.test.js`: remove every `SMS_PROVIDER`-conditional test case
  and the `smsProvider`/`termii`/`twilio` assertions; `baseEnv()` drops
  those keys from its defaults. Banner test drops the `provider=termii`
  assertion.
- Checkpoint: `npx vitest run test/config.test.js`, then `npm test` (full
  backend suite) to confirm nothing else referenced the removed config keys.

## Step 6 — `GET/POST/PATCH /api/tenants`: mask secrets in responses

- `src/http/routes/tenants.js`: wrap every response that includes a tenant
  object (`GET /`'s array, `POST /`'s created tenant, `PATCH /:id`'s
  updated tenant) with `maskSmsCredentials(tenant.smsProvider,
  tenant.smsCredentials)` applied to that tenant's `smsCredentials` field —
  a small local `maskTenant(tenant)` helper composing the two.
- `test/http/tenantsRoutes.test.js`: new cases — `GET /` never returns a
  raw secret (masked form present instead); creating/updating with a
  provider returns the masked credential in the response but the *stored*
  row (verified via a follow-up fetch or direct store check) has the real
  value; a `PATCH` with an empty secret field doesn't clobber the
  previously stored real value (round-trip: set real key → patch with
  blank → confirm the original real key is still what the (unmasked, test-
  only) store method returns).
- Checkpoint: `npx vitest run test/http`.

## Step 7 — Frontend: provider dropdown + conditional fields

- `client/src/screens/TenantFormScreen.jsx`: new `smsProvider` select
  (blank / Termii / Africa's Talking / Twilio) and a `smsCredentials` rows
  object in local state, keyed by field name; below the select, only the
  fields for the currently-selected provider render, each secret field as
  `type="password"` starting empty with helper text showing the tenant's
  already-masked value (from the `tenant` prop) when editing. Submission
  builds `{ smsProvider, smsCredentials }` from just the visible fields
  (an unselected/blank provider submits `smsProvider: '', smsCredentials: {}`).
- `client/src/screens/TenantListScreen.jsx`: new "SMS Provider" column —
  the provider name, or a red "not configured" badge (reusing the existing
  badge style) when empty.
- Tests: `TenantFormScreen.test.jsx` — conditional field rendering per
  provider selection, submitted payload shape, edit mode's helper text
  using the masked value already present on the tenant prop.
  `TenantListScreen.test.jsx` — provider column renders correctly,
  "not configured" badge for an empty provider.
- Checkpoint: `cd client && npm test`, then `npm run build` (production
  bundle sanity check).

## Step 8 — manual smoke check

Safe to run live with scratch/fake credentials, same discipline as the
prior two sub-projects:

- Start the server, log in as superadmin, create a scratch tenant with no
  SMS provider — confirm the "not configured" badge shows in the list and
  (if a scratch Sheets order is eligible) the tick log shows the skip
  warning, not a crash.
- Edit that tenant, select Termii, fill in a fake API key + base URL, save
  — confirm the list now shows "termii", and re-opening the edit form shows
  the masked helper text (not the real key).
- Re-edit without touching the API key field (leave it blank) but change
  another field (e.g. name) — save, then verify via a direct DB read that
  the stored `apiKey` is unchanged (proving the blank-preserves-existing
  merge actually works end-to-end, not just in unit tests).
- Switch that same tenant to Twilio — confirm the Termii fields disappear,
  Twilio's three fields are required, and saving without filling them
  produces the expected validation error.
- Clean up scratch artifacts afterward.

## Out of scope reminders (carried from the spec)

No automated migration of the two real existing tenants' provider config —
manual via the UI. No change to the three adapter modules' own request/
response handling. No per-tenant `httpTimeoutMs` override.
