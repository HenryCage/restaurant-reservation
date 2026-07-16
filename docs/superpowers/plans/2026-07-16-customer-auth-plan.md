# Implementation plan: Customer-facing auth + HTTP API

Spec: `docs/superpowers/specs/2026-07-16-customer-auth-design.md`
Status: implemented and committed (steps 1-9), step 10's manual smoke check
run live against a real server with scratch/fake credentials (login,
must_change_password gate, change-password, logout, contact create/list,
superadmin ?tenantId= requirement all verified over real HTTP) -- artifacts
cleaned up afterward, nothing committed for step 10 itself.

## Sequencing rationale

Same bottom-up shape as the Foundation merge plan: schema → store → HTTP
plumbing → routes → CLI → wiring. `npm test` stays green after every step.
Steps 1-7 are purely additive (nothing in `src/db.js`'s existing tables,
`contacts.js`, `campaigns.js`, `processor.js`, `campaignScheduler.js`, or
`tenants.js` changes shape) except the one explicitly-scoped addition to
`campaigns.js` in step 2.

One implementation-level call not spelled out in the spec: cookie
parsing/writing. The spec only says "reads the `sid` cookie" / "responds with
`Set-Cookie: ...`" — it doesn't mandate a library. Since the app only ever
needs to read and write **one** cookie (`sid`), hand-roll a tiny
`src/http/cookies.js` helper (`parseCookie(header, name)`,
`serializeCookie(name, value, opts)`) instead of adding a `cookie-parser`
dependency — consistent with the spec's own "no new dependency beyond
Express/cors" framing for the rest of this sub-project.

## Step 1 — `users`/`sessions` schema in `src/db.js`

- Add the two `CREATE TABLE IF NOT EXISTS` statements from the spec's Data
  model section to `SCHEMA` in `src/db.js` (same file, same function,
  additive to the existing three tables).
- `test/db.test.js`: extend with a round-trip insert/select for `users` and
  `sessions`, and a case asserting `users.email` `UNIQUE` throws on a
  duplicate.
- Checkpoint: `npx vitest run test/db.test.js`.

## Step 2 — `src/campaigns.js`: add `listCampaigns(tenantId)`

- The spec's `GET /api/campaigns` needs a tenant-scoped "list all campaigns"
  read, which doesn't exist yet (`campaigns.js` currently only has
  `listDueCampaigns(at)`, which is global and scheduler-internal). Add
  `listCampaigns(tenantId)` returning all campaigns for that tenant
  (`toCampaign`-mapped, newest first), following the existing file's
  conventions exactly.
