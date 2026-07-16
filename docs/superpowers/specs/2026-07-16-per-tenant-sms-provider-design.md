# Per-tenant SMS provider

Date: 2026-07-16
Status: designed, not yet implemented.
Depends on: Tenant management (tenant config lives in SQLite `tenants` table,
`requireSuperadmin`-gated CRUD, `TenantFormScreen`/`TenantListScreen`), all
implemented.

## Context

SMS provider selection has been **global/process-wide** since the very first
spec in this repo (locked in the Foundation merge design): one provider,
configured once via `.env`, shared by every tenant. The user asked for each
tenant to pick its own SMS provider and enter that provider's credentials
through the tenant form, with only the fields relevant to the chosen
provider shown — "kad tenants gales naudotis skirtingais tenantais [tiekėjais]."

## Decisions made during brainstorming

- **No fallback to the global config.** Every tenant must have its own
  provider configured; a tenant without one simply doesn't send (see
  "Sending-path behavior" below), rather than silently reusing a shared
  `.env` provider. This is a deliberate reversal of the original
  "global/process-wide" decision.
- **No automated migration for the two existing tenants** (Swift Logistics,
  Lagos Couriers). After this ships, both are temporarily unconfigured and
  their sends pause (loudly logged, not silently dropped) until a superadmin
  fills in a provider via the UI. Accepted as a brief, known interruption.
- **The now-unused global `SMS_PROVIDER`/`TERMII_*`/`AT_*`/`TWILIO_*` env
  vars are removed entirely** from `config.js`/`.env.example`, the same way
  `TENANTS_FILE` was removed once nothing read it after the tenant-management
  migration. `HTTP_TIMEOUT_MS` stays global (shared transport setting, not
  provider-specific).
- **Secret fields are masked in every API response** (`GET/POST/PATCH
  /api/tenants`) and require re-entry to change — the real value never
  round-trips back to the browser after it's first saved.

## Architecture

`src/sms/index.js`'s `createSmsSender(config)` currently builds **one**
adapter at process startup from the global config. It becomes
`createSmsSenderFactory({ config, deps })`, returning `{ forTenant(tenant) }`
— given a tenant, builds the adapter for `tenant.smsProvider` using
`tenant.smsCredentials`, instead of reading `config.smsProvider`/
`config.termii`/etc. **The three adapter modules themselves
(`termii.js`/`africasTalking.js`/`twilio.js`) do not change at all** — they
already accept a plain `{ apiKey, baseUrl, timeoutMs, fetchFn }`-shaped
object; only where those values come from changes. `httpTimeoutMs` and
`fetchFn` still come from the global config/deps (shared transport setting,
not per-tenant).

`processor.js` and `campaignScheduler.js` already iterate tenants in their
tick loop, so each gains one line at the top of a tenant's block:
`const sendSms = smsSenderFactory.forTenant(tenant);`, replacing the single
injected `sendSms` function they receive today. The per-row/per-recipient
call sites (`sendSms(to, message, { senderId, channel })`) are unchanged.

**Sending-path behavior for an unconfigured tenant** (`tenant.smsProvider ===
''`): the tenant is skipped entirely for that tick, with one loud warning
log line (matching the existing bulk-edit-guard warning style) — **no row's
`Last Notified Status` is touched**, so once a superadmin configures the
tenant, the next tick picks up every pending row normally. This mirrors the
existing per-tenant isolation invariant (one tenant's problem never corrupts
its own or another tenant's state) rather than introducing a new failure
mode.

```
src/
  sms/
    index.js              # modified: createSmsSender(config) -> createSmsSenderFactory({config,deps}).forTenant(tenant)
    termii.js                # unchanged
    africasTalking.js          # unchanged
    twilio.js                    # unchanged
  tenants.js               # modified: smsProvider/smsCredentials in raw shape, validation, masking helper, merge-by-key on update
  db.js                     # modified: two more self-healing ALTER-ed columns on `tenants`
  processor.js              # modified: sendSms resolved per-tenant via the factory
  campaignScheduler.js       # modified: same
  config.js                  # modified: SMS_PROVIDER/TERMII_*/AT_*/TWILIO_* removed entirely
client/src/
  screens/
    TenantFormScreen.jsx        # modified: provider dropdown + conditional credential fields
    TenantListScreen.jsx         # modified: SMS Provider column, "not configured" badge
```

## Data model

`tenants` already exists in every deployed database (including the real one,
just migrated) — same as `users.active`, new columns go through `db.js`'s
self-healing `ALTER TABLE` step, not the `CREATE TABLE` literal:

```sql
ALTER TABLE tenants ADD COLUMN sms_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN sms_credentials_json TEXT NOT NULL DEFAULT '{}';
```

`sms_provider`: `''` (unconfigured), `'termii'`, `'africastalking'`, or
`'twilio'`. `sms_credentials_json`: a JSON object whose shape depends on the
provider (same pattern as `templates_json` already being provider/status-
shaped):

| provider | fields |
|---|---|
| termii | `apiKey`, `baseUrl` |
| africastalking | `apiKey`, `username` |
| twilio | `accountSid`, `authToken`, `fromNumber` |

`rowToRaw()` gains `smsProvider: row.sms_provider` and
`smsCredentials: JSON.parse(row.sms_credentials_json)`.

**Validation** (`validateTenant`, same pure-function-with-unit-tests
convention as every other field): `smsProvider` must be `''` or one of the
three known values. If non-empty, that provider's required fields (per the
table above) must all be non-empty strings — the exact provider-conditional
requiredness `config.js` already enforces today, just re-homed per-tenant.
An empty `smsProvider` is valid (the "not yet configured" state).

