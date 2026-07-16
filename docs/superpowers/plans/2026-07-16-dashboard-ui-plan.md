# Implementation plan: Dashboard UI

Spec: `docs/superpowers/specs/2026-07-16-dashboard-ui-design.md`
Status: not started

## Sequencing rationale

Backend additions first (small, testable in isolation with the existing
harness), then the frontend bottom-up: scaffold → fetch wrapper → small
screens → dashboard sub-components → composition → top-level wiring →
production build wiring → a real browser smoke check last. `npm test`
(backend) and `npm test` inside `client/` both stay green after their
respective steps.

One naming note carried into this plan: `client/`'s own `package.json` and
`vite.config.js` etc. duplicate autoNotify's tooling choices (Vite, Tailwind
v3-style config with `tailwind.config.js`/`postcss.config.js`) but **drop
the TypeScript devDependency** autoNotify had -- its actual source was plain
`.jsx`/`.js` throughout despite the TS package being installed, and this
repo's backend has no TypeScript anywhere either. Plain JS/JSX keeps the two
halves of the repo consistent.

## Step 1 — `GET /auth/me`

- `src/http/routes/auth.js`: add `router.get('/me', requireAuth, (req, res) => { ... })`
  returning `{ mustChangePassword: <from a fresh authStore.getUser lookup, not
  the stale req.authUser>, tenantId: req.authUser.tenantId, isSuperadmin: req.authUser.isSuperadmin }`.
  Add `'/me'` to the route's `requireAuth`'s `exemptPaths` alongside
  `'/change-password'` and `'/logout'` -- it must be reachable while gated,
  otherwise the frontend has no way to detect "I'm gated" on a page load.
- `test/http/authRoutes.test.js`: extend with `GET /auth/me` cases --
  `401` with no cookie; correct body for a logged-in, non-gated user;
  reachable (not `403`) while `must_change_password` is still true, and its
  body reflects that.
- Checkpoint: `npx vitest run test/http/authRoutes.test.js`.

## Step 2 — `GET /api/orders`

- `src/http/routes/orders.js`: `createOrdersRoutes({ requireAuth, registry, sheets })`.
  `GET /` — `resolveTenantId(req, req.query)` (400 if a superadmin omitted
  `?tenantId=`, same as the other routes); look up
  `registry.load().find(t => t.id === tenantId)` (404 `{ error: "tenant not found" }`
  if absent/inactive -- `registry.load()` already filters to active tenants,
  so a deactivated tenant naturally 404s here too); call
  `sheets.readOrders(tenant.sheetId, tenant.sheetName)`; on `{ ok: true, rows }`
  respond `200` with `rows`; on `{ ok: false, error }` respond `502 { error }`
  (a sheet-shape problem, not this service's fault, but also not a `500` --
  the request itself was valid).
- `src/http/server.js`: accept `registry`/`sheets` in `createHttpServer`'s
  deps, mount `app.use('/api/orders', createOrdersRoutes({ requireAuth: apiRequireAuth, registry, sheets }))`
  alongside the existing `/api/contacts`/`/api/campaigns` mounts.
- `src/index.js`: pass the already-constructed `registry` and `sheets`
  (created earlier in `main()` for the processor) into `createHttpServer(...)`
  -- reusing the same instances, not creating new ones.
- `test/http/helpers/testServer.js`: extend `startTestServer(opts)` to accept
  optional `opts.registry`/`opts.sheets` fakes (defaulting to an empty
  registry and a `readOrders` that returns `{ ok: true, rows: [] }`), passed
  through to `createHttpServer`.
- `test/http/ordersRoutes.test.js` (new): a tenant user sees their own
  fake sheet's rows; cannot see another tenant's via a spoofed `?tenantId=`;
  superadmin without `?tenantId=` gets `400`, with a valid one gets `200`;
  an unknown tenant id gets `404`; a `sheets.readOrders` failure (fake
  returns `{ ok: false, error: '...' }`) surfaces as `502` with that message,
  not a crash; unauthenticated is `401`.
- Checkpoint: `npx vitest run test/http`.

## Step 3 — `client/` scaffold

- `client/package.json`: `react`, `react-dom`, `@heroicons/react` (deps);
  `vite`, `@vitejs/plugin-react`, `tailwindcss` (v3), `autoprefixer`,
  `postcss` (devDeps) -- matches autoNotify's actual runtime choices, minus
  TypeScript per the rationale above. Scripts: `dev` (`vite`), `build`
  (`vite build`), `test` (`vitest run`).
- `client/vite.config.js`, `client/tailwind.config.js`, `client/postcss.config.js`,
  `client/index.html`, `client/src/main.jsx`, `client/src/index.css`
  (`@tailwind base/components/utilities`), `client/src/App.jsx` (temporary
  placeholder: renders a heading only -- replaced incrementally in later
  steps).
