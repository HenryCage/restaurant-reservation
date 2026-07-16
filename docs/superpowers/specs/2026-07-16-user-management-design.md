# User management (superadmin console, part 2 of 2)

Date: 2026-07-16
Status: implemented (see docs/superpowers/plans/2026-07-16-user-management-plan.md
for the step-by-step commit history and the live browser smoke-test results).
Depends on: sub-projects 1-3 (Foundation merge, Customer-facing auth + HTTP API,
Dashboard UI) and Tenant management (part 1 of 2), all implemented — this reuses
the same `requireSuperadmin` middleware, PATCH-for-partial-update convention,
and list/form screen-composition pattern tenant management established.

## Context

Sibling to `docs/superpowers/specs/2026-07-16-tenant-management-design.md`. The
user asked for a full superadmin console and picked two priorities: tenant
list/management (done) and user management (this spec) — today, users can
only be provisioned via `scripts/create-user.mjs` on the server; there is no
way to list, deactivate, or reset a user's password without direct database
access.

Two decisions were locked in before this spec was written, during the earlier
superadmin-console brainstorming: deactivation is **soft** (an `active` flag,
not a delete — mirrors how tenants already work, avoids FK/session cleanup
complexity), and an **admin-triggered password reset** is in scope (the same
underlying mechanism `scripts/create-user.mjs` already uses to generate a
temporary password, exposed via UI/API instead of CLI-only).

## Decisions made during brainstorming

- **Creation moves into the UI**, not CLI-only. Mirrors tenant management,
  which got a full create/edit UI rather than staying a one-time migration
  script. `scripts/create-user.mjs` keeps working (useful for scripted/CI
  provisioning) but is no longer the only path.
- **Deactivating a user kills their session(s) immediately**, not just future
  logins. A deactivated user with a live session must be locked out right
  away (e.g. offboarding), not whenever their up-to-a-week-long session
  happens to expire on its own.
- **The user list is per-tenant, picker-first** — a superadmin picks a tenant
  (mirroring the existing "Choose a tenant" flow and `resolveTenantId`'s
  one-tenant-at-a-time model) and sees that tenant's users, rather than one
  global cross-tenant table.
- Because superadmin accounts don't belong to any tenant, they need their own
  place: a **dedicated "Manage superadmins" view**, reached the same way as
  picking a tenant, separate from any single tenant's user list.
- **Lockout guard**: deactivating a superadmin is rejected if they are the
  last remaining active superadmin. Self-deactivation is naturally covered by
  the same check (with one admin, self *is* the last one).
- User creation/deactivation/reset only ever touches the `active` flag and
  the password — email, `tenantId`, and `isSuperadmin` are fixed at creation
  and never editable afterward. This matches an earlier, separate finding in
  this project: there is no promotion path between a tenant user and a
  superadmin (the schema enforces `tenant_id` XOR `is_superadmin`
  permanently), so this spec doesn't attempt to add one.

## Architecture

**The new wrinkle this sub-project has that tenant management didn't**: tenant
management added a brand-new `tenants` table, so `CREATE TABLE IF NOT EXISTS`
in `db.js` was sufficient on its own. This sub-project adds a column
(`active`) to `users`, a table that **already exists** in every deployed
`platform.db` — the schema string alone won't retroactively alter an
already-created table. `db.js`'s header comment already declares "single
schema version, no migration framework (YAGNI at this size)"; introducing a
full migrations framework for one column would contradict that. Instead,
`createDb()` gains a small self-healing step, run after `db.exec(SCHEMA)`:
check `PRAGMA table_info(users)` for an `active` column, and run
`ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1` if it's
missing. Idempotent, runs on every startup, no separate one-time script to
remember to run (unlike `migrate-tenants.mjs`, which moved *data*, not
schema).

`src/auth.js` gains new store methods; the existing `createUser`,
`verifyPassword`, `changePassword`, session methods, and their validation
rules are unchanged:

- `listByTenant(tenantId)` — all users (active or not — the admin view needs
  to see deactivated ones, to be able to reactivate them) for one tenant.
- `listSuperadmins()` — all superadmin accounts, active or not.
- `deactivate(userId)` — sets `active = 0`, deletes all of that user's
  sessions. If the target `isSuperadmin`, first checks it isn't the last
  active superadmin (`COUNT(*) WHERE is_superadmin = 1 AND active = 1`); if
  it is, rejects with a clear error instead of deactivating.