- `test/campaigns.test.js`: extend with a case for `listCampaigns` (returns
  only the requesting tenant's campaigns, in the expected order).
- Checkpoint: `npx vitest run test/campaigns.test.js`.

## Step 3 — `src/auth.js`

- `npm install express cors` (the two new runtime dependencies the spec
  approved; nothing else).
- Password hashing helpers (`node:crypto`, no new dependency):
  `hashPassword(plain)` → `scrypt:<saltHex>:<hashHex>` (random salt via
  `randomBytes(16)`, `scryptSync(plain, salt, 64)`); `verifyPasswordHash(plain, stored)`
  → boolean, using `timingSafeEqual` on the derived key (not `===`) to avoid
  a timing side-channel.
- `createAuthStore(db, deps = {})` (mirrors `contacts.js`'s shape) returning:
  - `createUser({ tenantId, email, password, isSuperadmin = false })` —
    validates `tenantId XOR isSuperadmin` (superadmin ⇒ `tenantId` must be
    `null`; tenant user ⇒ `tenantId` required), enforces the 8-char minimum,
    hashes the password, sets `must_change_password = 1`, throws a clear
    error on a duplicate email (pre-check, same pattern as
    `contacts.js#createContact`).
  - `verifyPassword(email, password)` — returns the user row (without the
    hash) on success, `null` on a missing user or a wrong password (same
    return shape either way, per the spec's "don't reveal whether an email
    exists" rule — the HTTP layer turns both into an identical 401).
  - `createSession(userId)` — inserts a `sessions` row with
    `expires_at = now + sessionTtlHours`, returns the session id.
  - `getSession(sessionId)` — returns `{ userId, ... }` if present and not
    expired; deletes and returns `null` if expired (lazy cleanup, no cron
    needed).
  - `deleteSession(sessionId)`.
  - `changePassword(userId, { currentPassword, newPassword })` — verifies
    the current hash, re-hashes, clears `must_change_password`.
  - `getUser(userId)`.
- `test/auth.test.js`: `createUser` (tenant user, superadmin, rejects
  tenantId+isSuperadmin both set, rejects neither set, rejects short
  password, rejects duplicate email); `verifyPassword` (correct, wrong
  password, unknown email — assert identical return shape for the latter
  two); `createSession`/`getSession` (valid, expired -> null and
  self-deletes); `deleteSession`; `changePassword` (wrong current password
  rejected, correct one updates hash and clears the flag); assert the raw
  `password_hash` column never equals or contains the plaintext password.
- Checkpoint: `npx vitest run test/auth.test.js`.

## Step 4 — `src/http/cookies.js`

- `parseCookie(cookieHeader, name)` → string or `undefined` (simple
  `key=value; key2=value2` split, no dependency).
- `serializeCookie(name, value, { maxAgeSeconds, secure })` → the
  `Set-Cookie` header string (`HttpOnly`, `SameSite=Lax`, `Path=/`,
  conditionally `Secure`, `Max-Age`). `maxAgeSeconds <= 0` produces the
  logout/expiry form.
- `test/http/cookies.test.js`: round-trip parse of a multi-cookie header;
  serialize includes/excludes `Secure` correctly; `maxAgeSeconds: 0` case.
- Checkpoint: `npx vitest run test/http/cookies.test.js`.

## Step 5 — `src/http/middleware/requireAuth.js` + rate limiter

- `createRateLimiter({ max, windowMinutes, now? })` — small standalone
  module (`src/http/rateLimiter.js`), `Map`-backed, exposing
  `check(key)` (throws/returns a boolean before the attempt) and
  `reset(key)` (called on a successful login). Kept separate from
  `requireAuth.js` so it's unit-testable without an Express request/response
  at all.
- `createRequireAuth({ authStore })` → an Express middleware: reads `sid` via
  `parseCookie`, 401 if absent/invalid/expired, loads the user via
  `authStore.getUser`/session, sets `req.authUser = { id, tenantId, isSuperadmin }`,
  403 with `{ code: 'must_change_password' }` if that flag is set and
  `req.path !== '/auth/change-password'`.
- `test/http/rateLimiter.test.js`: allows up to `max` attempts, blocks the
  next one, resets on `reset(key)`, and windows expire (fake `now`).
- `test/http/requireAuth.test.js`: uses fake Express-shaped
  `req`/`res`/`next` objects (matching how `processor.test.js` fakes its
  collaborators, not a real server) — missing cookie → 401 + `next` not
  called; expired session → 401; valid session + `must_change_password` →
  403 on a non-exempt path, but passes through on `/auth/change-password`;
  valid session + password already changed → `next()` called with
  `req.authUser` populated correctly for both a tenant user and a superadmin.
- Checkpoint: `npx vitest run test/http/rateLimiter.test.js test/http/requireAuth.test.js`.

## Step 6 — `src/http/routes/auth.js`

- `POST /auth/login` — rate-limit check (by email) before touching the DB;
  `authStore.verifyPassword`; on failure, identical 401 body/status for
  "no such user" and "wrong password"; on success, `createSession`,
  `serializeCookie`, reset the rate limiter for that email, respond
  `{ mustChangePassword, tenantId, isSuperadmin }`.
- `POST /auth/logout` — behind `requireAuth`; `deleteSession`, respond with
  the expired cookie.
- `POST /auth/change-password` — behind `requireAuth` (which must allow this
  path through even mid-`must_change_password`, per step 5); calls
  `authStore.changePassword`; 400 with the store's error on a wrong current
  password or a too-short new one.
- `test/http/authRoutes.test.js` — real Express app on an ephemeral port
  (`app.listen(0)`), driven with native `fetch`, `Cookie`/`Set-Cookie`
  handled manually (no cookie-jar library): the full spec test list for
  login/logout/change-password (correct/incorrect login, cookie shape,
  must-change-password gate, rate limiting, logout invalidates the
  session). This file becomes the shared harness (helper to spin up/tear
  down the server) that step 7's tests reuse.
- Checkpoint: `npx vitest run test/http/authRoutes.test.js`.

## Step 7 — `src/http/routes/contacts.js` + `src/http/routes/campaigns.js` + `src/http/server.js`

- Both route files follow the same shape: `createXRoutes({ xStore })`
  returning an Express `Router`; every handler behind `requireAuth`;
  resolve the effective `tenantId` with one shared tiny helper (e.g.
  `resolveTenantId(req, res)` in `src/http/middleware/requireAuth.js` or a
  sibling file) — non-superadmin always uses `req.authUser.tenantId`;
  superadmin requires `?tenantId=` or 400. `GET` calls
  `listContacts`/`listCampaigns`; `POST` calls `createContact`/
  `createCampaign`, mapping the store's thrown `Error` to a `400` with its
  message (no new validation logic duplicated in the route).
- `src/http/server.js`: `createHttpServer({ config, logger, authStore, contactsStore, campaignsStore, registry })`
  — builds the Express app, `express.json()`, `cors({ origin: config.corsOrigin || false, credentials: true })`,
  mounts `/auth/*` and `/api/contacts`, `/api/campaigns`; a catch-all JSON
  404; an Express error-handling middleware that logs and returns a generic
  500 (never leaks stack traces to the client). Returns the app (caller
  decides `.listen(...)`, matching the rest of the codebase's
  create-then-caller-drives pattern).
- `test/http/apiRoutes.test.js` (reuses step 6's server-harness helper):
  tenant user can list/create their own contacts and campaigns; cannot see
  another tenant's via a spoofed `?tenantId=`; superadmin without
  `?tenantId=` gets 400, with it sees that tenant's data; an unauthenticated
  request to any `/api/*` route is 401; a store-level validation error
  (e.g. duplicate contact, unknown `sendTo`) surfaces as 400 with a message.
- Checkpoint: `npx vitest run test/http`.

## Step 8 — `scripts/create-user.mjs`

- Plain Node script (not a `src/` module, no test file — per the spec, the
  validated logic lives in `authStore` which is already tested). Parses
  `--email`, `--tenant`, `--superadmin`, `--password` (optional) from
  `process.argv`; builds `config`/`registry`/`db`/`authStore` the same way
  `index.js` does; if `--tenant` is given, checks it against
  `registry.load()` and errors out if unknown/inactive; generates a random
  password via `crypto.randomBytes` when `--password` is omitted; calls
  `authStore.createUser`; prints the email and the (one-time) password to
  stdout; non-zero exit code on any validation error.
- No automated checkpoint (per the spec) — verified manually in step 10.

## Step 9 — `config.js` + `index.js` wiring + `.env.example`

- `config.js`: add `httpPort` (`parseIntEnv`, default `3000`),
  `sessionTtlHours` (default `168`), `corsOrigin` (trimmed string, empty
  allowed), `loginRateLimitMax` (default `10`), `loginRateLimitWindowMinutes`
  (default `15`) — same fail-fast pattern as the rest of `loadConfig`.
- `index.js`: build `authStore = createAuthStore(db, { sessionTtlHours: config.sessionTtlHours })`
  (reuses the same `db` instance already created for contacts/campaigns —
  one SQLite file, not a second one); build `httpServer =
  createHttpServer({ config, logger, authStore, contactsStore, campaignsStore, registry })`;
  `httpServer.listen(config.httpPort, () => logger.info(...))`. No new
  `setInterval` here — HTTP servers are event-driven, not polled.
- `.env.example`: document `HTTP_PORT`, `SESSION_TTL_HOURS`, `CORS_ORIGIN`,
  `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MINUTES`, plus a short
  note pointing at `scripts/create-user.mjs` for provisioning the first user.
- Checkpoint: `npm test` (full suite).

## Step 10 — manual smoke check

Unlike sub-project 1's step 9, nothing here touches Google Sheets or a real
SMS provider — it's entirely local HTTP + SQLite, so this can be run for
real without the same caution:

- `npm run dev` with a scratch `.env`/`tenants.json` (one active tenant).
- `node scripts/create-user.mjs --email=test@example.com --tenant=<that-tenant-id>`
  — confirm it prints a password and exits 0.
- `curl -i -c cookies.txt -X POST localhost:$HTTP_PORT/auth/login -H 'Content-Type: application/json' -d '{"email":"test@example.com","password":"<printed>"}'`
  — confirm `Set-Cookie` and `mustChangePassword: true`.
- Confirm `curl -b cookies.txt localhost:$HTTP_PORT/api/contacts` returns
  403 `must_change_password` before changing it, and 200 `[]` after calling
  `/auth/change-password`.
- `node scripts/create-user.mjs --superadmin --email=admin@example.com` then
  log in as them and confirm `/api/contacts` without `?tenantId=` is 400,
  with it (`?tenantId=<that-tenant-id>`) is 200.
- Delete the scratch `.env`/`tenants.json`/`data/*.db` artifacts afterward if
  they're not the developer's real local config.

## Out of scope reminders (carried from the spec)

No dashboard UI, no email-based invite/reset, no per-tenant roles, no voice
channel, no multi-tenant user membership.
