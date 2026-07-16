# Implementation plan: User management (superadmin console, part 2 of 2)

Spec: `docs/superpowers/specs/2026-07-16-user-management-design.md`
Status: not started.

## Sequencing rationale

Schema self-heal (riskiest piece, since it touches an already-deployed table)
→ store rewrite (`auth.js`) → CLI de-duplication → access control (reused
as-is) → HTTP routes → frontend → live smoke check. `npm test` (backend) and
`cd client && npm test` stay green after their respective steps, matching the
tenant-management plan's discipline.

Two implementation-level decisions the spec left open, resolved here:

1. **How the self-healing `active` column stays testable without needing a
   pre-migration fixture DB.** Rather than adding `active` to the `users`
   `CREATE TABLE IF NOT EXISTS` literal in `SCHEMA` *and* separately healing
   existing tables, `active` is left out of the literal entirely — the
   healing step (`PRAGMA table_info(users)` check + conditional
   `ALTER TABLE ... ADD COLUMN`) runs unconditionally after `db.exec(SCHEMA)`
   on every `createDb()` call. This means the "column missing → add it"
   branch is exercised on *every* fresh `:memory:` database in the existing
   test suite (nothing special to construct), and the "column already
   present → skip" branch — the one that matters for a real restart against
   an existing `platform.db` file — is tested by calling `createDb(path)`
   twice against the same real file path (a temp file under the OS temp dir,
   cleaned up after) and confirming the second call doesn't throw
   ("duplicate column name") and doesn't clobber data written after the
   first call.
2. **How `deactivate()` avoids double-counting the row being deactivated in
   the last-active-superadmin check.** The guard only fires when the target
   row is itself an *active* superadmin and no *other* active superadmin
   exists (`COUNT(*) FROM users WHERE is_superadmin = 1 AND active = 1 AND id != ?`
   over the target id `= 0`). Deactivating an already-inactive superadmin is
   therefore always a harmless no-op, never blocked by this guard.

## Step 1 — self-healing `active` column in `src/db.js`

- After `db.exec(SCHEMA)` in `createDb()`, add: check
  `db.prepare("PRAGMA table_info(users)").all()` for a row named `active`;
  if absent, `db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1')`.
  `SCHEMA`'s `users` table definition itself is **not** changed (see
  sequencing decision 1 above — the healing step is the only place `active`
  is added, for both fresh and pre-existing databases).
- `test/db.test.js`: extend the existing "round-trips a row through users and
  sessions" case to assert the inserted row reads back `active: 1` by
  default. New case: create a real file-backed db (temp path), insert a user
  row, close it, `createDb()` the same path again, confirm no throw and the
  previously inserted row still has `active: 1` (proves the guard prevents
  "duplicate column" on a second open, the realistic restart scenario).
- Checkpoint: `npx vitest run test/db.test.js`.

## Step 2 — `src/auth.js`: `active` support + new store methods

- `toUser(row)`: add `active: !!row.active`.
- `verifyPassword`: after the existing hash check succeeds, add
  `if (!row.active) return null;` — a deactivated user's correct password
  produces the exact same `null` result as a wrong password (never reveal
  which), per the spec.
- New exported top-level function `generateTempPassword()` —
  `randomBytes(12).toString('base64url')`, moved here from
  `scripts/create-user.mjs` (not a store method, since it has no `db`
  dependency and both the CLI and the new HTTP route need to call it before
  a user exists to attach a session to).
- New prepared statements + store methods on the object `createAuthStore`
  returns:
  - `listByTenant(tenantId)` — `SELECT * FROM users WHERE tenant_id = ? ORDER BY email`, mapped via `toUser`.
  - `listSuperadmins()` — `SELECT * FROM users WHERE is_superadmin = 1 ORDER BY email`, mapped via `toUser`.
  - `deactivate(userId)` — `{ ok: false, notFound: true }` if unknown id;
    if the row `is_superadmin` and currently `active`, count *other* active
    superadmins (`id != userId`) and reject with
    `{ ok: false, error: 'cannot deactivate the last active superadmin' }`
    if that count is 0; otherwise set `active = 0`, delete all sessions for
    that user (`DELETE FROM sessions WHERE user_id = ?`), return
    `{ ok: true, user }`.
  - `reactivate(userId)` — `{ ok: false, notFound: true }` if unknown id;
    otherwise set `active = 1`, return `{ ok: true, user }`.
  - `resetPassword(userId)` — `{ ok: false, notFound: true }` if unknown id;
    otherwise generate a new temp password via `generateTempPassword()`,
    update `password_hash` + set `must_change_password = 1`, delete all
    sessions for that user, return `{ ok: true, temporaryPassword }`.
  - `deleteSessionsForUser(userId)` — `DELETE FROM sessions WHERE user_id = ?`,
    exposed as its own method (used internally by `deactivate`/
    `resetPassword`, and independently testable).
