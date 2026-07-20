# Sheets-mode order editing

Date: 2026-07-20
Status: designed, not yet implemented (see
docs/superpowers/plans/2026-07-20-sheets-order-editing-plan.md once written).
Depends on: Dashboard UI (`GET /api/orders`, `OrdersTable.jsx`), Per-tenant SMS
provider / default country code (`countryCodeFor`, `normalisePhone`), Contacts
UI (country-code selector component being reused). All implemented.

## Context

Orders today are strictly read-only in the dashboard: `GET /api/orders` calls
`sheets.readOrders()` live and the sheet engine (`processor.js`) reacts only
to edits made directly in the Google Sheet. The user asked to create new
orders, edit an order's info, and change its status from the dashboard UI —
"vartotojai galetu keisti uzsakymu info, kurti naujus, keisti ju statusa."

This was brainstormed as two sequential sub-projects because the request
implies two very different destinations for order data:

1. **Sheets-mode order editing** (this spec) — for tenants who keep using
   their Google Sheet, write UI edits straight back to it.
2. **No-sheets mode** (future, separate spec) — a SQLite-backed `orders`
   store for tenants without a spreadsheet at all, which requires
   generalizing `processor.js` to work against either backend per tenant.

This spec covers only #1. It deliberately touches none of the reactive
engine: a UI-originated edit is written as an ordinary cell/row change, so a
subsequent processor tick treats it exactly as if a person had typed it into
the spreadsheet by hand — no new eligibility rule, no new write path inside
`processor.js` itself.

## Decisions made during brainstorming

- **Write straight to the Sheet**, not a local cache or a new DB table.
  Preserves the Sheet as source of truth; no changes needed to
  `processor.js`'s eligibility/send/write-back logic.
- **Optimistic concurrency check on edit**: a `PATCH` must carry the
  `orderId` the client last saw for that row. The server re-reads the sheet
  and verifies the row at that position still has that `orderId` before
  writing; a mismatch is a `409`, not a silent overwrite. Real order data is
  higher-stakes than the existing 3 service columns, where a stale write is
  harmless — a wrong-row overwrite here could corrupt a stranger's order.
- **Status field is dropdown-suggestions + free text**, not constrained to
  only the tenant's configured `notifyStatuses` — matches how the Sheet
  itself has always accepted arbitrary text (e.g. "Processing", "Cancelled"
  with no template at all).
- **No delete/remove-row** in this piece — not part of the original ask.
- **Order ID is server-generated and immutable** — format
  `ORD-YYYYMMDD-XXXX` (4 random uppercase alphanumeric characters),
  regenerated on the rare collision against the sheet's current Order ID
  column (checked using the same read already needed to append). The user
  never types or edits it.

## Architecture

`sheets.js` gains two new exports alongside the existing `readOrders`
(unchanged) and `writeRow` (unchanged, still the narrow 3-service-column
path used only by `processor.js`):

```text
src/sheets.js
  generateOrderId(existingIds)         # pure: ORD-YYYYMMDD-XXXX, retries on collision
  buildAppendData(colIndex, fields)    # pure: sparse row array sized to max column index
  buildOrderWriteData(sheetName, rowNumber, colIndex, fields)  # pure: like buildWriteData but for any ORDER_COLUMNS field, not just SERVICE_FIELDS
  createSheetsClient(...)
    .appendOrder(sheetId, sheetName, colIndex, fields)   # values.append, INSERT_ROWS
    .writeOrderFields(sheetId, sheetName, rowNumber, colIndex, fields)  # values.batchUpdate, reuses buildOrderWriteData
```

`writeOrderFields` is kept distinct from `writeRow` rather than widening
`writeRow` itself — the notification engine's own write-back stays exactly
as narrowly scoped as it is today; this is a separate, HTTP-triggered path
with its own callers and its own tests.

Both new methods only ever write to columns present in `colIndex` for that
tenant's sheet — a tenant without an "Amount" column (allowed today, since
`ORDER_COLUMNS.amount.required === false`) simply can't receive an Amount
write; the route layer omits that field from both the request validation
and the write.

