# SMS Dispatch MVP

A small, multi-tenant backend service that watches each client's Google Sheet of
delivery orders and sends the customer an SMS (via a Nigerian gateway) when an
order's **Status** changes to a notifiable value — using that tenant's own sender
ID and templates, then marking the row so the same notification is not sent again.

One running service serves many client businesses (tenants), isolated from each
other. No UI, no inbound handling, no database — the sheet plus a JSON registry
are the only state. See [`SMS_Dispatch_MVP_Build_Spec.md`](SMS_Dispatch_MVP_Build_Spec.md)
for the full specification.

## How it works

Every `POLL_INTERVAL_SECONDS` the service:

1. Re-reads the tenant registry (`tenants.json`); on a bad/half-saved file it keeps
   the last-known-good set instead of zeroing the fleet.
2. For each **active** tenant (in isolation), reads the orders sheet, maps columns
   **by header name**, and for each row decides whether to notify:
   `status ∈ notifyStatuses` **and** `status != lastNotifiedStatus` (compared
   canonically — trimmed + lower-cased) **and** the phone is a valid number.
3. Builds the message from the tenant's template, sends it, and **writes the
   result back to that row immediately** (so a crash re-sends at most one message).
4. Logs an operator-facing per-tenant summary.

Failures are handled per row: **transient** errors (network/timeout/429/5xx) retry
next tick; **permanent** errors (invalid recipient/sender) give up by marking the
status (and resume only when `Status` changes).

> **Guarantee:** exactly-once under normal operation; at-least-once only if the
> process crashes between sending and marking the row. A gateway "success" means
> the message was *accepted*, not confirmed *delivered* (delivery reports are out
> of scope for v1).

## Requirements

- Node.js **v20+** (uses native `fetch` and ESM).
- A Google Cloud **service account** with the Google Sheets API enabled.
- A **Termii** or **Africa's Talking** account with a registered sender ID per tenant.

## Setup

```bash
npm ci
cp .env.example .env                       # fill in secrets
cp tenants.example.json tenants.json       # fill in real sheetIds / sender IDs
```

**Google (once):** create a project, enable the Sheets API, create a service
account, download its JSON key, and put the email + private key into `.env`
(keep the downloaded JSON **outside** the repo). The `\n` sequences in
`GOOGLE_PRIVATE_KEY` are un-escaped automatically at load.

**SMS provider (once):** put the API key in `.env`. For Termii, copy your
account **base URL** from `app.termii.com` into `TERMII_BASE_URL` and ask support
to activate the DND/transactional route.

**Per tenant:**

1. Register the client's sender ID and the transactional/DND route with the
   provider — this is approved by the mobile operators and takes **~2–3 weeks**.
   Keep the tenant `active: false` until it is approved.
2. Have the client share their Google Sheet with the service-account email
   (Editor), not "anyone with the link". Format the **Phone** and **Amount**
   columns as **Plain text**.
3. Add the tenant to `tenants.json`; flip `active: true` once the sender ID is live.

## Running

```bash
npm start          # node src/index.js
```

For a zero-cost demo, in `.env` set:

```
NODE_ENV=development
DRY_RUN=true                 # log instead of sending (rows are still marked)
# or, to see a real SMS arrive on your own phone via trial credit / sandbox:
GLOBAL_TEST_NUMBER=+234...   # honored ONLY when NODE_ENV != production
```

In production run **exactly one instance** under a supervisor with
restart-on-crash (systemd `Restart=always`, PM2, or a container restart policy);
the single-flight guard only prevents overlap within one process.

## Testing

```bash
npm test           # vitest run
```

Covers phone normalisation, message templating, config validation, registry
validation + last-known-good fallback, the SMS adapters (mocked fetch), the
header-mapped sheet parsing/write-back, and the full processor loop (multi-tenant
isolation, idempotency, transient/permanent handling, bulk-edit cap, DRY_RUN,
single-flight) — all with mocks, no network.

## Orders sheet format

Row 1 is a header row (mapped by name, case-insensitive). Dispatcher-owned:
`Order ID`, `Customer Name` (optional), `Phone`, `Amount` (optional), `Status`.
Service-owned (written back): `Last Notified Status`, `Notified At`, `Last Error`.

Templates use `{name}`, `{orderId}`, `{amount}` and optional `[[ ... ]]` clauses
that drop when a referenced placeholder is empty (e.g. omit the amount line when
`Amount` is blank). Keep messages plain ASCII — use `NGN`, not `₦`.

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `production` | `production` disables `GLOBAL_TEST_NUMBER`. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` | — | Service-account auth. |
| `SMS_PROVIDER` | `termii` | `termii` or `africastalking`. |
| `TERMII_API_KEY` / `TERMII_BASE_URL` | — | Required for Termii. |
| `AT_API_KEY` / `AT_USERNAME` | — | Required for Africa's Talking. |
| `DEFAULT_COUNTRY_CODE` | `234` | For phone normalisation. |
| `POLL_INTERVAL_SECONDS` | `60` | Poll cadence. |
| `SEND_DELAY_MS` | `400` | Delay between sends. |
| `HTTP_TIMEOUT_MS` | `15000` | Per external request. |
| `MAX_SENDS_PER_TENANT_PER_TICK` | `50` | Bulk-edit guardrail. |
| `DRY_RUN` | `false` | Log instead of sending. |
| `GLOBAL_TEST_NUMBER` | — | Redirect all messages (non-production only). |

## Project structure

```
src/
  index.js        entry point: config -> wiring -> scheduler
  config.js       env parsing + provider-conditional validation
  tenants.js      registry load/validate, canonical maps, last-known-good
  logger.js       tenant-tagged logging + phone redaction
  sheets.js       header-mapped read + per-row cell write-back
  phone.js        normalisePhone + validation
  message.js      buildMessage (templates, optional clauses, amount)
  processor.js    the single-flight core loop
  sms/
    index.js          provider selector (unified sendSms contract)
    termii.js         Termii adapter
    africasTalking.js Africa's Talking adapter
    httpClient.js     fetch with timeout
test/             vitest suites mirroring the modules above
```

## Known limitations (v1, by design)

- **Accepted ≠ delivered** — no delivery-report reconciliation.
- **One process only** — no horizontal scaling / leader election.
- **Operator watches logs** — no metrics server or alerting.
- **No usage/billing store** — per-send log lines are the only audit trail.
- **Sender-ID registration is slow** — a new tenant is not live "on the next poll".
