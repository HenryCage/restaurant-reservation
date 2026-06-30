# Build Specification — SMS Dispatch MVP (Google Sheets → SMS, multi-tenant)

**Purpose of this document:** a complete, implementation-ready specification to hand to a developer or an AI coding assistant (e.g. GitHub Copilot) so it can scaffold and write all the necessary code. It defines the goal, architecture, data model, configuration, core logic, module structure, external API contracts, edge cases, and acceptance criteria. It intentionally does *not* contain the full implementation — that is the coding task — but it is precise enough to generate it.

**v1 includes multi-tenancy:** one running service serves many client businesses, each with its own orders sheet, sender ID, and message templates.

**v1 stays deliberately minimal.** Everything below is scoped to a *small, robust* MVP. The rules added for correctness, safety, and cost (idempotency, guardrails, validation, logging) are **robustness requirements, not new features** — they exist so the first version is solid, not so it grows. There is still no UI, no database, no inbound handling, no delivery-report webhooks, no metrics server (see §13). Prefer the simplest implementation that satisfies each rule.

---

## 1. Goal (what this MVP does)

A small backend service that, for **each client business (tenant)**, watches that client's Google Sheet of delivery orders. When an order's **Status** changes to a notifiable value (e.g. `Out for delivery`), the service automatically sends the customer an **SMS** through a local Nigerian SMS gateway — using **that tenant's own sender ID and message templates** — then marks the row so the same notification is not sent again.

One status change → one message, isolated per tenant. No UI, no inbound handling, no WhatsApp in v1 (see §12 Out of scope).

> **Honest guarantee:** under normal operation each notifiable status change sends **exactly one** SMS. Because a network send and a sheet write cannot be committed atomically, the true guarantee is **"exactly once normally; at-least-once if the process crashes in the small window between sending and marking the row."** The design minimises that window (§7) and never resends for an *unchanged* status. We accept the rare duplicate rather than build delivery-state infrastructure in v1.

Example: tenant *Swift Logistics* has a dispatcher who changes order `#1234` (customer Chidi, +234 80…) from `Pending` to `Out for delivery`. Within ~1 minute, Chidi receives, from sender ID `SwiftLog`:

> "Hi Chidi, your order #1234 is out for delivery. Please have NGN 15,000 ready (cash or transfer). Thank you — Swift Logistics."

Meanwhile tenant *Lagos Couriers* is processed independently in the same cycle, using its own sheet, sender ID, and wording.

---

## 2. Operating model (why multi-tenant matters)

This is delivered as a **managed service**: the operator (you) runs and maintains one service for all clients. Clients never touch the code, server, API keys, or sender-ID registration — they only use a shared Google Sheet as their working surface and pay a monthly fee. Multi-tenancy is therefore core, not optional: it lets one deployment serve many paying clients without a separate copy per client.

