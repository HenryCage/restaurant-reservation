# Tenant management (superadmin console, part 1 of 2)

Date: 2026-07-16
Status: approved (design), not yet implemented
Depends on: sub-projects 1-3 (Foundation merge, Customer-facing auth + HTTP API,
Dashboard UI), all implemented. Sibling sub-project: user management (part 2 of
2, to be brainstormed separately after this one is implemented).

## Context

Trying the real dashboard, the user found the superadmin flow too thin: log in
as superadmin, land on a "Choose a tenant" screen where you type a tenant id
blind, then see that one tenant's normal dashboard. Asked which controls
matter most, they picked **tenant list/management** and **user management** —
this spec covers the first; user management is a separate follow-up spec.

**Architecture decision made during brainstorming:** tenant configuration
(`id`, `sheetId`, `sheetName`, `senderId`, `channel`, `notifyStatuses`,
`templates`, `testNumber`, `syncContactsFromSheet`) has lived only in
`tenants.json` — a hand-edited, gitignored file, re-read every `processor.js`
tick — since the very first spec in this repo. Making it manageable via a UI
forced a real choice between editing that file from a running Node process
(concurrent-write risk against the same file the poller re-reads every tick)
or migrating it into the same `platform.db` SQLite database that already
holds contacts/campaigns/users/sessions. **Chosen: migrate to SQLite.**
Consistent with everything built in sub-projects 1-3, and SQLite (already in
WAL mode) handles concurrent access far more safely than a hand-edited file
being read and written by the same process.

## Decisions made during brainstorming

- Full CRUD, including the complex fields: `notifyStatuses` and `templates`
  are editable through the UI, not left behind in `tenants.json`. After a
  one-time migration, `tenants.json` is no longer read at startup at all.
- Tenant `id` stays an **admin-chosen slug** (e.g. `swift-logistics`), not a
  system-generated UUID — existing `contacts`/`campaigns`/`users` rows
  already reference these exact ids as `tenant_id`; migration must preserve
  them unchanged.
- Deactivation only, no hard delete — a tenant row stays forever once
  created (existing child rows in other tables reference it); `active` is
  just flipped to `false`, mirroring how it already works today in
  `tenants.json`.
- Tenant management is superadmin-only, and is a fundamentally cross-tenant
  operation — it doesn't fit the existing `resolveTenantId` (one-tenant-at-
  a-time) pattern, so it gets its own, simpler access check.
- This is sub-project "part 1 of 2" of a decomposed "superadmin console"
  effort — user management (list/deactivate/reset-password) is a separate,
  independent spec to follow once this one ships.

## Architecture

**The single most load-bearing design choice**: `src/tenants.js`'s pure
validation functions — `validateTenant`, `validateRegistry`, `canonicalStatus`
— **do not change at all**. They already accept a plain "raw" object; a
SQLite row (JSON-decoded) can be shaped into the exact same raw form a
`tenants.json` array entry was. Only `createTenantRegistry()`'s I/O changes:
instead of `readFile(filePath)` + `JSON.parse`, it runs a SQLite query and
maps each row to the same raw shape, then calls the **same, unmodified**
`validateRegistry(parsed, logger)`. Every existing `validateTenant`/
`validateRegistry` test in `test/tenants.test.js` keeps passing unchanged;
only `createTenantRegistry`'s own tests need a SQLite-backed rewrite.

`createTenantRegistry({ db, logger })` (signature changes from `{ filePath,
logger, readFile }`) keeps its existing `.load()` contract (returns active,
validated tenants; whole-query failure keeps last-known-good in memory) and
gains admin-facing methods on the same returned object:
`listAll()` (every tenant, active or not — the admin view needs to see
deactivated ones to reactivate them), `create(raw)`, `update(id, patch)`.
These reuse `validateTenant`'s per-field rules and, additionally, the
existing `senderId`-uniqueness-across-active-tenants check (re-expressed as
a single-row-against-the-rest query instead of a whole-collection scan).

```
src/
  tenants.js                # modified: file I/O -> SQLite I/O; validation logic untouched
  db.js                      # modified: new `tenants` table in the schema
  http/routes/tenants.js       # new: /api/tenants CRUD, requireSuperadmin
  http/middleware/
    requireSuperadmin.js        # new: req.authUser.isSuperadmin === true or 403 -- no tenant scoping involved
scripts/
  migrate-tenants.mjs          # new: one-time tenants.json -> SQLite import, reuses validateTenant
client/src/
  screens/
    TenantListScreen.jsx        # new
    TenantFormScreen.jsx         # new: shared by create and edit
```

## Data model

```sql
CREATE TABLE tenants (
  id                       TEXT PRIMARY KEY,   -- admin-chosen slug, e.g. "swift-logistics" -- preserved from tenants.json
  name                     TEXT NOT NULL,
  active                   INTEGER NOT NULL DEFAULT 0,
  sheet_id                 TEXT NOT NULL,
  sheet_name               TEXT NOT NULL DEFAULT 'Orders',
  sender_id                TEXT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'dnd',
  notify_statuses_json     TEXT NOT NULL DEFAULT '[]',
  templates_json           TEXT NOT NULL DEFAULT '{}',
  test_number               TEXT NOT NULL DEFAULT '',
  sync_contacts_from_sheet  INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
```