```text
src/http/routes/orders.js
  GET /                modified: response gains `columns: string[]` (which
                       optional ORDER_COLUMNS keys this tenant's sheet
                       actually has, derived from colIndex) alongside `rows`
                       -- the UI needs this to know which fields to show in
                       the create/edit form; a row's own fields can't tell
                       "column absent" apart from "column present but blank."
  POST /                new: create
  PATCH /:rowNumber      new: edit / status change
```

Both new routes reuse the existing `requireAuth` + `resolveTenantId` scoping
(a non-superadmin is forced to their own tenant; a superadmin must pass
`?tenantId=`) — identical authorization to the existing `GET`.

**`POST /api/orders`** — body `{ name?, phone, amount?, status, countryCode?
}`.

1. Re-read the sheet (`sheets.readOrders`) to get `colIndex` and the current
   Order ID column (for both collision-checking the generated id and
   knowing which optional columns exist).
2. Validate: `phone` and `status` are required (a blank status makes
   `parseOrders` silently skip the row entirely — CLAUDE.md's existing
   skip-blank-required-field rule, not new here); `phone` must normalise via
   `normalisePhone(phone, countryCode || tenant.defaultCountryCode ||
   config.defaultCountryCode)` — reuses the same resolution order
   `countryCodeFor(tenant)` already uses in `processor.js`.
3. Generate the Order ID, `appendOrder()` with whatever fields the sheet has
   columns for; `Last Notified Status`/`Notified At`/`Last Error` are left
   blank so the very next tick sends a notification if `status` matches a
   `notifyStatus`.
4. Return the created row (same `OrderRow` shape `GET` returns).

**`PATCH /api/orders/:rowNumber`** — body `{ expectedOrderId, name?, phone?,
amount?, status? }`, partial (only sent fields are written).

1. Re-read the sheet; find the row at `rowNumber`.
2. 404 if that row no longer exists (fewer rows than before). `409` if it
   exists but its `orderId` !== `expectedOrderId` — "this order changed,
   please refresh" — the concurrency check.
3. Validate any provided `phone`/`status` the same way as create.
4. `writeOrderFields()` with only the fields present in the body — untouched
   fields, including the 3 service columns, are left exactly as they are.
   Changing `status` needs no special handling: the next tick's existing
   `canonicalStatus(status) != canonicalStatus(lastNotifiedStatus)` check
   already re-triggers eligibility if they now differ.
5. Return the updated row.

## UI

`OrdersTable.jsx` gains a "New order" button opening a form (reusing the
Contacts form's country-code selector for the phone field) with only the
fields listed in the `GET /api/orders` response's new `columns` array.
Status is a text input with an HTML `<datalist>` populated from the
tenant's `notifyStatuses` — native combobox behavior: pick a suggestion or
type anything else.

Each row gets an "Edit" action opening the same form pre-filled, with Order
ID shown read-only. On submit, `PATCH` includes the row's current `orderId`
as `expectedOrderId`. A `409` response shows a clear "this order was changed
elsewhere, refreshing…" message and re-fetches the orders list rather than
retrying blindly.

## Testing

- `src/sheets.js` pure functions (`generateOrderId`, `buildAppendData`,
  `buildOrderWriteData`) unit-tested without googleapis, same convention as
  `parseOrders`/`buildColumnIndex`/`buildWriteData` today.
- `createSheetsClient().appendOrder`/`.writeOrderFields` tested against a
  fake `sheetsApi`, same pattern as the existing `readOrders`/`writeRow`
  tests.
- `test/http/ordersRoutes.test.js`: create (success, missing required field,
  invalid phone), edit (success partial-field update, 404 unknown row, 409
  concurrency mismatch), tenant-scoping (non-superadmin forced to own
  tenant, superadmin requires `?tenantId=` — same shape as existing
  `GET`/other tenant-scoped route tests).
- `OrdersTable.test.jsx`: new-order form renders only existing-column
  fields, submits expected payload; edit form pre-fills and sends
  `expectedOrderId`; a `409` shows the conflict message and triggers a
  re-fetch.

## Explicitly out of scope

- Deleting/removing an order row.
- No-sheets/SQLite-backed orders and any change to `processor.js` itself —
  separate future spec.
- Any change to `writeRow`/`SERVICE_FIELDS` or the notification engine's own
  write-back path.
- Bulk create/import (e.g. CSV upload) — one order at a time via the form.
