# Dashboard UI

Date: 2026-07-16
Status: implemented (see docs/superpowers/plans/2026-07-16-dashboard-ui-plan.md
for the step-by-step commit history and the live browser smoke-test results).
Sub-project: 3 of 4 (see `docs/superpowers/specs/2026-07-16-foundation-merge-design.md`
Context section for the full list). Depends on sub-project 1 (Foundation
merge) and sub-project 2 (customer-facing auth + HTTP API), both implemented.

## Context

Sub-projects 1 and 2 gave the platform SQLite-backed contacts/campaigns and a
tenant-scoped, session-authenticated HTTP API (`/auth/*`, `/api/contacts`,
`/api/campaigns`). Nothing renders any of it in a browser yet.

The colleague's autoNotify prototype (`sms-automation-main.zip`, extracted
for reference, not part of this repo) has a React 19 + Vite + Tailwind +
`@heroicons/react` dashboard: stat tiles, a contacts panel, a "new
automation" form (SMS/CALL tabs, message, optional schedule, send-to-one-
or-all), and an automation history table. Its backend (Express + flat
`db.json`, Twilio SMS+voice, no auth, no tenants) no longer applies — this
spec reuses its visual structure and layout, not its code or its API shapes.

**Scope gap found and resolved during brainstorming:** the original merge
plan described the dashboard as also showing "automatic-notification history
(read-only)" — the sheet-driven engine's send history. That history lives
only as cells inside each tenant's Google Sheet (written back by
`processor.js`); no sub-project 1 or 2 endpoint reads it back out. The user
chose to include it now rather than defer it, so this sub-project is not
purely a frontend task — it also adds one small new backend read endpoint.

## Decisions made during brainstorming

- **Visual reuse, not code reuse**: same Tailwind-driven layout/stat-tile/
  form/table structure as autoNotify's `App.jsx`, but all data logic (fetch
  calls, field names, state) is written fresh against this repo's actual
  API. The CALL tab is dropped (voice is deferred). Login and
  change-password screens are new — autoNotify had no auth at all.
- **Order/notification history is in scope**: a new `GET /api/orders`
  endpoint (tenant-scoped, reads live from the tenant's Google Sheet via the
  existing `sheets.readOrders()`) backs a read-only table in the dashboard.
- **No client-side router**: plain conditional rendering in `App.jsx` driven
  by auth state (`loading → login → mustChangePassword → tenantPicker (superadmin only) → dashboard`).
  Matches autoNotify's own precedent and this app's screen count (a router
  would be pure overhead here).
- **Superadmin gets a UI in v1**: a tenant-picker screen (enter/pick a
  tenant id) shown after login for superadmins, before the main dashboard —
  not deferred to a later stage.
- **Differentiated polling**: contacts/campaigns (local SQLite, cheap) poll
  every 5s, matching autoNotify's original cadence. The new orders view
  (a live Google Sheets API call per request) polls every 30–60s instead, to
  avoid burning Sheets API quota per open dashboard tab.
- **Frontend gets its own test suite**: Vitest + React Testing Library
  (new dev dependencies), component-level tests per screen, `fetch` mocked
  in every test — no real API calls from the test suite.
