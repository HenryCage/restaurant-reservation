# Customer-facing auth + HTTP API

Date: 2026-07-16
Status: approved (design), not yet implemented
Sub-project: 2 of 4 (see `docs/superpowers/specs/2026-07-16-foundation-merge-design.md`
Context section for the full list). Depends on sub-project 1 (Foundation merge),
which is implemented. Sub-project 3 (dashboard UI) depends on this one.

## Context

Sub-project 1 gave the platform SQLite-backed contacts/campaigns, but no way to
reach them except direct function calls in Node — no UI, no HTTP API, no auth.
During the original brainstorming, the user chose that the eventual dashboard
must be used by **each tenant's own employees**, not just an internal ops team —
a real external multi-user product where a tenant (e.g. a logistics company)
has its own users who can only ever see/act on their own tenant's data.

Sub-project 3 is defined as "the dashboard UI, adapted to read/write against (1)
and (2)" — which only makes sense if an HTTP API already exists by then. So this
spec covers **both** auth and the HTTP API surface that sub-project 3 will
consume; sub-project 3 becomes purely a front-end task.

## Decisions made during brainstorming

- **Scope**: this sub-project includes the first HTTP server (Express), auth,
  and auth-gated REST endpoints for contacts/campaigns — not just auth
  primitives. Sub-project 3 is frontend-only.
- **Sessions**: server-side sessions in the same `platform.db` SQLite file +
  an httpOnly cookie, not JWT. Matches the existing single-instance,
  zero-extra-infrastructure operating model; revocation is just a row delete.
- **Auth method**: email + password (scrypt via `node:crypto`, no new native
  dependency). Not magic-link — this system currently sends no email at all,
  and magic-link would make email delivery a hard dependency for every login.
- **Onboarding (v1)**: no self-service signup and no email-based
  invite/reset. An admin creates a user via a new CLI script
  (`scripts/create-user.mjs`) with a temporary password, shared with the
  customer out-of-band (Slack/phone). The user must change it on first login.
  Email-based invite/reset is explicitly deferred past v1.
- **Roles**: no admin/member distinction within a tenant in v1 — every tenant
  user has equal access to their tenant's data. A separate **superadmin**
  role (not tied to any tenant) is included from the start, for the vendor's
  own support/debug access across all tenants.
- **Tech choices**: Express + `cors` (matches the colleague's autoNotify
  stack, minimal well-known deps) for the HTTP layer; `node:crypto` scrypt
  for password hashing (no new native dependency alongside `better-sqlite3`).

## Architecture

```
src/
  auth.js                      # new: createAuthStore(db) -- users/sessions CRUD, scrypt hashing, session lifecycle
  http/
    server.js                   # new: createHttpServer(deps) -- Express app factory
    middleware/
      requireAuth.js             # new: cookie -> session -> req.user/req.tenantId; 401/403
    routes/
      auth.js                    # new: POST /auth/login, /auth/logout, /auth/change-password
      contacts.js                 # new: GET/POST /api/contacts (tenant-scoped)
      campaigns.js                 # new: GET/POST /api/campaigns (tenant-scoped)
scripts/
  create-user.mjs                # new: CLI -- creates a tenant user or a superadmin with a temp password
```

`src/auth.js` is a store in the same shape as `contacts.js`/`campaigns.js`:
takes `db` as a dependency, fully testable against `:memory:` SQLite, no HTTP
awareness. `src/http/` is a thin I/O wrapper around the existing
`contactsStore`/`campaignsStore` plus the new `authStore` — it adds network
reachability and auth gating without changing any store's internal logic.

`index.js` additionally builds `authStore` and `httpServer`, and calls
`httpServer.listen(config.httpPort)` alongside the two existing `setInterval`
loops (sheet poll, campaign tick) — three independent concerns in one process.

## Data model (new tables in the existing `platform.db`)

```sql
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT,                    -- NULL only for superadmins
  email                 TEXT NOT NULL UNIQUE,     -- globally unique, not per-tenant
  password_hash         TEXT NOT NULL,            -- "scrypt:<salt-hex>:<hash-hex>"
  is_superadmin         INTEGER NOT NULL DEFAULT 0,
  must_change_password  INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL
);
-- Invariant enforced in application code, not a SQL CHECK (SQLite's
-- cross-column CHECK support is limited): tenant_id IS NULL iff is_superadmin = 1.

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,        -- crypto.randomUUID(); also the cookie value
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
```

`email` is globally unique rather than unique-per-tenant: login is "enter
email + password" with no tenant pre-selection, and in v1 a user belongs to
exactly one tenant (or is a superadmin with none), so there is no case where
the same email needs two different tenant memberships.

`must_change_password` forces the temp-password flow to complete: every
auth-gated endpoint except `/auth/change-password` returns 403 while it's true.

`sessions.expires_at` is a fixed duration from creation (default 7 days,
`SESSION_TTL_HOURS`), checked on every request by `requireAuth`; an expired
session is deleted and treated as absent (401).

## Auth flow and tenant isolation

**Login** — `POST /auth/login {email, password}`:
1. Look up `users` by `email`. Missing user or wrong password → `401` (the
   same error either way, so the response never reveals whether an email
   exists in the system).
2. Create a `sessions` row; respond with
   `Set-Cookie: sid=<session.id>; HttpOnly; Secure (when NODE_ENV=production); SameSite=Lax; Max-Age=<SESSION_TTL_HOURS*3600>`.
3. Response body: `{ mustChangePassword, tenantId, isSuperadmin }` — never
   `password_hash`.