- `test/auth.test.js`: new `describe` blocks — `listByTenant`/
  `listSuperadmins` (return both active and inactive rows, scoped
  correctly); `deactivate` (sets `active = 0`, deletes sessions, rejects on
  last-active-superadmin, no-ops safely on an already-inactive superadmin,
  `notFound` on unknown id); `reactivate`; `resetPassword` (rotates hash,
  sets `must_change_password = 1`, deletes sessions — verify via
  `verifyPassword` that the *old* password no longer authenticates and a
  fresh login is required); `verifyPassword` returns `null` for a
  deactivated user's otherwise-correct password.
- Checkpoint: `npx vitest run test/auth.test.js`.

## Step 3 — `scripts/create-user.mjs`: drop its local password generator

- Remove the local `generatePassword()` function; `import { generateTempPassword } from '../src/auth.js'`
  and call that instead at the one call site.
- No automated test (matches this script's existing precedent — it has never
  had its own test file; the logic it now calls is covered by step 2).
  Verified manually in step 6.

## Step 4 — `GET/POST /api/users`, `PATCH /api/users/:id`, `POST /api/users/:id/reset-password`

- `src/http/routes/users.js`: `createUsersRoutes({ requireSuperadmin, authStore, registry })`.
  - `GET /` — exactly one of two query params required, `400` otherwise:
    `?tenantId=<id>` → `authStore.listByTenant(tenantId)`; `?superadmins=true` → `authStore.listSuperadmins()`.
  - `POST /` — body `{ tenantId, email }` or `{ email, isSuperadmin: true }`.
    For a tenant user, validate `tenantId` against `registry.load().some(t => t.id === tenantId)`
    (same check `create-user.mjs` already does) — unknown tenant id → `400`.
    Generate the temp password via `generateTempPassword()`, call
    `authStore.createUser({ tenantId, email, password, isSuperadmin })`
    wrapped in try/catch (its existing validation — duplicate email,
    `tenantId` XOR `isSuperadmin` — maps thrown errors to `400`); success →
    `201` with `{ user, temporaryPassword }`.
  - `PATCH /:id` — body `{ active: boolean }` only; anything else in the body
    is ignored. `active === false` → `authStore.deactivate(id)`;
    `active === true` → `authStore.reactivate(id)`; neither → `400`. Map
    `notFound` → `404`, `{ ok: false, error }` → `400` with that message,
    success → `200` with `{ user }`.
  - `POST /:id/reset-password` — `authStore.resetPassword(id)`; `notFound` →
    `404`; success → `200` with `{ temporaryPassword }`.
- `server.js`: mount `app.use('/api/users', createUsersRoutes({ requireSuperadmin, authStore, registry }))`,
  reusing the same `requireSuperadmin` instance already built for
  `/api/tenants`. `authStore` and `registry` are already available in
  `createHttpServer`'s deps.
- `test/http/usersRoutes.test.js` (new, real-server-over-fetch harness,
  mirrors `tenantsRoutes.test.js`): `403` for a non-superadmin on every
  route; `GET` `400` when neither/both of `tenantId`/`superadmins` are
  given; `GET ?tenantId=` returns only that tenant's users; `GET ?superadmins=true`
  returns only superadmins; `POST` creates a tenant user (asserts
  `temporaryPassword` present, `active: true`, `mustChangePassword: true`)
  and rejects an unknown `tenantId` with `400`; `POST` creates a superadmin;
  duplicate email → `400`; full deactivate flow — log the new user in for
  real via `/auth/login` to get a session cookie, `PATCH { active: false }`
  as the superadmin, then confirm a follow-up request using the *old*
  session cookie now gets `401` (proves session-kill end to end); `PATCH`
  deactivating the sole superadmin → `400`; `PATCH { active: true }`
  reactivates; `POST .../reset-password` rotates the password (old password
  fails a fresh `/auth/login`, returned new one succeeds) and forces
  `mustChangePassword`; unknown id → `404` on both `PATCH` and
  `reset-password`.