- **Single deployable in production**: `src/http/server.js` serves the
  built `client/dist/` via `express.static()` plus an SPA fallback to
  `index.html`, gated on `config.isProduction`. `CORS_ORIGIN` remains useful
  for local dev only (Vite's dev server runs on a different port).

## Architecture

```
client/                          # new: separate React app, its own package.json
  index.html, vite.config.js, tailwind.config.js, postcss.config.js
  src/
    main.jsx, App.jsx             # top-level: which screen to show, based on auth state
    api.js                         # fetch wrapper: credentials:'include', 401 -> onUnauthorized()
    screens/
      LoginScreen.jsx
      ChangePasswordScreen.jsx
      TenantPickerScreen.jsx        # superadmin only
      DashboardScreen.jsx            # composes the panels below
    components/
      StatTiles.jsx, ContactsPanel.jsx, CampaignForm.jsx, CampaignHistory.jsx, OrdersTable.jsx
  vitest.config.js                 # component tests, jsdom environment

src/http/routes/
  orders.js                       # new: GET /api/orders
  auth.js                          # modified: gains GET /me
```

`client/` is a fully separate npm project (its own `package.json`,
dependencies, dev server) living inside this repo, the way `sms-automation-main`'s
`client/` did — not a workspace/monorepo tooling change, just a sibling
directory. The backend gains two small additions: `orders.js` (a new route
file, same shape as `contacts.js`/`campaigns.js`) and one new handler in the
existing `auth.js` routes.

### `GET /auth/me` (new, in `src/http/routes/auth.js`)

Behind `requireAuth` with the same `must_change_password` exemption as
`/logout` (a page reload while gated must still be able to determine "am I
gated?" without a chicken-and-egg problem). Returns
`{ mustChangePassword, tenantId, isSuperadmin }` — identical shape to the
login response — or `401` if there's no valid session. This is what
`App.jsx` calls once on startup to decide which screen to render; without
it, a page refresh would have no way to distinguish "not logged in" from
"logged in, needs to reselect their screen."

### `GET /api/orders` (new, `src/http/routes/orders.js`)

`createOrdersRoutes({ requireAuth, registry, sheets })` — the first route
file needing `registry`/`sheets` rather than a SQLite store. Resolves the
tenant via the existing `resolveTenantId(req, req.query)` helper, looks up
that tenant's full record via `registry.load().find(t => t.id === tenantId)`
(404 if not found/inactive), calls
`sheets.readOrders(tenant.sheetId, tenant.sheetName)`, and returns its
`rows` array as JSON on success. A sheet read failure returns `502` with the
underlying error message — this endpoint does not retry or cache; it
reflects the sheet's current state on every call, the same "sheet is the
single source of truth" principle the rest of the system already follows.

## Screens and components

- **LoginScreen** — email + password, `POST /auth/login`; `401` renders
  "Invalid email or password" (the identical message the backend already
  guarantees for both wrong-password and unknown-email); `429` renders "Too
  many attempts, try again later."
- **ChangePasswordScreen** — shown whenever `mustChangePassword` is true;
  current + new password (+ confirmation field, checked client-side only —
  the backend doesn't need a third field); on success, re-fetches `/auth/me`
  to move to the next screen.
- **TenantPickerScreen** (superadmin only) — a text input for a tenant id;
  the chosen id is held in React state (not the URL, per the no-router
  decision) and passed as `?tenantId=` on every subsequent API call; an
  invalid/inactive tenant id surfaces the API's own error message (e.g. from
  a failed `/api/contacts?tenantId=...` probe call).
- **DashboardScreen** — composes:
  - `StatTiles`: contact count and campaign-status counts, computed
    client-side from the already-fetched contacts/campaigns lists (no
    separate `/api/stats` endpoint — YAGNI, this repo has no such thing and
    the counts are cheap to derive from data already on the page).
  - `ContactsPanel`: list + add-contact form, structurally mirroring
    autoNotify's contacts card.
  - `CampaignForm`: name, message, a `sendTo` dropdown populated from the
    fetched contacts list (`All contacts` plus one entry per contact,
    mirroring autoNotify) — no CALL tab. A blank `scheduledTime` submits the
    current time (client-computed), reproducing autoNotify's "leave blank
    for immediate" UX, since `campaigns.js`'s `createCampaign` itself always
    requires a `scheduledTime` value.
  - `CampaignHistory`: table from `GET /api/campaigns`, mirroring
    autoNotify's automation history table (name, recipients, scheduled
    time, status).
  - `OrdersTable`: table from `GET /api/orders` (Order ID, Name, Phone,
    Status, Last Notified Status, Last Error) — new, no autoNotify
    equivalent.

## Data flow and polling

All requests go through `client/src/api.js`, a thin `fetch` wrapper that
always sets `credentials: 'include'` and, on any `401` response, calls a
supplied `onUnauthorized()` callback instead of returning normally —
`App.jsx` wires this to reset to `LoginScreen` with a "Session expired,
please log in again" message, so an expired/invalidated session is handled
in exactly one place, not re-checked in every component.

Polling cadence: `ContactsPanel` and `CampaignHistory` re-fetch every 5
seconds (matches autoNotify, cheap local-SQLite-backed reads). `OrdersTable`
re-fetches every 30–60 seconds (a client-side constant, not an env var —
this is a UI-only tuning knob, not an operator-facing setting) to avoid
generating a Google Sheets API call every 5 seconds per open dashboard tab.

## Error handling

Store-level and route-level errors already return `{ error: "<message>" }`
per the sub-project 2 spec's conventions; the frontend renders that message
directly wherever a form/action fails (contact creation, campaign creation,
tenant-picker probe) — no separate client-side error-message catalog to
keep in sync with the backend.

## Testing

- `test/http/ordersRoutes.test.js` (backend) — same real-server-over-fetch
  harness as the other `test/http/*` suites: tenant user sees their own
  sheet's rows; cannot see another tenant's via a spoofed `?tenantId=`;
  superadmin requires `?tenantId=`; a `sheets.readOrders` failure surfaces
  as `502`, not a crash.
- `test/http/authRoutes.test.js` gains cases for the new `GET /auth/me`:
  `401` with no session; correct body once logged in; still reachable (not
  blocked) while `mustChangePassword` is true.
- `client/`: Vitest + React Testing Library, `jsdom` environment, `fetch`
  mocked per test (no network, no real backend). One test file per screen
  covering: `LoginScreen` (successful submit calls `onLogin`; `401`/`429`
  render the right message); `ChangePasswordScreen` (mismatched confirmation
  blocks submit client-side; success calls the re-check callback);
  `TenantPickerScreen` (submitting an id calls through); `DashboardScreen`'s
  panels (each renders fetched data; a failed fetch renders the error
  message, not a blank/broken screen); `App.jsx`'s top-level state machine
  (each `/auth/me` response shape routes to the expected screen).

## Build and deployment

`client/package.json` gains a `build` script (`vite build`) producing
`client/dist/`. `src/http/server.js`, only when `config.isProduction`, adds
`express.static(path.join(..., 'client/dist'))` plus an SPA-shell fallback
that serves `client/dist/index.html` for unmatched `GET` requests (so a
direct URL load or a page refresh on any screen works, even without a
client-side router doing real routing). Ordering matters: both are mounted
**before** the existing `/auth` and `/api/*` routers so real API calls are
never affected, and the SPA fallback itself is mounted **after** them but
**before** the existing catch-all JSON `404` handler from sub-project 2 —
so an unmatched `/api/...` or `/auth/...` path still gets the JSON 404 it
already gets today, while every other unmatched `GET` gets the SPA shell.
In development, `client/` runs its own Vite dev server on a separate port,
talking to the backend via `CORS_ORIGIN` (already added in sub-project 2).

## Explicitly out of scope for this sub-project

- Voice channel UI (no CALL tab) — deferred with sub-project 4.
- A dedicated `/api/stats` endpoint — counts are derived client-side from
  already-fetched lists.
- Per-tenant roles in the UI — matches sub-project 2's "every tenant user
  has equal access" decision; no permission-based UI differences.
- Editing/deleting contacts or campaigns — only create + list, matching
  what the sub-project 2 API actually exposes (`GET`/`POST` only).
- Real-time push (websockets/SSE) — polling only, matching autoNotify's
  precedent and this system's already-polling-based architecture throughout.