- `npm install` inside `client/`.
- `client/vitest.config.js` (`environment: 'jsdom'`) + devDeps `vitest`,
  `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`; one
  trivial `client/src/App.test.jsx` asserting the placeholder heading
  renders, to prove the whole toolchain (Vite + Vitest + RTL + jsdom) works
  before building anything real on top of it.
- Checkpoint: `cd client && npm run build` succeeds; `npm test` (inside
  `client/`) passes the placeholder test.

## Step 4 — `client/src/api.js`

- A thin `fetch` wrapper: `createApiClient({ baseUrl = '', onUnauthorized })`
  returning `{ get(path, opts), post(path, body, opts) }`. Every call sets
  `credentials: 'include'`; a `401` response calls `onUnauthorized()` and
  then rejects (callers don't need their own 401-handling branch); other
  non-2xx responses reject with an `Error` whose message is the parsed
  `{ error }` body (falling back to `res.statusText`).
- `client/src/api.test.js`: mocks global `fetch`; asserts `credentials:
  'include'` is always set; a `401` triggers `onUnauthorized` and the
  promise rejects; a `400` with `{ error: "x" }` rejects with message `"x"`;
  a `200` resolves with the parsed JSON body.
- Checkpoint: `cd client && npm test -- api.test.js`.

## Step 5 — `LoginScreen` + `ChangePasswordScreen`

- `client/src/screens/LoginScreen.jsx`: email/password controlled inputs,
  submit calls `api.post('/auth/login', {...})`; `401` renders "Invalid
  email or password"; `429` renders "Too many attempts, try again later";
  success calls a supplied `onLogin(meResponseShape)` prop.
- `client/src/screens/ChangePasswordScreen.jsx`: current/new/confirm
  password fields; confirm-mismatch blocks submit client-side with an inline
  message (never reaches the API); submit calls
  `api.post('/auth/change-password', {...})`; success calls `onChanged()`.
- `client/src/screens/LoginScreen.test.jsx`,
  `client/src/screens/ChangePasswordScreen.test.jsx`: mock the `api`
  client (not `fetch` directly, now that step 4 exists) -- successful
  submit calls the right callback with the right args; each error path
  renders its message; the confirm-mismatch case never calls `api.post`.
- Checkpoint: `cd client && npm test -- screens/LoginScreen screens/ChangePasswordScreen`.

## Step 6 — `TenantPickerScreen`

- `client/src/screens/TenantPickerScreen.jsx`: a single tenant-id text
  input; submit calls `onPick(tenantId)` (no API call of its own -- the
  spec's validation happens implicitly via the dashboard's first real fetch
  once a tenant id is chosen; this screen is a pure input step).
- `client/src/screens/TenantPickerScreen.test.jsx`: submitting calls
  `onPick` with the trimmed input value; an empty submit is blocked
  client-side.
- Checkpoint: `cd client && npm test -- screens/TenantPickerScreen`.

## Step 7 — `StatTiles` + `ContactsPanel`

- `client/src/components/StatTiles.jsx`: pure presentational, takes
  `{ contacts, campaigns }` arrays as props, derives counts (`contacts.length`,
  and a per-status count over `campaigns`) -- no fetching of its own.
- `client/src/components/ContactsPanel.jsx`: fetches `GET /api/contacts`
  on mount and every 5s (`setInterval`, cleared on unmount); an add-contact
  form (`POST /api/contacts`) that re-fetches the list on success and shows
  the store's error message on failure (e.g. duplicate phone).
- Tests for both, mocking `api`: `StatTiles` renders the right numbers from
  given props; `ContactsPanel` renders a fetched list, submits a new
  contact and shows it after refetch, shows the server's error text on a
  failed add, and its interval is cleared on unmount (fake timers).
- Checkpoint: `cd client && npm test -- components/StatTiles components/ContactsPanel`.

## Step 8 — `CampaignForm` + `CampaignHistory`

- `client/src/components/CampaignForm.jsx`: name/message/`sendTo` (a
  `<select>` built from a `contacts` prop: `All contacts` + one option per
  contact) /`scheduledTime` (`datetime-local` input, optional -- an empty
  value is resolved to `new Date().toISOString()` client-side before
  `POST /api/campaigns`); shows the server's error on failure (e.g. unknown
  `sendTo`); calls an `onCreated()` prop on success.
- `client/src/components/CampaignHistory.jsx`: fetches `GET /api/campaigns`
  on mount and every 5s; renders a table (name, `sendTo`, `scheduledTime`,
  `status`).
- Tests: `CampaignForm` submits the expected payload including the
  blank-time-becomes-now behavior (fake a fixed `Date.now`), shows the
  server error on a rejected submit; `CampaignHistory` renders fetched
  rows, polls, clears its interval on unmount.
- Checkpoint: `cd client && npm test -- components/CampaignForm components/CampaignHistory`.

## Step 9 — `OrdersTable`

