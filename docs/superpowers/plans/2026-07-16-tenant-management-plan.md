# Implementation plan: Tenant management (superadmin console, part 1 of 2)

Spec: `docs/superpowers/specs/2026-07-16-tenant-management-design.md`
Status: not started

## Sequencing rationale

Schema → registry rewrite (the riskiest piece, since it touches the engine's
own config source) → config/index.js rewiring → access control → HTTP routes
→ migration CLI → frontend → live smoke check. `npm test` (backend) and
`npm test` (client) stay green after their respective steps.

Two implementation-level decisions the spec left open, resolved here:

1. **How create()/update() surface a validation error message.**
   `validateTenant` (kept deliberately unchanged, per the spec) only logs a
   reason via `logger.error(...)` and returns `null` — it doesn't return the
   message string to its caller. `create()`/`update()` pass a small
   message-capturing logger internally (the same pattern
   `test/tenants.test.js`'s `fakeLogger()` already uses for assertions) and
   surface the captured message as the HTTP 400 body, rather than modifying
   `validateTenant`'s signature.
2. **How a single create/update simulates `validateRegistry`'s whole-batch
   duplicate pre-scan.** `validateTenant` expects `ctx.dupIds`/
   `ctx.dupSenderIds` — sets of ids/senderIds that *already occur more than
   once* in the batch being validated. For a single incoming row, this plan
   builds those sets by checking whether the incoming `id`/`senderId` would
   collide with any *other* existing row (excluding the row being updated,
   for `update()`) and populating a one-element set if so — this feeds
   `validateTenant`'s existing `ctx.dupIds.has(id)` / `ctx.dupSenderIds.has(...)`
   checks the exact shape they already expect, without changing them.

## Step 1 — `tenants` table in `src/db.js`

- Add the `CREATE TABLE IF NOT EXISTS tenants (...)` statement from the
  spec's Data model section to `SCHEMA` in `src/db.js`.
- `test/db.test.js`: extend with a round-trip insert/select for `tenants`.
- Checkpoint: `npx vitest run test/db.test.js`.

## Step 2 — Rewrite `createTenantRegistry` in `src/tenants.js`

- `canonicalStatus`, `validateTenant`, `validateRegistry` — **unchanged**,
  not touched by this step at all.
- New private helper `rowToRaw(row)`: maps a SQLite `tenants` row to the
  exact raw shape `validateTenant` already expects —
  `{ id, name, active: !!row.active, sheetId: row.sheet_id, sheetName: row.sheet_name, senderId: row.sender_id, channel: row.channel, notifyStatuses: JSON.parse(row.notify_statuses_json), templates: JSON.parse(row.templates_json), testNumber: row.test_number, syncContactsFromSheet: !!row.sync_contacts_from_sheet }`.
- `createTenantRegistry({ db, logger })` (signature changes from
  `{ filePath, logger, readFile }`):
  - `.load()`: `db.prepare('SELECT * FROM tenants').all()` → map via
    `rowToRaw` → `validateRegistry({ tenants: raw }, logger)` — same
    last-known-good-on-failure / null-result handling as today, just with a
    DB query (wrapped in try/catch) instead of a file read.
  - `.listAll()`: every row (active and inactive), `rowToRaw`-mapped,
    **not** re-validated — writes only ever reach this table through
    `create()`/`update()` (both validated), so defensive re-validation on
    read isn't needed here the way the old hand-edited-file version needed
    it. Used by the admin list UI, which must show inactive tenants too.
  - `.create(raw)`: build `ctx` per decision 2 above from the current table
    contents; call `validateTenant(raw, ctx, capturingLogger)`; `null` →
    `{ ok: false, error: <captured message> }`; otherwise insert
    (`JSON.stringify` the two array/object fields, current ISO timestamp for
    `created_at`/`updated_at`) and return `{ ok: true, tenant: <rowToRaw of the new row> }`.
  - `.update(id, patch)`: `{ ok: false, notFound: true }` (a distinct
    discriminator from the validation-failure shape below, so the route in
    step 6 can map the two cases to different HTTP statuses without string-
    matching an error message) if `id` doesn't exist; merge `patch` onto
    the existing row's raw shape;
    validate via the same path as `create()` but with the row being updated
    excluded from the duplicate-checking scan; on success, update the row
    (`updated_at` refreshed) and return `{ ok: true, tenant: ... }`.
- `test/tenants.test.js`: existing `validateTenant`/`validateRegistry`
  `describe` blocks untouched. New `describe('createTenantRegistry (SQLite)')`
  block (`:memory:` db) mirroring the old file-based registry tests:
  last-known-good on a simulated query failure (e.g. close the db first),
  skip-invalid-not-fatal (insert a row that would fail `validateTenant`,
  e.g. bad `senderId`, directly via SQL, confirm `.load()` skips it and
  logs); plus new cases for `listAll()` (includes inactive), `create()`
  (success; id conflict; senderId conflict against an active tenant; senderId
  reuse against an *inactive* tenant is allowed, matching the existing
  active-only uniqueness rule), `update()` (partial merge; not-found; the
  same two conflict cases, confirming a tenant updating its *own* unchanged
  id/senderId doesn't self-conflict).
- Checkpoint: `npx vitest run test/tenants.test.js`.

## Step 3 — Retire `TENANTS_FILE` from `src/config.js`

- Remove `tenantsFile` (and the `TENANTS_FILE` env var it reads) from
  `loadConfig`'s return value and validation — nothing needs it anymore once
  step 4 rewires `index.js`.
- `test/config.test.js`: remove the `tenantsFile` default-value assertion.
- Checkpoint: `npx vitest run test/config.test.js`.

## Step 4 — `index.js`: wire the registry to `db` instead of a file path

- Reorder so `createDb(config.dbPath)` runs **before**
  `createTenantRegistry(...)` (currently the registry is constructed first;
  it now depends on `db`).
- `createTenantRegistry({ filePath: config.tenantsFile, logger })` →
  `createTenantRegistry({ db, logger })`.
- No other `index.js` change needed — `registry` is already threaded into
  `processor.js`, `campaignScheduler.js`, and `createHttpServer` exactly as
  before; only how it's *constructed* changes.
- Checkpoint: `npm test` (full backend suite) green — this step has no new
  tests of its own (covered by step 2's registry tests and the existing
  `processor.test.js`/`campaignScheduler.test.js`, which fake `registry`
  directly and are unaffected by how the real one is built).

## Step 5 — `requireSuperadmin` middleware

- `src/http/middleware/requireSuperadmin.js`: `createRequireSuperadmin({ authStore })`
  — same cookie → session → user lookup as `requireAuth`, but the pass
  condition is `user.isSuperadmin === true` (401 if no valid session at
  all, matching `requireAuth`; 403 if a valid session belongs to a
  non-superadmin). Deliberately a separate small middleware rather than a
  flag on `requireAuth`, since tenant management has no
  `must_change_password` exemption logic to share and no tenant-scoping
  concept at all — reusing `requireAuth` would mean threading through
  options that don't apply here.
- `test/http/requireSuperadmin.test.js`: fake req/res/next (mirrors
  `requireAuth.test.js`'s style) — 401 no session, 403 non-superadmin, calls
  `next()` with `req.authUser` set for a superadmin.
- Checkpoint: `npx vitest run test/http/requireSuperadmin.test.js`.

## Step 6 — `GET/POST /api/tenants`, `PATCH /api/tenants/:id`

- `src/http/routes/tenants.js`: `createTenantsRoutes({ requireSuperadmin, registry })`.
  - `GET /` → `registry.listAll()`.
  - `POST /` → `registry.create(req.body)`; `{ ok: false }` → 400 with the
    store's message; success → 201 with the created tenant.
  - `PATCH /:id` → `registry.update(req.params.id, req.body)`; a result with
    `notFound: true` → 404; a result with `ok: false` and an `error`
    message → 400; success → 200 with the updated tenant.
- `server.js`: mount `app.use('/api/tenants', createTenantsRoutes({ requireSuperadmin: createRequireSuperadmin({ authStore }), registry }))`.
  `registry` is already threaded into `createHttpServer`'s deps (used by
  `orders.js` since sub-project 3) — no new dependency wiring needed there.
- `test/http/tenantsRoutes.test.js` (new, real-server-over-fetch harness):
  full CRUD happy path; a non-superadmin tenant user gets 403 on every
  route; senderId conflict on create/update is 400; unknown id on `PATCH`
  is 404; `PATCH .../:id { active: false }` deactivates, and a subsequent
  fake-registry-driven check confirms the tenant no longer appears in
  `.load()`'s result (still visible via a follow-up `GET /`).
- Checkpoint: `npx vitest run test/http`.

## Step 7 — `scripts/migrate-tenants.mjs`

- Thin CLI (matches `create-user.mjs`'s shape): reads `tenants.json` from a
  `--file=` arg (default `./tenants.json` — deliberately not coupled to
  `config.tenantsFile`, which step 3 removed; this script is a standalone,
  one-time tool), parses it, and for each entry calls the same
  `registry.create(raw)` path used by the HTTP API (so migrated data goes
  through identical validation) — reports per-entry success/failure to
  stdout, non-zero exit if any entry failed, so a partial migration is
  never silently declared a success.
- No automated test (per the spec and matching `create-user.mjs`'s
  precedent — the logic it calls, `create()`, is already covered in step
  2); verified manually in step 9.

## Step 8 — Frontend: `TenantListScreen` + `TenantFormScreen`

- `client/src/screens/TenantListScreen.jsx`: fetches `GET /api/tenants` on
  mount (no polling needed — this is an infrequently-changing admin view,
  unlike the 5s/45s polling elsewhere); table with an active/inactive badge;
  "Edit" per row, "Create new tenant", "← Back" (to the tenant picker).
- `client/src/screens/TenantFormScreen.jsx`: shared create/edit form;
  `id` field disabled when editing (`props.mode === 'edit'`); a dynamic
  notifyStatuses/templates editor — an array of `{ status, template }` rows
  in local state, "+ Add status" appends an empty row, "Remove" per row,
  submitted as `notifyStatuses: rows.map(r => r.status)` +
  `templates: Object.fromEntries(rows.map(r => [r.status, r.template]))`.
  Submits `POST /api/tenants` (create) or `PATCH /api/tenants/:id` (edit);
  renders the backend's `{error}` on failure, same convention as every
  other form.
- `TenantPickerScreen.jsx`: add a "Manage tenants →" link/button alongside
  the existing tenant-id input, calling a new `onManageTenants` prop.
- `App.jsx`: new `'tenantManagement'` screen state, entered via
  `onManageTenants` from `tenantPicker`; `TenantListScreen`'s "Edit"/"Create"
  actions and `TenantFormScreen`'s save/cancel navigate within this state
  (simplest: a small local sub-state in `App.jsx` or a dedicated
  `TenantManagementScreen.jsx` wrapper composing both -- implementation-time
  call, not a spec change) rather than adding two more top-level `screen`
  values for what's really one cohesive area.
- Tests: `TenantListScreen.test.jsx` (renders active/inactive correctly,
  mocked `api`), `TenantFormScreen.test.jsx` (add/remove template rows,
  submits the expected payload for both create and edit modes, renders a
  server conflict error).
- Checkpoint: `cd client && npm test`.

## Step 9 — manual smoke check

Safe to run live (no real Google Sheets/SMS credentials needed for CRUD
itself; only a *migrated* tenant's sheet reads would need real credentials,
which this check doesn't have to exercise):

- Scratch `tenants.json` (two tenants, one active one inactive) + scratch
  `.env` (fake Google/SMS credentials, as in prior smoke checks).
- Run `node scripts/migrate-tenants.mjs --file=<scratch tenants.json>`,
  confirm both entries report success.
- Start the server, provision a superadmin via `create-user.mjs`, log in via
  a real browser (Playwright): reach "Manage tenants" from the tenant
  picker, confirm both migrated tenants appear with correct active/inactive
  badges, edit one tenant's `senderId` to collide with the other active
  one and confirm the 400/error renders, create a brand-new tenant, confirm
  it shows up, deactivate the original active one and confirm it now shows
  inactive in the list.
- Clean up scratch artifacts afterward.

## Out of scope reminders (carried from the spec)

User management (sibling spec, part 2 of 2) -- not started. No automatic
deletion of `tenants.json`. No hard-delete for tenants.
