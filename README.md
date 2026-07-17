# SMS Dispatch MVP

A multi-tenant SMS + campaigns platform. One running service serves many client
businesses (tenants), isolated from each other, through two independent send
paths that share one tenant fleet and one SMS layer:

1. **The reactive sheet engine** — watches each tenant's Google Sheet of
   delivery orders and texts the customer when a row's **Status** enters a
   notifiable value, using that tenant's own sender ID and templates, then
   marks the row so it isn't re-sent. The Sheet remains the sole source of
   truth for order data. See [`SMS_Dispatch_MVP_Build_Spec.md`](SMS_Dispatch_MVP_Build_Spec.md)
   for this engine's full original specification.
2. **A manual/scheduled campaign engine** — send a message to saved contacts
   (all, or one), on demand or at a scheduled time, from the dashboard.

Everything else — tenant configuration, contacts, campaigns, users/sessions —
lives in SQLite, created automatically on first run. A full HTTP API and a
React dashboard sit on top: tenant users log in and see their own
contacts/campaigns/orders; a superadmin sees a fleet-wide console (tenant
list, per-tenant user management, tenant onboarding).

Each numbered sub-project past the original single-purpose MVP has its own
design spec + implementation plan under
[`docs/superpowers/`](docs/superpowers/) — check there for the reasoning
behind any behavior that seems undocumented here.

## How it works

**Sheet engine** — every `POLL_INTERVAL_SECONDS`, for each **active** tenant
(in isolation): reads the orders sheet, maps columns **by header name**, and
for each row decides whether to notify: `status ∈ notifyStatuses` **and**
`status != lastNotifiedStatus` (compared canonically — trimmed + lower-cased)
**and** the phone is a valid number. It builds the message from the tenant's
template, sends it, and **writes the result back to that row immediately**
(so a crash re-sends at most one message). Failures are handled per row:
**transient** errors (network/timeout/429/5xx) retry next tick; **permanent**
errors (invalid recipient/sender) give up by marking the row (and resume only
when `Status` changes).

**Campaign engine** — every `CAMPAIGN_TICK_INTERVAL_MS`, sends any due
campaign (created via the dashboard) to its target contacts one at a time,
writing each recipient's outcome back immediately, with the same
transient/permanent handling and a bulk-edit cap as the sheet engine. Fully
separate tick and dependency set — nothing here touches the sheet engine.

> **Guarantee (both engines):** exactly-once under normal operation;
> at-least-once only if the process crashes between sending and marking the
> row/recipient. A gateway "success" means the message was *accepted*, not
> confirmed *delivered* (delivery reports are out of scope).

## Requirements