- `reactivate(userId)` — sets `active = 1`. No session to restore — a
  reactivated user simply logs in fresh.
- `resetPassword(userId)` — generates a new temporary password, updates
  `password_hash`, sets `must_change_password = 1`, deletes all of that
  user's sessions (so the old password/session stops working the moment the
  reset happens), and returns the plaintext password once.
- `deleteSessionsForUser(userId)` — `DELETE FROM sessions WHERE user_id = ?`,
  used by both `deactivate` and `resetPassword`.

The random-temp-password generator (`randomBytes(12).toString('base64url')`)
currently lives only in `scripts/create-user.mjs`. It moves into `auth.js` so
both the CLI and the new HTTP-created-user path share one implementation
instead of duplicating it; `create-user.mjs` is updated to import it rather
than defining its own copy.

`verifyPassword` gains one added check: a deactivated user fails login with
the exact same `null` (→ generic "invalid email or password") as a wrong
password. This matches the store's existing "never reveal which of email/
password was wrong" convention — a deactivation must not be discoverable by
probing the login endpoint.

```
src/
  auth.js                       # modified: active column support, listByTenant,
                                 #   listSuperadmins, deactivate, reactivate,
                                 #   resetPassword, deleteSessionsForUser
  db.js                          # modified: self-healing ALTER TABLE for users.active
  http/routes/users.js             # new: /api/users, requireSuperadmin
scripts/
  create-user.mjs                 # modified: imports the shared password generator
client/src/
  screens/
    TenantPickerScreen.jsx           # modified: "Manage users" + "Manage superadmins" links
    UserListScreen.jsx                # new: shared by tenant-scoped and superadmin scope
    UserFormScreen.jsx                 # new: create-only (no edit-in-place)
    UserManagementScreen.jsx            # new: list <-> create nav wrapper
```

## Data model

```sql
-- self-healing ALTER in createDb(), not part of the CREATE TABLE literal,
-- since `users` already exists in every deployed database:
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
```

No new tables. `toUser()` in `auth.js` gains `active: !!row.active` in its
returned shape. Existing rows default to `active = 1` (nobody is silently
locked out by this migration).

## API and access control

New `src/http/routes/users.js`, mounted at `/api/users`, every route behind
the existing `requireSuperadmin` middleware (no regular tenant user can ever
reach these, regardless of query parameters — same guarantee tenant
management already established):

- `GET /?tenantId=<id>` — every user (active or not) for that tenant.
  `GET /?superadmins=true` — every superadmin account (active or not).
  Exactly one of the two query params must be present; `400` otherwise (no
  implicit "all users everywhere" view, mirroring `resolveTenantId`'s rule
  that a superadmin must always be explicit about scope).
- `POST /` — create. Body is either `{ tenantId, email }` (tenant-scoped user)
  or `{ email, isSuperadmin: true }` (superadmin) — reuses
  `authStore.createUser()`'s existing validation (duplicate email, `tenantId`
  XOR `isSuperadmin`) with errors mapped to `400`. For a tenant user, the
  route additionally checks `tenantId` against the tenant registry (the same
  `registry.load().some(...)` check `scripts/create-user.mjs` already does)
  and rejects an unknown tenant id with `400` — otherwise a typo'd id would
  silently create an orphaned user instead of failing loudly. The server
  generates the temporary password; the response is
  `{ user, temporaryPassword }`, and that plaintext value is returned exactly
  this once — the client must display it immediately, the server never
  returns it again on subsequent requests (matches the CLI's "shown once,
  share out-of-band" convention).
- `PATCH /:id` — accepts only `{ active: boolean }`; any other field in the
  body is ignored (email/tenantId/isSuperadmin are permanently fixed at
  creation). `active: false` deactivates (`400` if this is the last active
  superadmin); `active: true` reactivates. Unknown id → `404`.
- `POST /:id/reset-password` — a dedicated action route rather than a PATCH
  field, since it's side-effecting (rotates the password hash, sets
  `must_change_password`, invalidates sessions) rather than a plain field
  update — consistent with using POST for actions and PATCH only for data
  merges. Returns `{ temporaryPassword }` once, same shown-once convention as
  create. Unknown id → `404`.

