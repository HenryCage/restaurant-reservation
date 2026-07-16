# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                       # install (Node 20+ required; uses native fetch + ESM)
npm start                    # run the service (node src/index.js)
npm run dev                  # run with --watch (restart on file change)
npm test                     # vitest run (all suites, no network)
npm run test:watch           # vitest in watch mode
npx vitest run test/processor.test.js          # single suite
npx vitest run -t "transient"                  # single test by name
```

There is no build step and no linter configured. Local runs need `.env` (copy `.env.example`) and `tenants.json` (copy `tenants.example.json`).

## What this is

A single-process, multi-tenant backend that polls each tenant's Google Sheet of delivery orders and sends the customer an SMS (via a Nigerian gateway — Termii or Africa's Talking) when a row's **Status** enters a notifiable value, then writes markers back to the row so it is not re-sent. No UI, no inbound handling, no database. The sheet plus `tenants.json` are the only state. `SMS_Dispatch_MVP_Build_Spec.md` is the authoritative spec; source comments cite its section numbers (e.g. "spec §7").

## Architecture

Entry point [src/index.js](src/index.js) loads config, wires dependencies via constructor injection, and drives a `setInterval` scheduler. Every module exposes a `create*` factory that takes its collaborators as arguments — **all I/O (registry file, Google Sheets, SMS gateway, `fetch`, clock, sleep) is injected**, which is why the entire processor loop is unit-tested with mocks and never touches the network. When adding a module, follow this factory + injected-deps pattern so it stays testable.

The tick pipeline, per poll:

1. **[src/tenants.js](src/tenants.js)** — `registry.load()` re-reads `tenants.json` every tick. Two robustness invariants live here and must be preserved: (a) a whole-file read/parse/shape error keeps the **last-known-good** in-memory set rather than zeroing the fleet; (b) an individual invalid tenant is skipped-and-logged, never fatal. `senderId` must be unique across *active* tenants (cross-tenant impersonation guard). `canonicalStatus()` (trim + lowercase) is the single source of truth for all status/template comparison — it is precomputed into `notifyStatusesCanonical` and `templatesByCanonical` so the processor's comparisons round-trip identically.

2. **[src/processor.js](src/processor.js)** — the core loop (`createProcessor().run()`). Key guarantees, each load-bearing:
   - **Single-flight**: a `running` flag makes an overrunning tick skip the next fire rather than overlap.
   - **Per-tenant isolation**: one tenant (or one row) throwing never stops the others — both levels are wrapped in try/catch.
   - **Send-then-write-back-immediately** (per row, not batched): a crash re-sends *at most one* message. This is the exactly-once-under-normal-operation / at-least-once-on-crash boundary — do not batch writes.
   - **Eligibility**: `status ∈ notifyStatuses` AND `canonicalStatus(status) != canonicalStatus(lastNotifiedStatus)` AND phone normalises to a valid number.
   - **Transient vs permanent failure**: transient leaves `Last Notified Status` unchanged (retries next tick); permanent *sets* `Last Notified Status` to park the row (inert until the customer's `Status` changes). There is no attempts counter — the sheet is the state machine.
   - **Bulk-edit guard**: more than `MAX_SENDS_PER_TENANT_PER_TICK` eligible rows → send the cap, warn loudly, defer the rest (protects against a fat-fingered bulk paste).

3. **[src/message.js](src/message.js)** — pure templating. `{name}`, `{orderId}`, `{amount}`; `[[ ... ]]` clauses drop entirely if any placeholder inside is empty (this is how the amount line is omitted when `Amount` is blank). Sheet-sourced text is sanitised (control chars stripped, length capped) because anyone with sheet access can type anything. Amounts are parsed to whole naira with thousands grouping — *not* a naive strip-non-digits. Keep message text plain ASCII (`NGN`, never `₦`).

4. **[src/sms/index.js](src/sms/index.js)** — `createSmsSender()` selects the provider adapter and normalises every outcome to `{ ok, providerMessageId?, error?, permanent? }`. A thrown adapter error is coerced to a **transient** failure. Adapters ([termii.js](src/sms/termii.js), [africasTalking.js](src/sms/africasTalking.js)) classify provider errors into permanent (invalid recipient/sender) vs transient (429/5xx/auth/network), defaulting to transient when unsure — safer to retry than silently drop a notification. All requests go through [httpClient.js](src/sms/httpClient.js) (`requestWithTimeout`).

5. **[src/sheets.js](src/sheets.js)** — columns are mapped **by header name** (case-insensitive, trimmed), never by fixed position, because clients own and edit their sheets. Reads use `FORMATTED_VALUE` so Phone/Amount arrive as typed strings. Write-back is **cell-scoped** to only the three service-owned columns (`Last Notified Status`, `Notified At`, `Last Error`) via `values.batchUpdate` — never a row-level write that could clobber dispatcher data. Pure helpers (`parseOrders`, `buildColumnIndex`, `buildWriteData`, `columnIndexToLetter`) hold the logic and are tested without googleapis.

6. **[src/phone.js](src/phone.js)** — tolerant on input (strips all formatting), strict on output (returns `null` for anything invalid so the caller skips + logs rather than paying for a bad send). For country code 234 it enforces the real Nigerian mobile shape `+234[789]XXXXXXXXX`; other codes get a generic E.164 length check.

7. **[src/config.js](src/config.js)** — `loadConfig(env)` is pure (reads a passed-in env object) and fail-fast: it collects *all* problems and throws once, so the operator fixes everything in one restart. Validation is provider-conditional (only the active provider's keys are required). `GOOGLE_PRIVATE_KEY`'s literal `\n` sequences are un-escaped to real newlines here.

8. **[src/logger.js](src/logger.js)** — logs are the operator's only observability surface (no metrics server). Every line is timestamped and, when scoped via `.child(tenantId)`, tagged `[tenant:<id>]`. Use `maskPhone()` for any phone number in a log line; never log secrets/API keys.

## Conventions

- **ESM only** (`"type": "module"`); use `import`, native `fetch`, and `node:`-prefixed builtins.
- Pure logic and I/O are deliberately separated in every module so tests hit the pure functions directly and inject fakes for the rest. `test/` mirrors `src/` one-to-one.
- `tenants.json` and `.env` are gitignored and hold secrets/PII — never commit them; edit the `*.example.*` files for documentation.
- Safety modes are layered: `DRY_RUN=true` logs instead of sending (rows still marked); `GLOBAL_TEST_NUMBER` redirects every message but is **ignored when `NODE_ENV=production`**; a per-tenant `testNumber` does the same per tenant.

## Operational note

Run **exactly one instance** under a restart-on-crash supervisor (systemd `Restart=always`, PM2, container policy). The single-flight guard only prevents overlap *within* one process; there is no leader election. Fatal errors call `process.exit(1)` by design so the supervisor restarts from a clean state. "Gateway success" means *accepted*, not *delivered* — delivery reports are out of scope for v1.