- Checkpoint: `npx vitest run test/http`.

## Step 5 — Frontend: `UserListScreen` + `UserFormScreen` + `UserManagementScreen`

- `client/src/screens/UserListScreen.jsx`: props
  `{ api, scope, refreshKey, temporaryPassword, onDismissTemporaryPassword, onCreate, onBack }`,
  where `scope` is `{ type: 'tenant', tenantId }` or `{ type: 'superadmin' }`
  — builds the `GET /api/users` query string from `scope`. Table: email,
  active/inactive badge, "must change password" badge, per-row "Deactivate"/
  "Reactivate" (toggles on current state, calls `PATCH /api/users/:id`) and
  "Reset password" (calls `POST /api/users/:id/reset-password`, stores the
  returned password in local state and renders it in a dismissible banner —
  this action's own banner is local to the list, separate from the
  create-flow banner passed in via props). The `temporaryPassword` prop
  (set after a create) renders the same dismissible-banner UI; dismissing
  either clears it from state/memory, never recoverable afterward.
- `client/src/screens/UserFormScreen.jsx`: props `{ api, scope, onSaved, onCancel }`.
  Create-only, single `email` field (no edit-in-place — see spec's "out of
  scope"). Submits `POST /api/users` with a body built from `scope`
  (`{ tenantId: scope.tenantId, email }` or `{ email, isSuperadmin: true }`);
  on success calls `onSaved({ user, temporaryPassword })`; on failure renders
  the backend's `{ error }`, same convention as every other form.
- `client/src/screens/UserManagementScreen.jsx`: small list ↔ create nav
  wrapper (mirrors `TenantManagementScreen`), also threading `scope` through
  and holding the transient `temporaryPassword` state set by
  `handleSaved(result)` (bumps `refreshKey`, stores
  `result.temporaryPassword`, returns to `'list'` view).
- `TenantPickerScreen.jsx`: add a "Manage users" button next to the existing
  "Continue" button (both read the same typed tenant-id input) calling a new
  `onManageUsers(tenantId)` prop, and a "Manage superadmins →" link
  (alongside the existing "Manage tenants →") calling a new
  `onManageSuperadmins()` prop.
- `App.jsx`: new `'userManagement'` screen value plus a
  `userManagementScope` state value, set by two new handlers
  (`handleManageUsers(tenantId)` → `{ type: 'tenant', tenantId }`,
  `handleManageSuperadmins()` → `{ type: 'superadmin' }`) before switching
  screens; renders `<UserManagementScreen api={api} scope={userManagementScope} onBack={...} />`,
  `onBack` returns to `'tenantPicker'`.
- Tests: `UserListScreen.test.jsx` (renders both scopes' query correctly,
  deactivate/reactivate/reset-password wire to the right endpoints, banner
  shows and dismisses for both create and reset-password sources),
  `UserFormScreen.test.jsx` (submits the right payload per scope, renders a
  server conflict error), `UserManagementScreen.test.jsx` (list ↔ create
  navigation, temp-password threading), `TenantPickerScreen.test.jsx` gains
  cases for the two new controls.
- Checkpoint: `cd client && npm test`.

## Step 6 — manual smoke check

Safe to run live with scratch/fake credentials, same as the tenant-management
smoke check:

- Start the server, provision a superadmin via `create-user.mjs` (now using
  the shared `generateTempPassword`), log in via a real browser (Playwright).
- From the tenant picker, reach "Manage users" for a scratch tenant: create a
  new tenant user, confirm the one-time temp-password banner appears and the
  user shows up in the list as active with "must change password" set.
- In a **second** Playwright browser context, log in as that new user with
  the shown temp password, change the password, confirm dashboard access.
- Back in the admin context, deactivate that user; in the second context,
  trigger any authenticated request (e.g. reload) and confirm it's kicked
  back to the login screen immediately — not after a delay.
- Reactivate a different scratch user, reset their password from the admin
  UI, confirm the old password now fails login and the newly shown one
  succeeds (and re-triggers the must-change-password gate).
- Reach "Manage superadmins →", attempt to deactivate the sole superadmin
  account, confirm the UI surfaces the rejection rather than silently
  failing or crashing.
- Clean up scratch artifacts afterward.

## Out of scope reminders (carried from the spec)

No editing of email/tenant assignment/superadmin status after creation. No
hard-delete — deactivation only. No self-service password reset or
email-based invites. No global cross-tenant "all users" view.