**`requireAuth` middleware**, applied to every `/api/*` route plus
`/auth/logout` and `/auth/change-password`:
- Read the `sid` cookie → look up the session → missing/expired → `401`.
- Load the `users` row → `req.user = { id, tenantId, isSuperadmin }`.
- If `must_change_password` is true and the path isn't
  `/auth/change-password` → `403 { code: 'must_change_password' }`.

**Tenant scoping** in every `/api/contacts` and `/api/campaigns` handler:
- A regular tenant user always queries with `req.user.tenantId`; a client-
  supplied `?tenantId=` is ignored for non-superadmins — there is no code
  path by which a tenant user's request can touch another tenant's rows.
- A superadmin's `req.user.tenantId` is `null`, so `?tenantId=` is
  **required**; missing it is a `400`. There is no "all tenants at once"
  endpoint — even a superadmin always views exactly one tenant per request,
  deliberately chosen.

**Logout** — `POST /auth/logout`: deletes the `sessions` row, responds with
an expired `Set-Cookie` (`Max-Age=0`).

**Change password** — `POST /auth/change-password {currentPassword, newPassword}`:
verifies the current password, updates `password_hash`, sets
`must_change_password = false`. The only endpoint reachable while
`must_change_password` is true (besides login/logout).

## Security and error handling

- **CORS**: `cors` middleware, `origin` from `CORS_ORIGIN` (the dashboard's
  URL once sub-project 3 exists; empty means CORS is off), `credentials: true`
  so the session cookie survives cross-origin requests during dashboard dev
  (a separate Vite port).
- **CSRF**: no separate CSRF token system. `SameSite=Lax` prevents the
  browser from attaching the session cookie to cross-site `fetch`/XHR
  requests, and every state-changing endpoint requires
  `Content-Type: application/json`, which a cross-site HTML form cannot set.
  Sufficient defense for v1 without extra token plumbing.
- **Brute-force protection on login**: an in-memory rate limiter
  (`Map<email, {count, windowStart}>`, no new dependency) — after N failed
  attempts for the same email within a window (default 10 / 15 minutes),
  respond `429` regardless of whether the password would have been correct.
  Reset on a successful login. In-memory is fine because this runs as a
  single instance with no load balancer (same operating model as the rest of
  the service).
- **Password requirements**: minimum 8 characters, enforced in both
  `change-password` and `create-user.mjs`. No composition rules
  (uppercase/digit/symbol) — those measurably hurt real-world security more
  than they help (NIST 800-63B favors length over complexity rules).
- **Error responses**: `401` (no/invalid/expired session, or bad
  email/password), `403` (must-change-password gate, or a non-superadmin
  path that would cross tenants), `400` (missing/invalid fields, or a
  superadmin request missing `?tenantId=`, or store-level errors like a
  duplicate contact), `429` (rate limit). No response ever confirms or
  denies whether a given email exists.

## Testing

- `test/auth.test.js` — store logic only, no HTTP:
  `better-sqlite3(':memory:')`; covers `createUser`, `verifyPassword`
  (correct/incorrect password, unknown email), `createSession`/
  `getSession`/`deleteSession`, session expiry, and that the password hash
  never contains the plaintext password.
- `test/http/server.test.js` — starts the real Express app on an ephemeral
  port (`app.listen(0)`) and drives it with native `fetch` (no new
  `supertest` dependency — matches the codebase's existing native-fetch
  convention):
  - correct login → `200` + `Set-Cookie`; wrong password → `401`.
  - the `must_change_password` gate blocks `/api/contacts` until the
    password is changed.
  - a tenant user cannot read another tenant's data even by passing that
    tenant's id as `?tenantId=`.
  - a superadmin without `?tenantId=` gets `400`; with it, sees that tenant.
  - logout deletes the session; a subsequent `/api/contacts` call is `401`.
  - the rate limiter returns `429` after the configured number of failures.
- `scripts/create-user.mjs` stays a thin wrapper around
  `authStore.createUser` — all the validated logic lives in the tested
  store, so the CLI itself doesn't need its own automated test.

## Provisioning and config

`scripts/create-user.mjs`, run manually
(`node scripts/create-user.mjs --email=... --tenant=<tenant-id>` or
`--superadmin`):
- Generates a random temporary password if `--password` isn't given,
  creates the `users` row with `must_change_password = true`, and prints the
  password to the console once (never stored in plaintext) — shared with the
  customer out-of-band, per the onboarding decision above.
- `--tenant=<id>` is validated against the live tenant registry
  (`registry.load()`) before creating the user; an unknown/inactive tenant id
  is an error, not a silently-orphaned user.

New `config.js` fields (same fail-fast, collected-errors pattern as the rest
of `loadConfig`): `httpPort` (default `3000`, env `HTTP_PORT`),
`sessionTtlHours` (default `168`, env `SESSION_TTL_HOURS`), `corsOrigin`
(env `CORS_ORIGIN`, empty disables CORS), `loginRateLimitMax` /
`loginRateLimitWindowMinutes` (default `10` / `15`).

`.env.example` documents these plus a short note on using
`scripts/create-user.mjs`.

## Explicitly out of scope for this sub-project

- Dashboard UI (sub-project 3) — this stage ships an API only, no browser
  frontend.
- Email-based invite/password-reset — deferred; v1 is admin-provisioned only.
- Per-tenant roles (admin vs member) — every tenant user has equal access
  in v1.
- Voice channel — deferred long since (sub-project 4).
- Multi-tenant membership (one user belonging to more than one tenant) — a
  user is exactly one tenant's, or a superadmin belonging to none.