**Shared infrastructure (operator-owned, one of each):**
- One Google Cloud **service account** (each tenant shares their sheet with its email).
- One **SMS gateway account** (Termii or Africa's Talking); each tenant gets its **own registered sender ID** under that single account.

**Per-tenant (isolated):** orders sheet, sender ID, templates, notifiable statuses, active flag.

**Trust & responsibility boundaries (important for v1):**

- The **operator fully controls `tenants.json`** and is trusted not to cross-wire sender IDs between tenants. Because all tenants share one gateway account, the gateway cannot tell tenants apart — sender-ID ownership is enforced only by operator discipline plus the validation in §5.1. Keep `tenants.json` access-controlled (not world-writable, code-reviewed on change).
- **Sender-ID registration is slow and is a prerequisite, not a quick step.** A Nigerian alphanumeric sender ID must be approved by the mobile operators (MTN, Glo, Airtel, 9mobile) — the gateway submits the request on your behalf; the **NCC sets policy but does not approve individual IDs**. Approval for *transactional / DND-routed* traffic typically takes **~2–3 weeks** and requires KYC (e.g. CAC registration, an authorisation letter). **A new tenant is therefore NOT live "on the next poll": keep `active: false` until its sender ID is approved.** (§17.)

---

## 3. Tech stack

- **Runtime:** Node.js (v20+ LTS). TypeScript recommended; plain JavaScript acceptable.
- **Google Sheets access:** official `googleapis` npm package, authenticated with a **Google Cloud service account** (read + write).
- **HTTP:** native `fetch` (Node 20+) preferred (one fewer dependency); `axios` acceptable. Always set a request timeout.
- **Scheduling:** `node-cron` (or `setInterval`).
- **Config:** `dotenv` for shared secrets; a JSON tenant registry for per-tenant config.
- **Logging:** `pino` or `console` (MVP can use `console`), with each log line tagged by tenant id. Logs are the **operator's primary signal** (§7, §13) — they must be visible to the operator, not only written into client sheets.
- **Testing:** `vitest` or `jest`.
- **Dependencies:** commit `package-lock.json`; use `npm ci` (not `npm install`) for reproducible installs.

The same logic can alternatively be built as an n8n workflow (no-code); this spec targets the code path because full control, multi-tenancy, and easy extension were requested.

---

## 4. Architecture

```
                tenant registry (tenants.json)
                          │  (re-read each poll; last-known-good on parse error)
                          ▼
  single-flight tick (skip if previous tick still running):
   for each ACTIVE tenant:
    Tenant's Google Sheet ──read──▶ Polling service ──HTTP POST (tenant sender ID)──▶ SMS gateway ──▶ Customer
            ▲                          │
            └──write back per row──────┘   (mark F/G/H immediately after each send)
```

- **Tenant registry (swappable):** a `tenants.json` file in v1, re-read on each poll so tenants can be added/disabled without restarting or redeploying. On a JSON parse / read error the loader **keeps the last-known-good registry in memory and logs**, rather than processing zero tenants. Designed behind a small loader interface so it can later be replaced by a database or a control sheet.
- **Data source:** Google Sheets in v1, behind a `sheets.js` module boundary so it is mockable for tests. (We do **not** over-generalise this into an "any data source" interface in v1 — it is shaped for Sheets and will be refactored if a second source ever appears.)
- **Channel adapter (swappable):** SMS in v1 (Termii or Africa's Talking), behind a single `sendSms(to, message, options)` interface so a WhatsApp adapter can be added later.
- **Core processor:** for each active tenant, read rows, decide, send, mark — **per-row write-back immediately after each successful send** so a crash mid-tick cannot turn one tenant's many sends into many duplicates. State for de-duplication lives in the sheet, so the process holds no durable state between ticks. Isolated so one tenant's failure never affects another.
- **Single-flight:** the scheduler must **not** start a new tick while the previous one is still running (a `running` flag / mutex — `node-cron`/`setInterval` do **not** do this for you). This prevents overlapping ticks from double-sending the same unmarked rows.

This "thin core + swappable adapters" design is deliberate so the same engine can later serve more tenants, channels, or verticals by changing config/adapters — but v1 implements only what §13 keeps in scope.

---

## 5. Data model

### 5.1 Tenant registry — `tenants.json`

```json
{
  "tenants": [
    {
      "id": "swift-logistics",
      "name": "Swift Logistics",
      "active": true,
      "sheetId": "1AbCdEf_spreadsheet_id_from_url",
      "sheetName": "Orders",
      "senderId": "SwiftLog",
      "channel": "dnd",
      "notifyStatuses": ["Out for delivery"],
      "templates": {
        "Out for delivery": "Hi {name}, your order #{orderId} is out for delivery.[[ Please have NGN {amount} ready (cash or transfer).]] Thank you - Swift Logistics."
      },
      "testNumber": ""
    },
    {
      "id": "lagos-couriers",
      "name": "Lagos Couriers",
      "active": true,
      "sheetId": "1XyZ_another_spreadsheet_id",
      "sheetName": "Orders",
      "senderId": "LagosCour",
      "channel": "dnd",
      "notifyStatuses": ["Out for delivery", "Delivered"],
      "templates": {
        "Out for delivery": "Hello {name}, order #{orderId} is on the way.[[ Have NGN {amount} ready.]] - Lagos Couriers",
        "Delivered": "Order #{orderId} delivered. Thank you for choosing Lagos Couriers!"
      },
      "testNumber": ""
    }
  ]
}
```

Rules & validation (tenant is **skipped and logged**, not crashed, if it fails any of these — see §14):

- `active: false` → the tenant is skipped (easy pause/offboard, and the default state until the sender ID is approved per §2).
- `id` must be present and **unique** across tenants.
- `senderId` is the tenant's own registered sender ID (under the shared gateway account). Must be **alphanumeric, 3–11 characters, no spaces/symbols** (Termii/AT limit). Reject anything else. The same `senderId` must not appear under two different tenant ids (guards against accidental cross-tenant impersonation, §2).
- `notifyStatuses` is non-empty, and **`templates` must contain a key for every value in `notifyStatuses`**.
- `channel` is **provider-specific** (Termii only; see §9). The Africa's Talking adapter ignores it. It is advisory, not portable.
- `testNumber` (optional) redirects that tenant's messages to one number during its pilot.
- **No secrets in this file.** Gateway API keys live in env (§6). If a tenant ever needs its *own* gateway account, store the secret in env under a per-tenant variable name and reference the variable name here (not the secret itself).

### 5.2 Each tenant's orders sheet

One tab (default `Orders`). **Row 1 is a header row and is authoritative.**

**Column mapping is by header name, not by fixed position.** The service reads row 1, builds a `headerName → columnIndex` map, and resolves every field by name. This is mandatory: clients own and edit their sheets, so a dispatcher inserting/reordering a column must **not** cause the service to read the wrong field or write markers into the wrong cells. Header matching is **case-insensitive and trimmed**. If any *required* header is missing or duplicated, the tenant is **skipped and logged** (§14).

| Header (required?) | Meaning | Written by |
|---|---|---|
| `Order ID` (required) | Unique order reference (e.g. `1234`) | Dispatcher |
| `Customer Name` (optional) | For personalisation | Dispatcher |
| `Phone` (required) | Customer phone, any common Nigerian format | Dispatcher |
| `Amount` (optional) | Amount due on delivery, plain number (e.g. `15000`) | Dispatcher |
| `Status` (required) | Order status — **data-validation dropdown** | Dispatcher |
| `Last Notified Status` (required) | Status the service has *finished* processing — set on a successful send **or** when a non-retryable (permanent) send is given up | **Service** |
| `Notified At` (required) | UTC ISO-8601 timestamp of the last **successful** send (left unchanged on failure) | **Service** |
| `Last Error` (required) | Error text if the last send failed (else empty) | **Service** |

**Reading values:** format the **`Phone` and `Amount` columns as *Plain text*** in each tenant sheet (part of onboarding, §17) and read with `valueRenderOption=FORMATTED_VALUE`, treating every value as a **string**. This is deliberate: a single render option cannot be optimal for both fields — Phone must keep its leading `0`/exact digits (reading it as a number gives `8012345678` or `8.01e9` and corrupts the destination), while Amount must not pick up display formatting (`15,000.00`). Plain-text columns + `FORMATTED_VALUE` gives the raw typed string for both, which `normalisePhone` (§10) and the amount parser (§8) then handle. Rows can be **ragged** (the values API omits trailing empty cells), so pad missing trailing columns to empty strings before parsing. **Skip rows where `Order ID`, `Phone`, or `Status` is empty.**

**Status dropdown values:** `Pending`, `Out for delivery`, `Delivered`, `Failed` (configurable per tenant via `notifyStatuses`).

**Status comparison is canonical:** compare `Status` against `notifyStatuses` and against `Last Notified Status` after **trimming whitespace and lower-casing both sides**. Crucially, the value the service **writes** into `Last Notified Status` must be the **same canonical form** it compares, so `Status` and `Last Notified Status` round-trip identically. (Otherwise a trailing space makes `status !== lastNotifiedStatus` true forever and the same message resends every tick.)

**Why `Last Notified Status` (not a boolean):** makes the service idempotent *per status*, so each distinct status change notifies once and re-running never resends.

---

## 6. Configuration — shared `.env`

Per-tenant settings live in `tenants.json`; only shared infrastructure and secrets live here.

```
# --- Runtime mode ---
NODE_ENV=production            # 'production' disables the global test override below

# --- Google (shared service account; must have access to every tenant sheet) ---
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
# Note: the literal \n sequences MUST be un-escaped to real newlines at load
# (e.g. key.replace(/\\n/g, '\n')) or Google auth fails cryptically.

# --- SMS provider (shared account; per-tenant sender IDs come from tenants.json) ---
SMS_PROVIDER=termii            # termii | africastalking
DEFAULT_COUNTRY_CODE=234
TERMII_API_KEY=
TERMII_BASE_URL=               # account-specific base URL from app.termii.com (see §9.1); do NOT hard-code
AT_API_KEY=
AT_USERNAME=sandbox            # 'sandbox' for testing, real username in production

# --- Behaviour ---
TENANTS_FILE=./tenants.json
POLL_INTERVAL_SECONDS=60
SEND_DELAY_MS=400              # delay between sends to avoid rate limits
HTTP_TIMEOUT_MS=15000          # per request (SMS + Sheets); a hang must not stall the tick

# --- Safety guardrails ---
MAX_SENDS_PER_TENANT_PER_TICK=50   # if a tenant has more eligible rows in one tick, send up to this many,
                                   # log a LOUD warning (likely a bulk paste / fat-finger), process the rest next tick

# --- Demo / safety ---
DRY_RUN=false                  # true = log the SMS instead of calling the gateway (still marks the row; see §7)
GLOBAL_TEST_NUMBER=            # if set, ALL messages (all tenants) go here; HONORED ONLY when NODE_ENV != production,
                              # logs a loud warning every tick while active; overrides per-tenant
```

**Provider-conditional validation (fail fast on startup):** if `SMS_PROVIDER=termii`, require `TERMII_API_KEY` and `TERMII_BASE_URL`. If `SMS_PROVIDER=africastalking`, require `AT_API_KEY` and `AT_USERNAME`. Always require the Google vars. Log a one-line **effective-mode banner** on startup (provider, sandbox vs live, `DRY_RUN` state, whether a global/test override is active) so an unsafe configuration is obvious.

> **Cost backstop:** `MAX_SENDS_PER_TENANT_PER_TICK` plus giving up on permanent failures (§7/§9) bound runaway sends in software, but the **hard** financial cap is the gateway account itself — keep it on a modest prepaid balance and watch it. SMS is real money on a shared, operator-funded account.

---

## 7. Core algorithm (the processor)

Runs on every poll tick. **Single-flight:** if the previous tick is still running, skip this tick and log it (do not run two in parallel).

1. **Load the tenant registry** from `TENANTS_FILE` (re-read each tick). On parse/read error, **log and keep the previous in-memory registry** (never process zero tenants because of a half-saved file).
2. **For each tenant where `active === true`**, in isolation (wrap the whole tenant in try/catch so one tenant's failure never stops the others):
   1. Read all data rows from the tenant's `sheetId` / `sheetName`. Read row 1 and build the **header→column map** (§5.2); if a required header is missing/duplicated, skip-and-log this tenant. Read values as strings.
   2. For each data row, parse `{ rowNumber, orderId, name, phone, amount, status, lastNotifiedStatus }`. `rowNumber` is the absolute 1-based sheet row, captured at read time. Skip rows with empty `Order ID` / `Phone` / `Status`.
   3. **Decide** if the row needs a message (using canonical, trimmed, lower-cased status comparison, §5.2):
      - `status` is in `tenant.notifyStatuses`, **and**
      - `status !== lastNotifiedStatus`, **and**
      - `phone` normalises to a valid number (§10).

      (A row that previously hit a *permanent* failure already has `lastNotifiedStatus === status`, so it is naturally skipped here until the dispatcher changes `Status` — no separate "parked" flag is needed.)
   4. Collect the eligible rows. If their count **exceeds `MAX_SENDS_PER_TENANT_PER_TICK`**, log a loud warning (probable bulk edit) and process only the first `MAX_SENDS_PER_TENANT_PER_TICK` this tick; the rest are handled on subsequent ticks.
   5. For each eligible row (up to the cap):
      - Build the message from `tenant.templates[status]` (§8).
      - Recipient = `GLOBAL_TEST_NUMBER` if set **and** `NODE_ENV !== 'production'`, else `tenant.testNumber` if set, else the normalised customer phone.
      - If `DRY_RUN` → log the message + **masked** recipient + tenant id, and **treat as a successful send** (proceed to the success write-back below). *DRY_RUN still marks the row,* so it exercises the real idempotency path; to re-test a real send afterwards, clear that row's `Last Notified Status`.
      - Else call `sendSms(recipient, message, { senderId: tenant.senderId, channel: tenant.channel })`, wrapped in its own try/catch so a thrown error becomes `{ ok: false, error, permanent: false }` (a network throw must not abort the tenant or skip later write-backs; a thrown error is treated as transient).
      - **On success:** **immediately write back this row's** `Last Notified Status = canonical status`, `Notified At = now (UTC ISO-8601)`, `Last Error = ""`. Log the `providerMessageId` (operator audit trail; see §9 on "accepted ≠ delivered").
      - **On transient failure** (`permanent !== true` — network/timeout/429/5xx): **immediately write back** `Last Error = error text` and **leave `Last Notified Status` unchanged**, so it auto-retries next tick (self-heals when the gateway recovers). Do **not** touch `Notified At`.
      - **On permanent failure** (`permanent === true` — e.g. invalid recipient, rejected/blacklisted sender ID): **immediately write back** `Last Error = error text` **and** `Last Notified Status = canonical status` — we give up on this status so it does not retry forever or burn paid rejects. It is reattempted only when the dispatcher changes `Status`. Do **not** set `Notified At` (nothing was delivered).
      - Wait `SEND_DELAY_MS`.
3. Sleep until the next tick.

**Why per-row write-back (not one batch at the end):** it shrinks the send→mark window to a single row, so a crash, timeout, or write failure can at most re-send **one** message next tick instead of every message that tenant already sent this tick. Write **only** the service-owned cells (`Last Notified Status`, `Notified At`, `Last Error`) by their mapped columns for `rowNumber` — never row-level writes that could clobber dispatcher edits.

**Operator visibility (the failure surface):** every error (send failure, sheet read/write failure, skipped tenant, invalid phone, permanent give-up, cap-hit warning) is **logged to the operator's log/stdout**, tagged with tenant id — not only written into the client's `Last Error` cell, which the operator never sees. At the end of each tick, log a one-line summary per tenant: rows scanned, sent ok, transient-failed, permanently-failed. This is the v1 monitoring story (no metrics server; see §13).

Self-healing and isolated: a transient gateway error, a half-saved registry, or one broken tenant gets handled next tick without affecting other tenants.

---

## 8. Message templates

Per-tenant `status → template` map (in `tenants.json`), with placeholders `{name}`, `{orderId}`, `{amount}`.

Templating rules:

- Replace `{name}`, `{orderId}`, `{amount}` from the row.
- **Optional clauses:** text wrapped in `[[ ... ]]` is **dropped entirely if any placeholder inside it is empty**, otherwise the `[[`/`]]` markers are removed and the inner text is kept. This is how "if amount is empty, omit the amount clause" works concretely — e.g. `[[ Please have NGN {amount} ready.]]` disappears when `Amount` is blank, instead of leaving "Please have NGN  ready."
- Format `amount`: parse the numeric value — remove spaces and thousands separators, and if a decimal part is present keep only the **whole-naira integer part** (drop kobo) — then group with thousands separators (e.g. `15000` → `15,000`, `15,000.00` → `15,000`). Do **not** naively strip all non-digits (that would turn `15,000.00` into `1500000`). If `amount` is empty or non-numeric, treat it as empty (which drops its optional clause).
- **There is no `{date}` placeholder in v1.** Avoid time-relative words that go stale on a next-day retry, or accept them as fixed copy. `Notified At` is stored in **UTC** (`toISOString()`); document that it is UTC since dispatchers reading the sheet will assume local time (Nigeria is WAT, UTC+1).
- **Sanitise inputs before substitution:** values come from a sheet anyone with edit access can change. Strip control characters and newlines, and cap each field's length (e.g. name ≤ 40 chars). This keeps a malicious/garbled "Customer Name" from injecting links into a trusted transactional SMS or blowing up message length/cost.
- See §10 on the naira sign and message length.

---

## 9. SMS gateway adapters (the channel adapter)

One interface, two implementations, selected by `SMS_PROVIDER`. The per-tenant sender ID and channel are passed in `options`:

```js
// sms/index.js
// returns { ok: boolean, providerMessageId?: string, error?: string, permanent?: boolean }
async function sendSms(toE164, message, { senderId, channel }) { ... }
```

**Adapter rules for both providers:** use HTTPS with certificate validation **on** (never disable TLS verification); apply `HTTP_TIMEOUT_MS`; on error, **redact the api_key and recipient number** before logging; parse the provider response defensively (do not log raw bodies that may echo secrets/PII).

**Error classification (`permanent`):** each adapter must set `permanent` on a failure so the processor (§7) knows whether to retry. Treat as **transient** (`permanent: false`, retry): network errors, timeouts, HTTP `429`, and `5xx`. Treat as **permanent** (`permanent: true`, give up): well-formed requests the provider rejects for a reason a retry won't fix — invalid/blacklisted recipient, invalid/rejected sender ID, insufficient permissions/route not enabled. When unsure, default to **transient** (retrying is safer than silently dropping a notification).

> **Important — "accepted ≠ delivered" (known v1 limitation):** a success from either provider means the gateway **accepted/queued** the message, **not** that the carrier delivered it to the handset. Final delivery in Nigeria (especially to DND numbers and on 9mobile) is reported asynchronously and some messages silently fail. v1 treats gateway acceptance as success and **logs the `providerMessageId`** so deliverability can be audited manually later. Delivery-report (DLR) reconciliation is explicitly out of scope (§13).

>
> **Confirm against current docs:** endpoints and field names change. The implementer **must** verify against the official docs before finalising:
>
> - Termii: `developers.termii.com`
> - Africa's Talking: `developers.africastalking.com`

### 9.1 Termii adapter

- **Endpoint:** `POST {TERMII_BASE_URL}/api/sms/send` — **do not hard-code a host.** Current Termii docs assign each account its own **base URL** (retrieved from the dashboard at `app.termii.com`) used to route to the correct region. `https://api.ng.termii.com` is the **legacy Nigeria host** and usually still works, but treat the base URL as configuration (`TERMII_BASE_URL`).
- **Body (JSON):**
```json
{
  "to": "2348012345678",
  "from": "<tenant senderId>",
  "sms": "<message>",
  "type": "plain",
  "channel": "<tenant channel, e.g. dnd>",
  "api_key": "<TERMII_API_KEY>"
}
```
- **Number format:** country code without `+` (e.g. `2348012345678`).
- **`channel`:** `dnd` for transactional notifications (delivers to **all** numbers, incl. Do-Not-Disturb); `generic` for promotional only (does **not** reach DND numbers, and on MTN is blocked 8pm–8am WAT). **The DND route must be activated on the Termii account (via Termii support) before `dnd` works.**
- **Success:** HTTP 200 with a JSON body containing `code: "ok"` and a `message_id` (also `message_id_str`); parse and return `message_id` as `providerMessageId`. On failure, map Termii's response `code`/HTTP status to `permanent` per the classification rule above (e.g. invalid sender/recipient → permanent; rate limit / server error → transient).

### 9.2 Africa's Talking adapter

- **Endpoint:** `POST https://api.africastalking.com/version1/messaging`
  (sandbox: `https://api.sandbox.africastalking.com/version1/messaging`)
- **Headers:** `apiKey: <AT_API_KEY>`, `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`
- **Body (form-urlencoded):** `username=<AT_USERNAME>&to=+2348012345678&message=<message>&from=<tenant senderId>&enqueue=true`
  - `from` (sender ID) is **optional** — if omitted, AT uses a shared default shortcode and the tenant's brand is lost; for tenant isolation it must be a **pre-approved** AT sender ID matching the tenant.
  - Include `enqueue=true` for reliable bulk handling.
  - **There is no `channel` parameter** — the adapter **ignores** `options.channel`. (DND delivery on AT depends on sender-ID/route registration, not a channel flag.)
- **Number format:** E.164 with `+` (v1 sends to one recipient per call).
- **Success:** JSON `SMSMessageData.Recipients[].status === "Success"`; return `Recipients[].messageId` as `providerMessageId`. Map non-`Success` to `{ ok: false, error: <status text>, permanent }`: classify recipient/sender problems (e.g. `InvalidSenderId`, `InvalidPhoneNumber`, `UserInBlacklist`) as **permanent**, and throttling/server problems as **transient** (§9 classification rule).

Both adapters return the unified `{ ok, providerMessageId?, error? }` shape so the processor never cares which provider is active. In **sandbox**, `AT_USERNAME` must be `sandbox`; a custom alphanumeric `from` is accepted/simulated but **not** actually delivered.

---

## 10. Phone normalisation & message-length rules

**`normalisePhone(raw, countryCode)`** converts common Nigerian inputs to canonical E.164; the adapter then formats per provider (with or without `+`):

| Input | Output (E.164) |
|---|---|
| `08012345678` | `+2348012345678` |
| `8012345678` | `+2348012345678` |
| `2348012345678` | `+2348012345678` |
| `+2348012345678` | `+2348012345678` |

Rules: **coerce to string first** (the Sheets value may arrive as a number, §5.2); **remove every character except digits and a single leading `+`** (covers spaces, dashes, dots, parentheses, and stray commas from number-formatting); drop a single leading `0` for national format; prepend `+<countryCode>` if no country code is present.

**Validity (be explicit):** after normalisation the result must match **`^\+234[789]\d{9}$`** — i.e. `+234` followed by a 10-digit national number starting `7`, `8`, or `9` (Nigerian mobile ranges; rejects landline/invalid prefixes that would waste paid sends). For other country codes, generalise to `+<countryCode>` followed by the expected national length. **If invalid (too short/long, non-numeric, empty), skip the row and log — do not crash.**

**Message length / special characters:** the naira sign `₦` and emoji are **not** in the GSM-7 alphabet (and `₦` is not even in the GSM-7 extension table — only `€` is, among currency symbols), so including them forces UCS-2 encoding, cutting a single segment from **160 to ~70** characters (and 153→67 per part for multi-part messages). **Use the text `NGN` instead of `₦`** and keep templates plain ASCII in v1. Each extra segment is extra cost; the DND/transactional route is also priced higher than generic.

---

## 11. Project structure

```
sms-dispatch-mvp/
  .gitignore        # MUST exist (see below)
  .env.example
  tenants.example.json
  package.json
  package-lock.json
  README.md
  src/
    index.js          # entry point: load config, validate, start the single-flight scheduler
    config.js         # parse env; provider-conditional validation; fail fast; effective-mode banner
    tenants.js        # load + validate the tenant registry (re-read each tick; last-known-good fallback)
    logger.js         # logging helper (tags lines with tenant id; redacts phone/secrets)
    sheets.js         # Google Sheets read (header map) + per-row writeback for a given sheetId/sheetName
    phone.js          # normalisePhone(), validation
    message.js        # buildMessage(template, row) incl. optional [[...]] clauses + amount formatting
    processor.js      # core loop: single-flight → per tenant → read → decide → send → mark (per row)
    sms/
      index.js        # provider selector exposing sendSms(to, message, options)
      termii.js       # Termii implementation
      africasTalking.js  # Africa's Talking implementation
  test/
    phone.test.js
    message.test.js
    tenants.test.js   # registry validation (missing template, duplicate id, bad senderId, etc.)
    processor.test.js # multi-tenant: mocked sheets + mocked sms; isolation + idempotency + guardrails
```

**`.gitignore` is mandatory** and must include at least: `.env`, `.env.*` (but `!.env.example`), `tenants.json` (but `!tenants.example.json`), `*.pem`, and the GCP key file patterns (`*service-account*.json`, `gcp-key*.json`, `credentials*.json`). Only the `*.example` files are committed. The downloaded GCP service-account JSON must **never** live inside the repo directory. `tenants.json` (real client list + sheetIds) is confidential — keep it out of version control.

Module responsibilities:

- **config.js** — shared env; provider-conditional validation; fail fast; startup banner.
- **tenants.js** — load `tenants.json`, validate each entry (§5.1: required fields, unique ids, senderId format/uniqueness, every `notifyStatuses` value has a `templates` entry), return active tenants; on file error keep last-known-good.
- **sheets.js** — `readOrders(sheetId, sheetName)` reads the header row, returns row objects with `rowNumber` (values as strings, ragged rows padded); `writeRow(sheetId, sheetName, rowNumber, { lastNotifiedStatus, notifiedAt, lastError })` writes only the mapped service columns.
- **sms/index.js** — pick adapter from `SMS_PROVIDER`; expose `sendSms(to, message, { senderId, channel })`.
- **processor.js** — pure, testable decision + orchestration; single-flight; loops tenants with per-tenant isolation; per-row write-back.
- **index.js** — wires everything; schedules `processor.run()` every `POLL_INTERVAL_SECONDS` with single-flight; installs `unhandledRejection`/`uncaughtException` handlers that log and exit cleanly (so a supervisor can restart — §12).

---

## 12. Demo / free mode

Runnable at zero cost for a demo:

- Run locally: `node src/index.js` (no server while demonstrating).
- `DRY_RUN=true` logs the SMS instead of calling the gateway (no credit used). It still marks the row (full idempotency path); clear `Last Notified Status` to re-test.
- `GLOBAL_TEST_NUMBER=<your verified number>` redirects messages to you, so a provider **trial credit** or **sandbox** is enough to show a real SMS arriving. It is honored **only when `NODE_ENV != production`** — the `.env` template defaults to `production`, so **set `NODE_ENV=development` for the demo** (or the override is silently ignored).
- Define two tenants in `tenants.json` pointing at two test sheets to demonstrate isolation.

**Production differences (later):** host the service on a small always-on box and run **exactly one instance** of it under a **process supervisor with restart-on-crash** (systemd `Restart=always`, PM2, or a container with a restart policy) so a crash/laptop-sleep doesn't silently take every client down. Running a single instance matters: the single-flight guard only prevents a tick from overlapping itself **within one process** — two processes pointed at the same sheets would double-send. Also: fund the gateway account; register each tenant's approved sender ID and the transactional/DND route (~2–3 weeks lead time, §2/§17); set `NODE_ENV=production` and remove test-number overrides. Watching the process logs is the v1 monitoring story.

---

## 13. Out of scope for v1 (do not build yet)

Explicitly **excluded** — keep v1 minimal:

- any web UI/dashboard, self-serve tenant onboarding portal, user authentication;
- inbound message handling, a "where is my order" bot, WhatsApp;
- payments/deposits, customer opt-out management;
- **a database or any persistent store** (the file registry + the sheets are the only state);
- **delivery-report (DLR) webhook receiver / delivery reconciliation** (we treat gateway acceptance as success, §9);
- **a metrics/health HTTP server or external alerting** (the operator watches structured logs, §7);
- **a per-tenant usage/billing system** (per-send log lines are the only audit trail in v1);
- per-tenant gateway accounts, horizontal scaling / sharding, secret managers / key rotation automation.

(Tenant onboarding in v1 is done by the operator editing `tenants.json`.) The adapter and registry design leave room for these later, but they are **not** part of the solid-MVP goal.

> **Note on the robustness rules above:** items like single-flight, per-row write-back, guardrails, header mapping, validation, and operator logging are **not** in this exclusion list — they are the minimum needed for a *correct* MVP, not feature expansion.

---

## 14. Edge cases & rules (must handle)

- **Single-flight:** never run two ticks concurrently; skip-and-log if the previous tick is still running.
- **Registry parse error:** keep last-known-good registry; never process zero tenants because of a half-saved file.
- **Tenant isolation:** one tenant's bad sheet, missing/duplicate header, missing template, or send failure must not stop other tenants (per-tenant try/catch); a thrown `sendSms` becomes a row failure, not a tenant abort.
- **Header drift:** column mapping is by header name; required-header missing/duplicated → skip-and-log the tenant.
- **No double-send (normal op):** enforced by canonical `Last Notified Status` per row + per-row write-back. After a crash mid-send, at-least-once is possible (documented, §1).
- **Status canonicalisation:** trim + lower-case both sides; write back the same canonical form.
- **Retry vs give-up:** *transient* failures (network/timeout/429/5xx) retry next tick (`Last Notified Status` left unchanged). *Permanent* failures (invalid recipient/sender) give up by setting `Last Notified Status = status`, so they do not retry until `Status` changes. Errors are written to `Last Error` and to the operator log either way.
- **Bulk-edit guardrail:** more than `MAX_SENDS_PER_TENANT_PER_TICK` eligible rows in one tick → warn loudly, process up to the cap, defer the rest.
- **Invalid phone:** skip and log (explicit `^\+234[789]\d{9}$` rule).
- **Sheets numeric coercion:** read `Phone`/`Amount` as strings; pad ragged rows; skip rows missing `Order ID`/`Phone`/`Status`.
- **Empty optional fields:** missing `amount`/`name` drop their `[[...]]` clause gracefully.
- **Rate limiting / timeouts:** wait `SEND_DELAY_MS` between sends; apply `HTTP_TIMEOUT_MS` to every external call so a hang cannot stall the tick.
- **Sheet read/write errors:** log per tenant (and to the operator) and continue.
- **Test-override safety:** `GLOBAL_TEST_NUMBER` honored only when `NODE_ENV != production`, with a loud per-tick warning.
- **Secrets:** never commit `.env`, `tenants.json`, or the GCP key; redact phone/api_key in logs; un-escape `GOOGLE_PRIVATE_KEY` newlines.
- **Special characters / length:** per §10.
- **Accepted ≠ delivered:** gateway success is acceptance, not delivery; log `providerMessageId`.

---

## 15. Testing plan

- **Unit:** `normalisePhone` (all formats + invalid: too short/long, non-numeric, empty, **value-as-number** with lost leading zero); `buildMessage` (placeholders, **empty/non-numeric amount drops its `[[...]]` clause**, amount grouping, input sanitisation/length cap); `tenants` validation (missing template, duplicate id, **bad senderId format**, **duplicate senderId across tenants**, inactive skipped, **last-known-good fallback on bad JSON**).
- **Unit (core):** `processor.run()` with **mocked sheets** and **mocked SMS adapter** across **two tenants** — assert each tenant uses its own sheet, sender ID, and templates; one tenant's failure (incl. a *thrown* `sendSms`) does not stop the other; **no resend when `status === lastNotifiedStatus`** including a **trailing-whitespace / different-case** variant; a **transient** send failure retries next tick (status left unchanged) while a **permanent** failure gives up (sets `Last Notified Status = status`, does **not** resend, and **resumes only when `Status` changes**); **bulk-edit cap** defers excess rows; **header reordering/insertion still maps correctly**; **per-row write-back** persists a successful send even if a later row throws; **`DRY_RUN` marks the row but performs no gateway call**; **`GLOBAL_TEST_NUMBER` ignored when `NODE_ENV=production`**.
- **Manual end-to-end:** two test sheets + `GLOBAL_TEST_NUMBER` (non-production); change a row in each to a notify status; confirm one SMS per tenant with the correct sender ID and wording, the row gets marked (`Last Notified Status`, UTC `Notified At`, empty `Last Error`), and re-polling does not resend.

---

## 16. Acceptance criteria (definition of done)

1. `npm ci && node src/index.js` validates config (fail-fast, prints the effective-mode banner) and polls all active tenants on the configured interval, **single-flight** (no overlapping ticks).
2. For each tenant, changing a row's `Status` to a value in that tenant's `notifyStatuses` sends **exactly one** SMS under normal operation (using that tenant's sender ID and template) to the customer (or test number), and marks the row (`Last Notified Status`, UTC `Notified At`, empty `Last Error`). (At-least-once only if the process crashes between send and mark — documented, §1.)
3. Re-running the poll does **not** resend, **including** when `Status` differs only by case/whitespace from `Last Notified Status`.
4. A **transient** send failure writes `Last Error` and is retried next poll; a **permanent** send failure writes `Last Error`, sets `Last Notified Status = status` so it does **not** retry, and resumes only when `Status` changes.
5. One tenant's failure (bad sheet, missing/duplicate header, send error/throw, bad config) does **not** affect other tenants.
6. Adding, pausing (`active:false`), or removing a tenant in `tenants.json` takes effect on the next poll **without code changes or restart**; a half-saved/invalid file does **not** zero out the fleet (last-known-good is kept).
7. Switching `SMS_PROVIDER` between `termii` and `africastalking` requires **config only**, no code change; provider-specific fields (e.g. `channel`) degrade gracefully (AT ignores `channel`).
8. Inserting or reordering columns in a tenant sheet does **not** cause wrong reads/writes (header-name mapping); invalid phone numbers and rows missing required fields are skipped and logged without crashing.
9. The bulk-edit guardrail caps sends per tenant per tick and logs a warning; `DRY_RUN=true` performs no gateway calls; `GLOBAL_TEST_NUMBER` is ignored when `NODE_ENV=production`.
10. `.gitignore` exists and excludes `.env`, `tenants.json`, and GCP key files; no secrets are committed.
11. Errors (send/sheet/tenant/phone/permanent-fail/cap) are visible in the **operator's logs**, not only in client sheets; each tick logs a per-tenant summary.
12. Unit tests (§15) pass.

---

## 17. Setup steps

**Google Sheets API (once):**
1. Create a Google Cloud project; enable the **Google Sheets API**.
2. Create a **service account**; download its JSON key; put the email + private key in `.env` (un-escape the `\n` newlines). **Store the downloaded JSON outside the repo.**

**SMS provider (once):**

1. Create a Termii or Africa's Talking account; put the API key in `.env`. For Termii, copy the account **base URL** from `app.termii.com` into `TERMII_BASE_URL` and ask support to **activate the DND/transactional route**.

**Onboarding a new tenant (per client — operator does this, no redeploy):**

1. **Register the client's sender ID** under your gateway account and apply for the **transactional/DND route**. This goes to the mobile operators (MTN/Glo/Airtel/9mobile) via the gateway and typically takes **~2–3 weeks** plus KYC (CAC, authorisation letter). The tenant stays `active: false` until it is approved.
2. Have the client **share their Google Sheet with the service account email** (Editor), and ensure the sheet is **not** "anyone with the link" shared. Confirm the header row matches §5.2 (names, not positions), and **format the `Phone` and `Amount` columns as *Plain text*** so values are read exactly as typed (§5.2).
3. Add a tenant entry to `tenants.json` (`id`, `name`, `sheetId`, `sheetName`, `senderId`, `channel`, `notifyStatuses`, `templates`), initially `active:false`.
4. Once the sender ID is approved, set `active:true`; the next poll picks it up automatically.

**Run:** copy `.env.example` → `.env` and `tenants.example.json` → `tenants.json`, fill them in, `npm ci`, `node src/index.js`.

---

## 18. Notes for the AI coding assistant

- **Keep it a minimal MVP.** Implement the robustness rules in this spec, but do **not** add anything from the §13 out-of-scope list. Favour the simplest code that satisfies each rule; favour clarity over cleverness.
- Keep the **core processor pure and testable**; isolate all I/O (Sheets, HTTP, registry) behind `sheets.js`, `sms/*`, and `tenants.js` so they can be mocked.
- **Map sheet columns by header name** (case-insensitive, trimmed), never by hard-coded position; validate required headers on each tenant load.
- **Compare statuses canonically** (trim + lower-case) and write back the same canonical value.
- **Write back per row, immediately after each send** (only the service-owned cells), to keep the send→mark window one row wide. Add a **single-flight** guard so ticks never overlap.
- Enforce **per-tenant isolation** (try/catch per tenant) and **per-row** error capture (a thrown `sendSms` becomes a failed row, not a tenant abort).
- Treat the SMS layer as a **swappable adapter** with a single `sendSms(to, message, options)` contract; pass per-tenant `senderId` and `channel` through `options`; the AT adapter ignores `channel`. Use HTTPS with verification, request timeouts, and **redact phone/api_key in logs**.
- Read `Phone`/`Amount` as **strings**; handle ragged rows; apply the explicit phone-validity regex.
- Apply the **guardrails**: `MAX_SENDS_PER_TENANT_PER_TICK` (bulk cap), classify send failures as **transient (retry)** vs **permanent (give up by marking the status)**, and gate `GLOBAL_TEST_NUMBER` behind `NODE_ENV != production`.
- Make **errors visible to the operator** via logs (not only the client sheet); log a per-tick per-tenant summary and the `providerMessageId` of each send.
- Validate shared config on startup (fail fast, provider-conditional) and each tenant on load (skip-and-log invalid tenants; keep last-known-good registry on file error).
- Ship a correct **`.gitignore`**; never read secrets from anything committed.
- Confirm the Termii / Africa's Talking request formats against their **current official docs** before finalising the adapters (base URL, field names, response shapes). Remember **gateway acceptance ≠ delivery**.
