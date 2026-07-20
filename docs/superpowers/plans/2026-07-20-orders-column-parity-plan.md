# Implementation plan: Orders column parity with the Sheet

Spec: `docs/superpowers/specs/2026-07-20-orders-column-parity-design.md`
Status: not started.

(Note: the `writing-plans` skill isn't installed in this environment --
written directly, same as the other plans in this directory.)

## Sequencing rationale

Pure functions in `sheets.js` (testable without googleapis) → HTTP routes
(reusing those pure functions, tested against a fake `sheetsApi`) →
dashboard UI (the only layer that actually changes shape for a human) →
full suite + build → optional live smoke check (we now have working Google
credentials for Swift Logistics, unlike the first attempt at this spec's
predecessor). `npm test` (backend) and `cd client && npm test` stay green
after their respective steps.

Implementation-level decisions the spec left open, resolved here:

1. **`ORDER_COLUMNS`/`colIndex` are not touched.** All 8 existing logical
   fields (including `name`/`amount`) keep being computed exactly as today
   — `processor.js` reads `row.name`/`row.amount`/etc. unchanged. The new
   `roles` object (a *different*, UI-facing structure) intentionally covers
   only 6 of those 8 (`orderId`/`phone`/`status`/`lastNotifiedStatus`/
   `notifiedAt`/`lastError`) — `name`/`amount` are demoted to "just another
   header" for the new fully-generic edit form, but nothing about how
   they're read/templated internally changes.
2. **Duplicate-header detection is generalized, not duplicated.** Today
   `buildColumnIndex` only checks duplicates among `ORDER_COLUMNS`'
   8 known headers. It's rewritten to do one pass over *every* non-blank
   canonical header first (case/space-insensitive, same `canonicalHeader`
   used everywhere in this file) — any canonical value appearing more than
   once is a duplicate-header parse error, which subsumes the old
   known-field-only check (a duplicate "Status" is still caught, just via
   the general path now). **This changes real, currently-tested behavior**:
   `test/sheets.test.js`'s existing `buildColumnIndex` case "ignores
   unrelated duplicate columns" (`[...FULL_HEADER, 'Notes', 'Notes']` →
   `ok: true`) is now wrong per the spec and must be rewritten to expect
   `ok: false` with a duplicate-header error instead — flagging this
   explicitly since it's a deliberate behavior reversal, not an oversight.
3. **`headers[i]` is the raw sheet text, trimmed but not case-folded** (`String(headerRow[i] ?? '').trim()`)
   — used both as the human-readable table/form label and as the `values`/
   `roles` map key, so `row.values[headers[i]]` and `roles.status === headers[i]`
   compare correctly without a separate canonicalization step at the UI
   layer. A blank header (empty after trim) is left out of `headers`
   entirely and its column's data is unreachable via `values` (consistent
   with "unrecognised column dropped," just narrowed to blank ones now that
   *known* unrecognised columns are captured instead of dropped).
4. **`buildRoles(headers, colIndex)`** is a new pure export in `sheets.js`:
   `Object.fromEntries(['orderId','phone','status','lastNotifiedStatus','notifiedAt','lastError'].map(f => [f, headers[colIndex[f]]]))`.
   Since all 6 are `required: true` in `ORDER_COLUMNS`, `colIndex[f]` is
   always defined whenever `parseOrders`/`buildColumnIndex` returned `ok:
   true` at all -- no undefined-guarding needed at call sites.
5. **`buildHeaderIndex(headers)`** is a new pure export:
   `Object.fromEntries(headers.map((h, i) => [h, i]))`. Trivial, but kept as
   a named, independently-tested function (matching this file's existing
   convention of small named pure helpers) rather than an inline one-liner
   at each of the two call sites (`POST`/`PATCH`) that need it.
6. **The route layer, not `sheets.js`, computes `roles`.** `parseOrders`'s
   return shape stays `{ ok, colIndex, headers, rows }` — `roles` is built
   once per request in `orders.js` from the already-returned `headers`/
   `colIndex`, since it's a presentation concern, not a parsing one.

## Step 1 — `sheets.js`: `headers`/`values`, generalized duplicate check, `buildRoles`/`buildHeaderIndex`

- `parseOrders`: after building `colIndex`, also build `headers =
  headerRow.map(h => String(h ?? '').trim())` filtered to drop blank
  entries -- but positions must stay aligned with `colIndex`'s existing
  indices, so blank headers are *kept as empty-string placeholders in a
  same-length array used for cell lookups*, then filtered to a second,
  compact `headers` array for the public return value; `values` per row is
  built by iterating the *original* (unfiltered) header positions and only
  assigning into the `values` object for non-blank headers (`if (headers[i]
  === '') continue;`), keyed by that header text, value via the same
  `cell()` coercion already used for known fields. Each row gains `values`
  alongside its existing flat fields.
- `buildColumnIndex`: add the generalized duplicate pass (decision 2) as
  the first check, before the existing per-`ORDER_COLUMNS` loop; the
  existing loop simplifies since duplicates are already ruled out (a
  header now matches at most one position, so `header.indexOf(want)`
  replaces the old `matches.length` counting).
- New exports: `buildRoles(headers, colIndex)`, `buildHeaderIndex(headers)`
  (decisions 4-5).
- `test/sheets.test.js`:
  - Rewrite `buildColumnIndex`'s "ignores unrelated duplicate columns" case
    to assert `ok: false` + a duplicate-header error (decision 2).
  - New `parseOrders` cases: an unrecognised extra column ("Notes") appears
    in `headers` and every row's `values`; a blank header is absent from
    `headers` and its column's data unreachable; `headers` preserves sheet
    order through reordering/insertion (extend the existing reordering
    test).
  - New `describe` blocks for `buildRoles` (all 6 roles resolve to the
    right header text) and `buildHeaderIndex` (position map, including a
    header containing regex-special characters to prove it's a plain
    object key, not a pattern).