**Update merge rule** — the one field on a tenant that does **not** follow
the existing "whole value replaces whole value" PATCH convention
(`notifyStatuses`/`templates` already replace wholesale every save):
for each key in an incoming `smsCredentials` object, an **empty string**
means "keep whatever is already stored for that key" rather than "clear it."
A non-empty string always overwrites. This is what lets a masked secret
field stay blank in the UI without accidentally wiping the real stored
value, and it correctly handles a provider switch too: switching from Termii
to Twilio means the existing stored object has no `accountSid`/`authToken`
keys at all, so a blank required field simply stays blank and validation
rejects it with a clear "required" error — no special-casing needed for the
provider-switch case. On **create** there is no existing row to merge
against at all, so this rule degrades naturally: a blank field simply stays
blank and, if that provider requires it, validation rejects it — a new
tenant can never accidentally "inherit" credentials from nowhere.

## API and masking

No new routes — `POST /api/tenants` and `PATCH /api/tenants/:id` (already
`requireSuperadmin`-gated) accept `smsProvider`/`smsCredentials` like any
other field, validated as above.

A new pure helper, `maskSmsCredentials(provider, credentials)`, masks the
one genuinely secret field per provider (`apiKey` for termii/
africastalking, `authToken` for twilio) to a last-4-visible form (e.g.
`••••ab12`); every other field (`baseUrl`, `username`, `accountSid`,
`fromNumber`) is returned as-is — those aren't secrets, they're closer to
account identifiers. This masking is applied **only at the HTTP response
boundary** — `GET /`, and the tenant returned by `POST /`/`PATCH /:id` — the
underlying stored value and everything the sending path reads
(`registry.load()` → `smsSenderFactory.forTenant()`) is never masked.

## UI

`TenantFormScreen` gains an **SMS Provider** dropdown (blank / Termii /
Africa's Talking / Twilio) and, beneath it, only the fields relevant to
whichever is selected. Secret fields (API Key, Auth Token) are `password`-
type inputs that start **empty** in edit mode, with helper text underneath
reading "Currently set: ••••ab12 — leave blank to keep unchanged" (using the
already-masked value the list fetch already returned — no extra request
needed). In create mode that helper text doesn't apply; a selected provider
makes its fields required.

`TenantListScreen`'s table gains an **SMS Provider** column showing the
provider name, or a red "not configured" badge when `smsProvider` is empty —
visible at a glance which tenants are currently not sending anything.

## Testing

- `test/db.test.js` — self-healing test for the two new `tenants` columns
  (same reopen-the-same-file pattern already used for `users.active`).
- `test/tenants.test.js` — `validateTenant`: each provider's required-field
  rules; empty provider allowed; unknown provider name rejected.
  `update()`'s empty-string-means-keep-existing merge, including the
  provider-switch case leaving a stale key behind correctly.
- `test/sms.test.js` — `createSmsSenderFactory().forTenant(tenant)` picks
  the right adapter and credentials per tenant; unchanged adapter-level
  tests (Termii/Africa's Talking/Twilio request-shape/error-classification)
  untouched.
- `test/processor.test.js` / `test/campaignScheduler.test.js` — a tenant
  with `smsProvider === ''` is skipped for the tick with a warning log, no
  row's `Last Notified Status` touched.
- `test/http/tenantsRoutes.test.js` — masking on `GET`/`POST`/`PATCH`
  responses; an empty-string secret field in a `PATCH` body does not
  overwrite the stored credential.
- Frontend: `TenantFormScreen`/`TenantListScreen` component tests for the
  new fields, conditional rendering, and the "not configured" badge.
- Live Playwright smoke test once implemented: configure a tenant with
  fake Termii credentials, confirm the masked value round-trips correctly
  on re-edit without needing to re-type it, switch that same tenant to a
  different provider and confirm the old provider's fields are gone and the
  new ones are required.

## Explicitly out of scope

- Automated migration of the two existing tenants' provider config from the
  (now-removed) global `.env` — manual, via the UI, per the locked decision.
- Any change to the three adapter modules' own request/response handling —
  only where their constructor arguments come from changes.
- Per-tenant `httpTimeoutMs` or transport-level overrides — stays global.