- `client/src/components/OrdersTable.jsx`: fetches `GET /api/orders` on
  mount and every 45s (a client-side constant, per the spec's 30-60s
  range); renders a table (Order ID, Name, Phone, Status, Last Notified
  Status, Last Error); a `502`/network failure renders an inline error
  banner instead of an empty table (distinguishable from "genuinely no
  orders yet").
- `client/src/components/OrdersTable.test.jsx`: renders fetched rows;
  distinguishes an empty-but-successful response from a failed one; polls
  at the configured interval, not the 5s one (fake timers, advance by 5s
  and assert no second fetch yet, then advance to 45s and assert it fired).
- Checkpoint: `cd client && npm test -- components/OrdersTable`.

## Step 10 — `DashboardScreen`

- `client/src/screens/DashboardScreen.jsx`: owns the `contacts`/`campaigns`
  fetch state shared between `StatTiles` and its children (`ContactsPanel`/
  `CampaignHistory` still do their own polling internally per steps 7-8;
  `DashboardScreen` also does one shared fetch on mount purely to hand
  initial data to `StatTiles`, which otherwise has no fetch of its own).
  Composes `StatTiles`, `ContactsPanel`, `CampaignForm`, `CampaignHistory`,
  `OrdersTable` in the autoNotify-mirroring layout (two-column: form +
  history on the wide side, contacts panel on the narrow side, stats row on
  top, orders table below).
- `client/src/screens/DashboardScreen.test.jsx`: renders all five child
  regions given mocked `api` responses; a failed initial fetch renders an
  error state instead of a half-populated screen.
- Checkpoint: `cd client && npm test -- screens/DashboardScreen`.

## Step 11 — `App.jsx` (top-level auth state machine)

- Replaces the step 3 placeholder. On mount, calls `GET /auth/me`:
  - `401` -> `LoginScreen`.
  - `200` + `mustChangePassword: true` -> `ChangePasswordScreen`.
  - `200` + `isSuperadmin: true` + no tenant chosen yet -> `TenantPickerScreen`.
  - otherwise -> `DashboardScreen`.
  `onUnauthorized` (wired into `createApiClient`) resets state back to
  `LoginScreen` with a "Session expired, please log in again" banner, from
  anywhere in the tree.
- `client/src/App.test.jsx` (replaces the step 3 placeholder test): one
  case per `/auth/me` response shape above, asserting the right screen
  renders; a `401` from a later call (simulated via the mocked `api`
  triggering `onUnauthorized`) switches back to `LoginScreen` with the
  expiry message.
- Checkpoint: `cd client && npm test` (full client suite).

## Step 12 — Production build wiring

- `src/http/server.js`: when `config.isProduction`, add (in this order,
  relative to the existing `/auth`, `/api/contacts`, `/api/campaigns`,
  `/api/orders` mounts and the existing JSON `404`/error-handling
  middleware from sub-project 2): `express.static(clientDistPath)`, then an
  SPA-fallback handler for any unmatched `GET` that isn't `/api/*` or
  `/auth/*` (serves `index.html` from the same directory), inserted
  **before** the existing catch-all JSON `404` so real API 404s are
  unaffected. `clientDistPath` resolved via `fileURLToPath(new URL('../../client/dist', import.meta.url))`
  (ESM-safe, no `__dirname`).
- `test/http/*`: existing suites keep `config.isProduction: false` (already
  the harness default), so this new branch is inert for them; a new small
  case in `test/http/server.test.js` (new file) build-checks that with
  `isProduction: true` and a real (test-fixture) `client/dist/index.html`
  on disk, a random unmatched `GET` path returns that file's content,
  while `/api/nonexistent` still returns the JSON `404`.
- Checkpoint: `npx vitest run test/http`.

## Step 13 — manual smoke check (real browser)

Like sub-project 2's step 10, this touches no real Google Sheets/SMS
credentials (fake ones are enough to prove the wiring; the orders view
will correctly show its `502` error state against a fake sheet, which is
itself a useful check).

- `cd client && npm run build`.
- Start the backend as in sub-project 2's smoke check (scratch
  `tenants.json`, fake Google/SMS env vars, `NODE_ENV=production` this time
  so the static/SPA branch from step 12 is actually exercised), provision a
  tenant user and a superadmin via `scripts/create-user.mjs`.
- Open the app in a real browser (via the `webapp-testing` skill/Playwright):
  log in as the tenant user, confirm the change-password gate, change it,
  land on the dashboard, add a contact, create a campaign, confirm it
  appears in the history table, confirm the orders table shows its `502`
  banner (expected, given the fake sheet credentials) rather than crashing
  the page; log out and confirm it returns to the login screen; log in as
  the superadmin, confirm the tenant-picker screen appears, pick the tenant,
  confirm the dashboard loads that tenant's data.
- Clean up scratch `.env`/`tenants.json`/`data/*.db` artifacts afterward.

## Out of scope reminders (carried from the spec)

No voice-channel UI, no `/api/stats` endpoint, no per-tenant roles in the
UI, no edit/delete for contacts or campaigns, no real-time push (polling
only).