## UI

`TenantPickerScreen` gains two more entries alongside the existing "Manage
tenants →": a **"Manage users"** button next to the existing "Continue"
button (both consume the same typed tenant-id input — "Continue" opens that
tenant's dashboard, "Manage users" opens that tenant's user list), and a
**"Manage superadmins →"** link (no tenant id needed, parallel to "Manage
tenants →").

A tenant-scoped user list and the superadmin list are nearly identical (same
columns, same actions, only the query scope and create-payload shape differ),
so they share **one** `UserListScreen.jsx` parameterized by a `scope` prop
(`{ type: 'tenant', tenantId }` or `{ type: 'superadmin' }`) rather than two
near-duplicate files — the same reasoning that made `TenantFormScreen` shared
by create/edit. Columns: email, active/inactive badge, a "must change
password" badge (visible onboarding progress), and per-row actions:
"Deactivate"/"Reactivate" (toggles based on current state) and "Reset
password". Both create and reset-password respond with a one-time,
explicitly dismissible banner showing the generated temporary password —
dismissing it clears it from memory; there is no way to see it again from the
UI afterward.

`UserFormScreen.jsx` is create-only — unlike tenants, a user has no editable
fields once created besides `active` (already on the list rows) and its
password (also already on the list rows via "Reset password"), so there's no
shared create/edit form the way `TenantFormScreen` is. Its only field is
`email`; `tenantId`/`isSuperadmin` come from the `scope` it was opened with,
not from user input.

`UserManagementScreen.jsx` is a small list ↔ create nav wrapper carrying
`scope` through to both children, mirroring `TenantManagementScreen`'s
existing list/form composition. `App.jsx`'s auth-state machine gains one more
reachable screen (`userManagement`), entered from `tenantPicker` with the
chosen `scope`, returning to `tenantPicker` after cancel or completing an
action.

## Testing

- `test/db.test.js` — new case: seed a `:memory:` database with the
  pre-migration `users` schema (no `active` column) directly via `db.exec`,
  then run `createDb`'s self-healing step and confirm the column now exists
  and existing rows read back `active = 1`.
- `test/auth.test.js` — new cases: `listByTenant` / `listSuperadmins` return
  both active and inactive rows; `deactivate` sets `active = 0` and deletes
  that user's sessions; `deactivate` on the last active superadmin is
  rejected and leaves state unchanged; `reactivate` flips `active` back;
  `resetPassword` rotates the password hash, sets `must_change_password = 1`,
  and deletes sessions; `verifyPassword` returns `null` (not a distinct
  error) for a deactivated user's correct password, identical to a wrong
  password.
- `test/http/usersRoutes.test.js` (new) — every route 403s for a
  non-superadmin; `GET` 400s when neither or both of `tenantId`/`superadmins`
  are given; full create → deactivate → confirm a follow-up authenticated
  request with the old session cookie now 401s → reactivate → reset-password
  → confirm the *previous* password no longer logs in; last-superadmin
  deactivation rejected with `400`; unknown id → `404` on both `PATCH` and
  `reset-password`.
- Frontend: component tests for `UserListScreen` (renders both scopes
  correctly, deactivate/reactivate/reset actions call the right endpoints,
  temp-password banner shows and dismisses), `UserFormScreen` (submits the
  right payload per scope), `UserManagementScreen` (list ↔ create
  navigation).
- Live Playwright smoke test once implemented, same discipline as tenant
  management: create a tenant user, log in as them in a second browser
  context, deactivate them from the admin UI mid-session and confirm the
  second context is immediately kicked out on its next request; reset a
  password and confirm login works with the new one and not the old one;
  attempt to deactivate the sole superadmin and confirm the UI surfaces the
  rejection rather than silently failing.

## Explicitly out of scope for this sub-project

- Editing a user's email, tenant assignment, or superadmin status after
  creation — permanently fixed at creation, no promotion/reassignment path
  (consistent with the schema's `tenant_id` XOR `is_superadmin` constraint).
- Hard-deleting a user — deactivation (`active: false`) only, mirroring how
  tenants already work.
- Self-service password reset / email-based invites — still admin-provisioned
  only, same as the original Customer-auth spec.
- A global, cross-tenant "all users" view — the list is always scoped to one
  tenant or to superadmins, never both at once.