`notify_statuses_json` and `templates_json` are stored as JSON text (the same
pattern already used for `contacts.tags`) and stay **two separate fields**,
not one derived from the other — today's validation allows `templates` to
contain more keys than `notifyStatuses` actually references, and migrating
must preserve that same tolerance rather than silently tightening it.

## API and access control

Tenant management is inherently cross-tenant, so it doesn't fit
`resolveTenantId` (built for scoping to exactly one tenant at a time). A new,
simpler `requireSuperadmin` middleware checks only
`req.authUser.isSuperadmin === true` (403 otherwise) — a regular tenant user
can never reach these routes, full stop, regardless of any query parameter.

`src/http/routes/tenants.js`, mounted at `/api/tenants`, every route behind
`requireSuperadmin`:

- `GET /` — every tenant, active or not (the admin view needs deactivated
  ones visible, to be able to reactivate them).
- `POST /` — create; runs the existing `validateTenant` field rules plus an
  `id`-uniqueness check (clear 400 on conflict, not a raw SQLite constraint
  error).
- `PATCH /:id` — **partial/merge update**: the body carries only the fields
  being changed, merged onto the existing row (not a full replace requiring
  every field) — the first `PATCH` route in this codebase, so worth being
  explicit since there's no existing convention to lean on. Includes
  `active`; this is also how deactivation/reactivation works, no separate
  endpoint needed.

Both `create` and `update` re-run the existing **senderId-uniqueness-across-
active-tenants check** (today's "impersonation guard" from
`validateRegistry`), re-expressed as a single-row lookup against the rest of
the active tenants rather than a whole-collection scan — a create/update
that would collide with another active tenant's `senderId` is rejected with
a 400, the same rule that has always applied at registry-load time now also
applies at write time.

## UI

`TenantPickerScreen` gains a **"Manage tenants →"** link alongside its
existing tenant-selection form — a distinct path from "view one tenant's
dashboard."

- **`TenantListScreen`** — table (id, name, active/inactive badge, sheetId),
  an "Edit" action per row, a "Create new tenant" button, "← Back" to the
  picker.
- **`TenantFormScreen`** (shared by create and edit) — core fields (`id` —
  editable only on create, `name`, `sheetId`, `sheetName`, `senderId`,
  `channel`, `testNumber`, `syncContactsFromSheet` checkbox) plus a
  **dynamic notifyStatuses/templates editor**: a repeatable row of "status
  name" + "template text" (textarea), "+ Add status" / "Remove" per row.
  Errors (e.g. a senderId conflict) render the backend's own `{error}`
  message directly, same convention as every other form in this app.

`App.jsx`'s auth-state machine gains one more reachable screen
(`tenantManagement`), entered from `tenantPicker`, returning there after a
save or cancel.

## Migration and deployment

`scripts/migrate-tenants.mjs` — a one-time CLI (matches `create-user.mjs`'s
shape), run manually by the operator after deploying this change: reads the
existing `tenants.json`, validates each entry through the same
`validateTenant` logic, inserts each into the new `tenants` table. After a
successful migration, `TENANTS_FILE`/`tenants.json` are no longer read at
startup at all — `config.tenantsFile` and the `readFile` dependency on
`createTenantRegistry` are removed. The physical `tenants.json` file is left
on disk afterward as a backup; deleting it is left to the operator's
judgment, not automated by this migration.

## Testing

- `test/tenants.test.js` — existing `validateTenant`/`validateRegistry`
  cases are untouched. New cases for the SQLite-backed
  `createTenantRegistry`: mirrors the old file-based tests but against
  `:memory:` — last-known-good on a query failure, skip-invalid-not-fatal,
  senderId uniqueness across active tenants; plus new cases for
  `listAll()`, `create()`, `update()` (including the senderId-conflict
  rejection on both).
- `test/http/tenantsRoutes.test.js` (new) — full CRUD happy path; a regular
  (non-superadmin) tenant user gets `403` on every route; a senderId
  conflict on create/update is a `400` with a clear message; `PATCH .../:id
  { active: false }` deactivates and the tenant then disappears from the
  live processor registry's `.load()` (still visible via `listAll()`).
- Frontend: component tests for `TenantListScreen` (renders active/inactive
  correctly) and `TenantFormScreen` (add/remove template rows; submits the
  expected payload; renders a server-side conflict error).

## Explicitly out of scope for this sub-project

- User management (list/deactivate/reset-password) — the sibling "part 2 of
  2" spec, to follow.
- Automatic deletion of the `tenants.json` file after migration.
- Hard-deleting a tenant — deactivation (`active: false`) only, since
  `contacts`/`campaigns`/`users` rows already reference the tenant id.