- Node.js **v20+** (uses native `fetch` and ESM).
- A Google Cloud **service account** with the Google Sheets API enabled
  (shared, used by every tenant's sheet).
- Per tenant, an account with **Termii**, **Africa's Talking**, or **Twilio**
  and a registered sender ID — chosen and configured per-tenant via the
  dashboard, not globally.

## Setup

```bash
npm ci
cp .env.example .env                       # fill in Google credentials, leave the rest at their defaults for a local demo
```

**Google (once):** create a project, enable the Sheets API, create a service
account, download its JSON key, and put the email + private key into `.env`
(keep the downloaded JSON **outside** the repo). The `\n` sequences in
`GOOGLE_PRIVATE_KEY` are un-escaped automatically at load.

**Database:** nothing to do — `DB_PATH` (default `data/platform.db`) is
created automatically on first run, schema included.

**First superadmin (once):** there's no self-service signup, and the
dashboard's user management screens themselves require an existing
superadmin to use — bootstrap the very first one from the CLI:

```bash
node scripts/create-user.mjs --email=admin@example.com --superadmin
```

This prints a one-time temporary password to share with that person
out-of-band; they'll be forced to change it on first login.

**Per tenant:** log in as a superadmin and use the dashboard to add the
tenant (sheet ID, sender ID, notify statuses/templates, SMS provider +
credentials), then create that tenant's users. Practical notes:

1. Register the client's sender ID and the transactional/DND route with
   their chosen SMS provider — this is approved by mobile operators and
   takes **~2–3 weeks**. Keep the tenant inactive until it's approved.
2. Have the client share their Google Sheet with the service-account email
   (Editor), not "anyone with the link". Format the **Phone** and **Amount**
   columns as **Plain text** (a leading `'+` on a phone cell avoids Sheets
   parsing it as a formula).

## Running

```bash
npm start          # backend: node src/index.js -- sheet engine + campaign scheduler + HTTP API
```

For a zero-cost demo, in `.env` set:

```env
NODE_ENV=development
DRY_RUN=true                 # log instead of sending (rows/recipients are still marked)
# or, to see a real SMS arrive on your own phone via trial credit / sandbox:
GLOBAL_TEST_NUMBER=+234...   # honored ONLY when NODE_ENV != production
```

**Dashboard (separate dev server):**

```bash
cd client && npm ci
cp .env.example .env.development   # NOT plain .env -- Vite loads that in every mode, including production builds
npm run dev                        # http://localhost:5173
```

Set `CORS_ORIGIN=http://localhost:5173` in the backend's `.env` so the
dashboard's cross-origin requests are allowed. In production
(`NODE_ENV=production`), run `npm run build` in `client/` and the backend
serves the built dashboard itself from the same origin — no separate dev
server or `CORS_ORIGIN` needed.

In production run **exactly one instance** under a supervisor with
restart-on-crash (systemd `Restart=always`, PM2, or a container restart
policy); the single-flight guards only prevent overlap within one process,
per loop (sheet engine and campaign scheduler each have their own).

## Testing

```bash
npm test                 # backend: vitest run (all suites, no network)
cd client && npm test     # dashboard: vitest run (jsdom + React Testing Library)
```

Backend coverage: phone normalisation, message templating, config validation,
registry validation + last-known-good fallback, the SMS adapters (mocked
fetch), header-mapped sheet parsing/write-back, the full sheet-engine and
campaign-scheduler loops (multi-tenant isolation, idempotency,
transient/permanent handling, bulk-edit cap, DRY_RUN, single-flight), the
HTTP API routes, and auth/sessions. All with mocks/an in-memory DB — no
network, no real Google Sheets calls.

## Orders sheet format

Row 1 is a header row (mapped by name, case-insensitive). Dispatcher-owned:
`Order ID`, `Customer Name` (optional), `Phone`, `Amount` (optional), `Status`.
Service-owned (written back): `Last Notified Status`, `Notified At`, `Last Error`.

Templates use `{name}`, `{orderId}`, `{amount}` and optional `[[ ... ]]` clauses
that drop when a referenced placeholder is empty (e.g. omit the amount line when
`Amount` is blank). Keep messages plain ASCII — use `NGN`, not `₦`.

## Configuration reference

Backend `.env` (see `.env.example` for the authoritative, commented list).
SMS provider credentials are **not** here — each tenant's are entered via the
dashboard and stored in SQLite.

| Env var | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | `production` disables `GLOBAL_TEST_NUMBER`. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` | — | Shared service-account auth for Sheets access. |
| `DEFAULT_COUNTRY_CODE` | `234` | Fallback for phone normalisation; a tenant's own `defaultCountryCode` overrides it. |
| `POLL_INTERVAL_SECONDS` | `60` | Sheet-engine poll cadence. |
| `SEND_DELAY_MS` | `400` | Delay between sends. |
| `HTTP_TIMEOUT_MS` | `15000` | Per external request (SMS + Sheets). |
| `MAX_SENDS_PER_TENANT_PER_TICK` | `50` | Sheet-engine bulk-edit guardrail. |
| `DB_PATH` | `data/platform.db` | SQLite file; created automatically. |
| `CAMPAIGN_TICK_INTERVAL_MS` | `10000` | Campaign-scheduler tick cadence. |
| `MAX_CAMPAIGN_RECIPIENTS_PER_TICK` | `50` | Campaign-scheduler bulk-edit guardrail. |
| `HTTP_PORT` | `3000` | The HTTP API / dashboard server port. |
| `SESSION_TTL_HOURS` | `168` | Login cookie lifetime (7 days), fixed from creation, not sliding. |
| `CORS_ORIGIN` | — | The dashboard's origin in local dev (e.g. `http://localhost:5173`); empty disables CORS. |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MINUTES` | `10` / `15` | Failed login attempts allowed per email within this window before 429s kick in. |
| `DRY_RUN` | `false` | Log instead of sending (both engines). |
| `GLOBAL_TEST_NUMBER` | — | Redirect all messages, all tenants (non-production only); overrides a tenant's own `testNumber`. |

## Project structure

```text
src/
  index.js            entry point: config -> wiring -> both ticks + HTTP server
  config.js           env parsing + validation
  db.js               SQLite connection + schema bootstrap
  tenants.js           tenant registry: load/validate/CRUD, last-known-good
  auth.js              password hashes, sessions, user CRUD
  contacts.js          per-tenant contacts store
  campaigns.js         per-tenant campaigns + recipients store
  logger.js            tenant-tagged logging + phone redaction
  sheets.js            header-mapped read + per-row cell write-back
  phone.js             normalisePhone + validation
  message.js           buildMessage (templates, optional clauses, amount)
  processor.js         the sheet-engine tick
  campaignScheduler.js the campaign-engine tick
  sms/
    index.js            per-tenant provider selector (unified sendSms contract)
    termii.js           Termii adapter
    africasTalking.js   Africa's Talking adapter
    twilio.js           Twilio adapter
    httpClient.js       fetch with timeout
  http/
    server.js           Express app factory
    routes/             auth, contacts, campaigns, orders, status, tenants, users
    middleware/         requireAuth, requireSuperadmin
client/                 React dashboard (separate npm project, own package.json)
  src/screens/          login, change-password, dashboard, tenant/user management
  src/components/       contacts, campaigns, orders, confirm dialogs, etc.
test/                   vitest suites mirroring src/ one-to-one
docs/superpowers/       per-sub-project specs + implementation plans
```

## Known limitations (by design)

- **Accepted ≠ delivered** — no delivery-report reconciliation.
- **One process only** — no horizontal scaling / leader election.
- **Operator watches logs** — no metrics server or alerting.
- **No usage/billing store** — per-send log lines are the only audit trail.
- **Sender-ID registration is slow** — a new tenant is not live "on the next poll".
- **No self-service signup** — users are admin-provisioned (CLI or dashboard) with a one-time temporary password, not email invites.
