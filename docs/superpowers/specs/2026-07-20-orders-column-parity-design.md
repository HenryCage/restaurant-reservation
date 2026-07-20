# Orders table column parity with the Sheet

Date: 2026-07-20
Status: designed, not yet implemented (see
docs/superpowers/plans/2026-07-20-orders-column-parity-plan.md once written).
Depends on: Sheets-mode order editing (`GET/POST/PATCH /api/orders`,
`OrdersTable.jsx`'s create/edit forms, `sheets.js`'s `parseOrders`/
`buildOrderWriteData`/`buildAppendData`). Implemented.

## Context

After Sheets-mode order editing shipped, the user compared the dashboard's
Orders tab against their real Google Sheet and asked for the two to match:
same columns, same left-to-right order, same data — "kad butu matomi visi
laukai taip pat kaip jie matomi ir google sheets" (so all fields are visible
just like they appear in Google Sheets), and for the system to adapt per
tenant, since different tenants' sheets have different numbers of columns
and different column names.

Today, `sheets.js`'s `ORDER_COLUMNS` is a fixed map of 8 logical fields
(`orderId`/`name`/`phone`/`amount`/`status`/`lastNotifiedStatus`/
`notifiedAt`/`lastError`) to header names. `buildColumnIndex`/`parseOrders`
only ever extract those known fields by header-name lookup and silently
**drop any other column** — a tenant's "Notes" or "Delivery Address" column
is invisible to the system entirely. The dashboard's table/form layout is
also hardcoded in JSX, not derived from the sheet's actual column order.
`Notified At` is mapped internally but never even surfaced in the UI today
— a gap this work incidentally fixes.

## Decisions made during brainstorming

- **Fully editable, not just visible.** Any column from the sheet — known
  or not — gets an input in the create/edit form and can be changed from
  the dashboard, matching the goal of the dashboard being a real substitute
  for opening the Sheet directly.
- **The 3 service columns (`Last Notified Status`/`Notified At`/
  `Last Error`) appear inline, at their real sheet position, read-only** —
  true visual parity, they're just never form inputs. This is a UI-only
  restriction; the existing invariant that only `processor.js`'s own
  `writeRow` ever writes them is unchanged and enforced server-side too
  (the route already never accepts them for writing — see Architecture).
- **`processor.js` and the reactive engine need zero changes.** Everything
  new is additive on top of `sheets.js`'s existing `colIndex`/flat-row
  shape, not a replacement of it.

## Architecture

`sheets.js`'s `parseOrders` gains two additive outputs alongside its
existing return shape:

```text
parseOrders(values) -> {
  ok: true,
  headers: string[],           // NEW: raw, trimmed header row, in sheet order
  colIndex: {...},             // UNCHANGED: logical-field-name -> position (orderId/phone/status/etc.)
  rows: [{
    rowNumber, orderId, name, phone, amount, status,
    lastNotifiedStatus, lastError,   // UNCHANGED: existing flat fields, processor.js's only concern
    values: Record<string, string>,  // NEW: every column's value, keyed by its raw header text
  }, ...],
}
```

`processor.js` keeps reading exactly the flat fields it reads today —
**zero changes, zero risk to the notification engine.** `values` and
`headers` are purely for the new HTTP/UI path.

Duplicate-header detection (today only checked for the 8 known fields)
extends to **any** duplicate header, compared the same case/space-
insensitive way as everything else in this file (`canonicalHeader`) — a
"Notes" column and a "notes" column collide, same as two "Status" columns
already do — so `buildColumnIndex` now flags that as a parse error the same
way a duplicate known-field header already is. A header cell that's
entirely blank is skipped: absent from `headers`, and any data sitting
under it is inaccessible via `values` (same "unrecognised column is
dropped" precedent as today, just narrowed to specifically blank headers
instead of every unknown one).

New pure helper `buildHeaderIndex(headers)` returns `{ [headerText]: index
}` for every header — used by the write path below. `buildAppendData`/
`buildOrderWriteData` (existing, from the Sheets-mode order editing spec)
need **no changes**: they already accept any `{ field: index }`-shaped
index object and iterate the fields given to them, so calling them with a
header-text-keyed index instead of the logical-field-keyed `colIndex` just
works.

```text
src/http/routes/orders.js
  GET /   modified: response becomes { headers, rows, roles, notifyStatuses }
          -- rows carry each row's full `values` map (plus rowNumber/orderId
          for identification); `roles` tells the client which actual header
          text plays each special part:
          { orderId: 'Order ID', phone: 'Phone', status: 'Status',
            lastNotifiedStatus: 'Last Notified Status',
            notifiedAt: 'Notified At', lastError: 'Last Error' }
          (name/amount are no longer special-cased -- they're just
          ordinary headers now, like any other optional column).
  POST /              modified: body becomes { values: {...}, countryCode? }
  PATCH /:rowNumber    modified: same -- a generic header-text -> new-value
                       map instead of named fields (name/phone/amount/status).
```

Validation moves from "the field named phone" to "whichever header
`roles.phone` points at, if the tenant's sheet has one" — same
`normalisePhone`/non-blank-status rules as today, just resolved via
`roles` instead of a hardcoded key. The route rejects `values` entries for
`roles.orderId`, `roles.lastNotifiedStatus`, `roles.notifiedAt`, and
`roles.lastError` if present in the request body (service columns and
Order ID are never client-writable) rather than silently ignoring them, so
a bug on the client side surfaces immediately instead of failing silently.

## UI

`OrdersTable.jsx`'s table renders one column per `headers` entry, in that
order, reading `row.values[header]` for each cell — no more hardcoded
`<th>` list. The create/edit form renders one input per header the same
way: a plain text input by default; the header matching `roles.phone` gets
the existing country-selector treatment; the header matching `roles.status`
gets the existing `<datalist>` suggestions; the 3 service-role headers
render as disabled/read-only cells (shown in the form for context but never
submitted); `roles.orderId`'s header is disabled in edit mode and omitted
from the create form entirely (still server-generated). Every other header
— known or arbitrary — is just a required-or-not-per-`ORDER_COLUMNS`-today
plain text input (only the header matching `roles.phone`/`roles.status`
stays hard-required; everything else, optional, blank allowed).

## Testing

- `sheets.js`: new tests for `headers`/per-row `values` on `parseOrders`
  (reordered/inserted columns, an unrecognised extra column, a blank
  header skipped, a duplicate arbitrary header rejected). `buildHeaderIndex`
  unit-tested directly. Existing `buildAppendData`/`buildOrderWriteData`
  tests need no changes to the functions themselves, only new call-site
  tests proving they work against a header-text-keyed index.
- `test/http/ordersRoutes.test.js`: `GET` response shape (`headers`/
  `roles`/`values`); `POST`/`PATCH` accepting an arbitrary column;
  rejecting a `values` entry for a service-role or Order-ID header;
  phone/status validation still enforced via `roles` lookup.
- `OrdersTable.test.jsx`: table renders columns in `headers` order
  including an unrecognised one; create/edit form renders one input per
  header with the right special-cased treatment for phone/status/service/
  order-id headers; a plain arbitrary column round-trips through create
  and edit.

## Explicitly out of scope

- Any change to `processor.js`, the eligibility/send logic, or `writeRow`
  — this spec is additive-only on top of the existing reactive engine.
- Column reordering, renaming, adding, or removing a column from the
  dashboard itself — the Sheet's own header row remains the only way to
  change what columns exist; the dashboard adapts to it, never the reverse.
- No-sheets/SQLite-backed orders — separate, not-yet-started future spec.
