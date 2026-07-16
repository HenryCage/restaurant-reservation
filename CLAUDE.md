# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                       # install (Node 20+ required; uses native fetch + ESM)
npm start                    # run the backend (node src/index.js) -- sheet engine + campaign scheduler + HTTP API
npm run dev                  # run with --watch (restart on file change)
npm test                     # vitest run (all suites, no network)
npm run test:watch           # vitest in watch mode
npx vitest run test/processor.test.js          # single suite
npx vitest run -t "transient"                  # single test by name

cd client && npm ci           # install the dashboard's own deps (separate npm project)
cd client && npm run dev      # Vite dev server (localhost:5173) -- needs VITE_API_BASE_URL, see below
cd client && npm run build    # production bundle -> client/dist, served by the backend when NODE_ENV=production
cd client && npm test         # vitest run (jsdom + React Testing Library)
```

No build step for the backend itself and no linter configured anywhere. Local runs need a backend `.env` (copy `.env.example`). There is no `tenants.json`/`TENANTS_FILE` anymore — tenant configuration lives in SQLite (`DB_PATH`, created automatically); `scripts/migrate-tenants.mjs` is a one-time importer for a legacy `tenants.json` file if you're migrating an old deployment. For local dashboard development, copy `client/.env.example` to **`client/.env.development`** (not plain `client/.env` — Vite loads plain `.env` in every mode including production builds, which previously leaked a dev-only backend URL into a production bundle).

## What this is

A multi-tenant SMS + campaigns platform. Two independent send paths share one tenant fleet and one SMS layer:

1. **The original reactive engine**: polls each tenant's Google Sheet of delivery orders and texts the customer when a row's **Status** enters a notifiable value, then writes markers back to the row so it isn't re-sent. `SMS_Dispatch_MVP_Build_Spec.md` is this engine's authoritative spec; source comments in `processor.js`/`sheets.js`/`message.js`/`phone.js` cite its section numbers (e.g. "spec §7"). The Sheet is still the sole source of truth for **order data** — nothing else stores it.
2. **A manual/scheduled campaign engine** (`campaigns.js` + `campaignScheduler.js`): send a message to saved contacts (all, or one), on demand or at a scheduled time. Fully separate tick/dependency set from the sheet engine.

Everything else — tenant configuration, contacts, campaigns, users/sessions — lives in SQLite (`platform.db`, `db.js`). This is a real shift from the project's original "no database, the sheet plus tenants.json are the only state" design: tenant config moved to SQLite (Tenant management spec), then users (User management spec), and the sheet engine and campaign engine were both rewired onto the same tenant store. Each numbered sub-project after the original build has its own spec + implementation plan under `docs/superpowers/{specs,plans}/YYYY-MM-DD-<topic>-{design,plan}.md` — check there before assuming a behavior is undocumented.

A full HTTP API (`src/http/`) and a React dashboard (`client/`) sit on top: tenant users log in and see their own contacts/campaigns/orders; a superadmin sees a fleet-wide console (tenant list, per-tenant user management, a separate superadmin roster) with no blind "type an ID" pickers anywhere.

**SMS provider selection is per-tenant, not global** (reversed from the original design): each tenant picks Termii, Africa's Talking, or Twilio and enters that provider's own credentials via the dashboard; there is no `.env`-level fallback. A tenant with no provider configured simply doesn't send (loudly logged, nothing marked/parked) until a superadmin fills one in.

## Architecture

Entry point [src/index.js](src/index.js) loads config, wires dependencies via constructor injection, and drives **two independent interval loops** (the sheet processor and the campaign scheduler) plus the HTTP server. Every module exposes a `create*` factory that takes its collaborators as arguments — **all I/O (db, registry, Google Sheets, SMS, `fetch`, clock, sleep) is injected**, which is why every loop is unit-tested with mocks and never touches the network. When adding a module, follow this factory + injected-deps pattern so it stays testable.

1. **[src/db.js](src/db.js)** — opens `platform.db` (SQLite, WAL mode) and ensures the schema. **Self-healing columns**: a brand-new table can go straight in the `CREATE TABLE IF NOT EXISTS` literal, but a column added to a table that *already exists in deployed databases* (`users`, `tenants`) cannot — the literal alone won't retroactively `ALTER` it. Those columns (`users.active`, `tenants.sms_provider`/`sms_credentials_json`/`default_country_code`) are added via a small guarded `ALTER TABLE ... ADD COLUMN`, run on every open and skipped if the column already exists. Follow this pattern for any future column on an existing table.

2. **[src/tenants.js](src/tenants.js)** — `createTenantRegistry({ db, logger })`; `registry.load()` re-reads the `tenants` table every tick. Two robustness invariants live here and must be preserved: (a) a whole-query read failure keeps the **last-known-good** in-memory set rather than zeroing the fleet; (b) an individual invalid tenant is skipped-and-logged, never fatal. `senderId` must be unique across *active* tenants (cross-tenant impersonation guard). `canonicalStatus()` (trim + lowercase) is the single source of truth for all status/template comparison. `registry.listAll()/create()/update()` back the superadmin dashboard (full CRUD, `PATCH` is a partial merge) — `validateTenant`/`validateRegistry`/`canonicalStatus` are pure and have never changed across the file→SQLite migration or any field added since; only what gets mapped into their "raw" input shape changes. `smsCredentials` is the one field that does **not** follow "whole value replaces whole value" on update: an empty string per key means "keep what's already stored" (lets a masked secret field stay blank in the UI), and only the *incoming* object's keys survive a merge (switching provider correctly drops the old provider's stale fields instead of keeping them forever). `maskSmsCredentials()` masks the one genuinely secret field per provider (last 4 chars visible) — applied only at the HTTP response boundary, never to what's stored or what the sending path reads.

3. **[src/processor.js](src/processor.js)** — the sheet-engine tick (`createProcessor().run()`). Key guarantees, each load-bearing:
   - **Single-flight**: a `running` flag makes an overrunning tick skip the next fire rather than overlap.
   - **Per-tenant isolation**: one tenant (or one row) throwing never stops the others — both levels are wrapped in try/catch.
   - **No SMS provider configured** → the tenant is skipped entirely for that tick (one warning log, sheet never even read, no row touched) rather than treated as a per-row failure.
   - **Send-then-write-back-immediately** (per row, not batched): a crash re-sends *at most one* message. This is the exactly-once-under-normal-operation / at-least-once-on-crash boundary — do not batch writes.
   - **Eligibility**: `status ∈ notifyStatuses` AND `canonicalStatus(status) != canonicalStatus(lastNotifiedStatus)` AND phone normalises to a valid number.
   - **Transient vs permanent failure**: transient leaves `Last Notified Status` unchanged (retries next tick); permanent *sets* `Last Notified Status` to park the row (inert until the customer's `Status` changes). There is no attempts counter — the sheet is the state machine.
   - **Bulk-edit guard**: more than `MAX_SENDS_PER_TENANT_PER_TICK` eligible rows → send the cap, warn loudly, defer the rest.
   - `sendSms` is resolved **per tenant, per tick** via the injected `smsSenderFactory.forTenant(tenant)` — never a single shared function.

4. **[src/campaignScheduler.js](src/campaignScheduler.js)** — sibling tick for on-demand/scheduled campaigns, same discipline as processor.js (single-flight, per-tenant isolation, unconfigured-provider skip, bulk-edit guard, transient/permanent handling) but driving `campaigns.js`'s contacts instead of sheet rows. Deliberately duplicates small helpers (`resolveRecipient`/`countryCodeFor`) rather than importing from processor.js, to keep each module's dependency surface independent.

5. **[src/contacts.js](src/contacts.js)** / **[src/campaigns.js](src/campaigns.js)** — per-tenant SQLite stores. `createContact()` is the human/manual "add contact" path (rejects a duplicate phone with a clear error, takes an optional per-call `countryCode` override); `upsertContact()` is the sheet-sync path (silent, idempotent — opt-in per tenant via `syncContactsFromSheet`, and only on a real successful send). `campaigns.ensureRecipients()` snapshots target contacts' phones into `campaign_recipients` at send time.

6. **[src/message.js](src/message.js)** — pure templating. `{name}`, `{orderId}`, `{amount}`; `[[ ... ]]` clauses drop entirely if any placeholder inside is empty. Sheet-sourced text is sanitised (control chars stripped, length capped). Amounts are parsed to whole naira with thousands grouping. Keep message text plain ASCII (`NGN`, never `₦`).

7. **[src/sms/index.js](src/sms/index.js)** — `createSmsSenderFactory({ config, deps }).forTenant(tenant)` builds the adapter for **that tenant's** `smsProvider`/`smsCredentials` (no global provider, no fallback) and normalises every outcome to `{ ok, providerMessageId?, error?, permanent? }`. A thrown adapter error, or a tenant with no provider configured, is coerced to a **transient** failure. Adapters ([termii.js](src/sms/termii.js), [africasTalking.js](src/sms/africasTalking.js), [twilio.js](src/sms/twilio.js)) classify provider errors into permanent (invalid recipient/sender) vs transient (429/5xx/auth/network), defaulting to transient when unsure. All requests go through [httpClient.js](src/sms/httpClient.js) (`requestWithTimeout`). The adapter modules themselves never change when the provider-selection logic changes — only where their constructor arguments come from.

8. **[src/sheets.js](src/sheets.js)** — columns are mapped **by header name** (case-insensitive, trimmed), never by fixed position. Reads use `FORMATTED_VALUE` so Phone/Amount arrive as typed strings. Write-back is **cell-scoped** to only the three service-owned columns (`Last Notified Status`, `Notified At`, `Last Error`) via `values.batchUpdate` — never a row-level write. Pure helpers (`parseOrders`, `buildColumnIndex`, `buildWriteData`, `columnIndexToLetter`) are tested without googleapis.

9. **[src/phone.js](src/phone.js)** — tolerant on input (strips all formatting), strict on output (`null` for anything invalid). `isValidE164(e164)` judges a number **purely by its own `"+"` prefix**, never against a caller-supplied default: `+234...` gets Nigeria's strict mobile shape (`+234[789]XXXXXXXXX`), anything else gets a generic 8–15-digit E.164 check. This matters because a `"+"`-prefixed number from any country must never be rejected just because it doesn't match some unrelated default — that was a real, twice-reported production bug. `normalisePhone(raw, countryCode)` still needs `countryCode` to construct a **bare** (no `"+"`) national number (drop a leading trunk `0`, or prepend the country code) — that default now comes from `tenant.defaultCountryCode || config.defaultCountryCode` (per-tenant override, resolved via `countryCodeFor(tenant)` in processor.js/campaignScheduler.js), not a single global value. A `"+"`-prefixed number always wins regardless of any default.

10. **[src/config.js](src/config.js)** — `loadConfig(env)` is pure (reads a passed-in env object) and fail-fast: it collects *all* problems and throws once. There is **no** `SMS_PROVIDER`/`TERMII_*`/`AT_*`/`TWILIO_*`/`TENANTS_FILE` here — those were removed once SMS credentials and tenant config both moved per-tenant into SQLite; don't re-add them. `GOOGLE_PRIVATE_KEY`'s literal `\n` sequences are un-escaped to real newlines here. `HTTP_TIMEOUT_MS` and `DEFAULT_COUNTRY_CODE` remain global (shared transport setting / fallback default respectively).

11. **[src/logger.js](src/logger.js)** — logs are the operator's only observability surface (no metrics server). Every line is timestamped and, when scoped via `.child(tenantId)`, tagged `[tenant:<id>]`. Use `maskPhone()` for any phone number in a log line; never log secrets/API keys.

12. **[src/auth.js](src/auth.js)** — scrypt password hashes (`node:crypto`), server-side sessions (SQLite + httpOnly cookie, not JWT). A user is either a tenant user (`tenantId` set) or a superadmin (`tenantId` null) — never both, never neither, and there is no promotion path between the two after creation. `deactivate()` soft-deletes (an `active` flag, not a row delete) and **immediately kills that user's sessions**; rejects deactivating the last active superadmin. `resetPassword()` mirrors `createUser()`'s temp-password flow. `listByTenant()`/`listSuperadmins()` back the two superadmin user-management views.

13. **[src/http/server.js](src/http/server.js)** — Express app factory. `requireAuth` + `resolveTenantId` (a non-superadmin is always forced to their own tenant; a superadmin must pass `?tenantId=` explicitly, never an implicit "all tenants" view) gate `/api/contacts|campaigns|orders`; `requireSuperadmin` (separate, simpler — no tenant-scoping concept at all) gates `/api/tenants|users`. `PATCH` routes are partial merges. In production (`NODE_ENV=production`) the same server also serves the built dashboard (`client/dist`) with an SPA-shell fallback for client-side routes, ordered before the JSON 404 so `/api/*`/`/auth/*` 404s are unaffected.

14. **[client/](client/)** — separate npm project: React 19 + Vite + Tailwind v3, Vitest + React Testing Library. No client-side router — `App.jsx` is a top-level auth-state machine driven by `GET /auth/me` (`loading → login → changePassword → dashboard`, or for a superadmin, `→ TenantListScreen` first). **The superadmin's landing screen is the tenant list itself** (`TenantListScreen`, with per-row Dashboard/Users/Edit actions) — there is no blind "type a tenant ID" picker; that screen was tried live, found too thin, and retired. `TenantFormScreen` has a provider dropdown showing only that provider's credential fields (secrets start blank in edit mode with masked helper text) and a "Default Country Code" select. `UserListScreen` is shared by a tenant's user list and the separate superadmin roster via a `scope` prop, rather than two near-duplicate files.

## Conventions

- **ESM only** (`"type": "module"`); use `import`, native `fetch`, and `node:`-prefixed builtins.
- Pure logic and I/O are deliberately separated in every module so tests hit the pure functions directly and inject fakes for the rest. `test/` mirrors `src/` one-to-one; `client/`'s tests sit next to their component.
- `.env` (backend) and `client/.env.development` (dashboard dev mode) are gitignored and hold secrets — never commit them; edit the `*.example.*` files for documentation. There is no `tenants.json` in normal operation anymore (see Commands).
- Safety modes are layered: `DRY_RUN=true` logs instead of sending (rows/recipients still marked); `GLOBAL_TEST_NUMBER` redirects every message but is **ignored when `NODE_ENV=production`**; a per-tenant `testNumber` does the same per tenant. All three apply identically to both the sheet engine and the campaign scheduler.
- **Google Sheets phone-entry gotcha**: typing a leading `"+"` into a cell makes Sheets try to parse it as a formula. The fix is a leading apostrophe (`'+37012345678`) — the apostrophe itself never reaches the API (reads use `FORMATTED_VALUE`), so this is transparent to `phone.js`. Known to be a little clunky; revisit if it becomes a recurring complaint.
- Secret-bearing fields (SMS credentials) are masked in every HTTP response (last 4 chars) and require re-entry to change — the real value never round-trips back to the browser. Follow this convention for any future secret-bearing tenant field.

## Operational note

Run **exactly one instance** under a restart-on-crash supervisor (systemd `Restart=always`, PM2, container policy). The single-flight guard only prevents overlap *within* one process, and it's per-loop (the sheet processor and the campaign scheduler each have their own) — there is no leader election. Fatal errors call `process.exit(1)` by design so the supervisor restarts from a clean state. "Gateway success" means *accepted*, not *delivered* — delivery reports are out of scope. Any change to `config.js`, `.env`, or the SQLite schema requires a process restart to take effect — env vars and schema self-healing both run once at startup, not on a hot path.