- Checkpoint: `npx vitest run test/sheets.test.js`.

## Step 2 — `src/http/routes/orders.js`: generic `values`-based GET/POST/PATCH

- `GET /`: response becomes `{ headers: read.headers, rows: read.rows.map(r
  => ({ rowNumber: r.rowNumber, orderId: r.orderId, values: r.values })),
  roles: buildRoles(read.headers, read.colIndex), notifyStatuses:
  tenant.notifyStatuses }`.
- `POST /`: body becomes `{ values: {...}, countryCode? }`. Reject (400) if
  `values` contains a key equal to `roles.orderId`/`roles.lastNotifiedStatus`/
  `roles.notifiedAt`/`roles.lastError` (service/server-controlled headers
  are never client-writable). Validate `values[roles.status]` non-blank and
  `values[roles.phone]` via `normalisePhone` exactly as today, writing the
  normalised phone back into `values[roles.phone]` before appending.
  Generate the order id and set `values[roles.orderId]`. Call
  `sheets.appendOrder(tenant.sheetId, tenant.sheetName,
  buildHeaderIndex(read.headers), values)`. Respond `201` with `{
  rowNumber, orderId, values }`.
- `PATCH /:rowNumber`: same forbidden-header check on the incoming
  `values`. Concurrency check unchanged (`row.orderId !==
  body.expectedOrderId` → 409). Validate `values[roles.status]`/
  `values[roles.phone]` only if that key is present in the incoming
  `values` (partial update, same as today). Call
  `sheets.writeOrderFields(..., buildHeaderIndex(read.headers), values)`.
  Respond `200` with `{ ...row, values: { ...row.values, ...values } }`.
- `test/http/ordersRoutes.test.js`: rewrite `COL_INDEX`/fixtures to include
  a `headers` array and per-row `values`; update existing
  GET/POST/PATCH cases for the new shape; new cases -- an arbitrary column
  round-trips through create and edit; a `values` entry for a service-role
  or Order-ID header is rejected with 400; phone/status validation still
  enforced via the resolved role header.
- Checkpoint: `npx vitest run test/http/ordersRoutes.test.js`, then `npm
  test` (full backend suite).

## Step 3 — Dashboard UI: dynamic table + create/edit forms

- `OrdersTable.jsx`: `fetchOrders` stores `headers`/`rows`/`roles`/
  `notifyStatuses` from the new response shape (replacing the old
  `columns` state). Table `<thead>` renders one `<th>` per `headers`
  entry (plus a trailing empty header for the Edit-action column);
  `<tbody>` renders one `<td>` per header reading `row.values[header]`.
  Create form: one field per header, in `headers` order, skipping
  `roles.orderId` entirely (server-generated) and rendering
  `roles.lastNotifiedStatus`/`roles.notifiedAt`/`roles.lastError` as
  disabled/read-only (blank, since they don't exist yet on a new order --
  shown for layout consistency, not usefully editable). The header
  matching `roles.phone` gets the existing country-selector `<select>` +
  `<input type="tel">` pair; the header matching `roles.status` gets the
  existing `<datalist>`; every other header (known optional like the old
  Name/Amount, or genuinely arbitrary) is a plain text `<input>`, optional.
  Edit form: same per-header rendering, `roles.orderId`'s header shown but
  `disabled`, the 3 service-role headers shown but `disabled` (pre-filled
  from the row's current `values`, never submitted). Form state becomes a
  single `Record<string,string>` keyed by header text (replacing the old
  named-field state), submitted as `{ values, countryCode }`.
- `OrdersTable.test.jsx`: rewrite `ordersResponse()` test fixture to the
  new shape; existing "only renders fields present in columns" case becomes
  "renders one field per header, skipping Order ID and disabling service
  headers"; new cases -- an arbitrary column ("Notes") renders as a labeled
  text input and round-trips through create and edit; table `<th>` order
  matches `headers` order including an unrecognised column.
- Checkpoint: `cd client && npm test`, then `npm run build`.

## Step 4 — full suite

- `npm test` (backend) and `cd client && npm test` both green; `npm run
  build` (client) succeeds. Grep the whole client test suite for any other
  hardcoded `/api/orders` response shape assumption (the Sheets-mode order
  editing spec's implementation already found two such spots --
  `DashboardScreen.test.jsx` and `App.test.jsx` -- when the shape changed
  the first time; check both again here).

## Step 5 — manual smoke check (optional, not blocked this time)

Unlike the predecessor spec, real Google credentials already work for
Swift Logistics (confirmed live earlier this session) -- if desired:

- Open the dashboard's Orders tab for Swift Logistics, confirm the table's
  columns match the real Sheet's left-to-right header order exactly,
  including any column beyond the original 5 (e.g. add a scratch "Notes"
  column to the real Sheet first if none exists).
- Create a scratch order filling in the arbitrary column, confirm it lands
  in the Sheet under the right header. Edit it, confirm the same. Clean up
  the scratch row and any scratch column added for the test afterward.

## Out of scope reminders (carried from the spec)

No change to `processor.js`/the eligibility/send logic/`writeRow`. No
column reordering/renaming/adding/removing from the dashboard itself --
the Sheet's own header row is still the only way to change what columns
exist. No-sheets/SQLite-backed orders is a separate future spec.
