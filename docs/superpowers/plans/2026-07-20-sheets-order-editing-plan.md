# Implementation plan: Sheets-mode order editing

Spec: `docs/superpowers/specs/2026-07-20-sheets-order-editing-design.md`
Status: not started.

(Note: the `writing-plans` skill referenced by the brainstorming skill isn't
installed in this environment -- only `brainstorming` and
`agent-self-evaluation` are present under `~/.claude/skills/`. This plan was
written directly, following the same structure/conventions as the other
plans in this directory, e.g.
`docs/superpowers/plans/2026-07-16-per-tenant-sms-provider-plan.md`.)

## Sequencing rationale

Pure helpers in `sheets.js` (testable without googleapis) → the two new I/O
methods on `createSheetsClient` (tested against a fake `sheetsApi`, same
pattern as `readOrders`/`writeRow`) → HTTP routes (`POST`/`PATCH`, plus the
`GET` response's new `columns` field) → dashboard UI → manual smoke check.
`npm test` (backend) and `cd client && npm test` stay green after their
respective steps.

Implementation-level decisions the spec left open, resolved here:

1. **`buildOrderWriteData` is a genuinely separate function from
   `buildWriteData`, not a generalized shared one.** `buildWriteData` stays
   completely untouched (still hardcoded to iterate `SERVICE_FIELDS`, still
   the only thing `processor.js`'s `writeRow` path uses). `buildOrderWriteData`
   is new, small, and iterates `Object.keys(fields)` instead of a fixed
   constant list. This duplicates a few lines rather than sharing one
   generalized helper, matching this codebase's existing precedent
   (`campaignScheduler.js` deliberately duplicates `resolveRecipient`/
   `countryCodeFor` rather than importing them from `processor.js`) so the
   notification engine's write-back path and the new HTTP-triggered
   order-edit path stay fully independent — a future change to one can never
   accidentally widen what the other is allowed to touch.
2. **`generateOrderId`'s signature is `generateOrderId(existingIds, deps =
   {})`** where `deps.now = () => new Date()` and `deps.randomSuffix = () =>
   <4 random uppercase alphanumeric chars>` (real implementation uses
   `node:crypto`'s `randomInt`), both overridable so tests are deterministic.
   Format: `` `ORD-${yyyymmdd}-${randomSuffix()}` ``. Loops (capped at 20
   attempts, which is unreachable in practice) regenerating the suffix if the
   result is already in `existingIds`.
3. **`orders.js` gets its own tiny `countryCodeFor(tenant)` helper**
   (`tenant.defaultCountryCode || config.defaultCountryCode`), a third
   near-identical copy alongside `processor.js`'s and
   `campaignScheduler.js`'s — same rationale as decision 1. `createOrdersRoutes`
   gains `config` as a new required dependency (already constructed and in
   scope in `server.js`, passed the same way `createStatusRoutes` already
   receives it).
4. **The `GET /` response shape changes** from a bare array to `{ rows,
   columns, notifyStatuses }` — a breaking shape change for that one
   endpoint. `OrdersTable.jsx` and its test are updated in the same step as
   the route change (Step 4) rather than left tolerant of both shapes, since
   there are no real tenants/users yet to worry about a deployed old client
   hitting a new server (pre-launch status applies here too).
5. **`notifyStatuses` rides along on `GET /api/orders` rather than a new
   endpoint.** A regular tenant user today has no way to read their own
   tenant's config at all (`/api/tenants` is `requireSuperadmin`-only) — the
   status `<datalist>` needs `tenant.notifyStatuses` client-side, and the
   orders route already has the full `tenant` object in hand for every
   request. Piggy-backing it on the existing Orders fetch avoids inventing a
   new "read my own tenant" auth surface (which would also raise its own
   question of exactly which tenant fields are safe to expose to a
   non-superadmin) for the sake of one small array.

## Step 1 — `sheets.js` pure helpers

- New exports: `generateOrderId(existingIds, deps)`,
  `buildAppendData(colIndex, fields)` (a single sparse row array, one element
  longer than the highest column index in `colIndex`, blank at every
  position not present in `fields`), `buildOrderWriteData(sheetName,
  rowNumber, colIndex, fields)` per sequencing decision 1.
- `test/sheets.test.js`: new `describe` blocks for each — `generateOrderId`
  (format, deterministic with injected `now`/`randomSuffix`, retries past a
  collision), `buildAppendData` (correct positions, gaps blank, unknown
  `colIndex` keys ignored), `buildOrderWriteData` (writes any field present
  in both `fields` and `colIndex`, skips fields whose column doesn't exist,
  same range-string shape as `buildWriteData`'s existing tests).
- Checkpoint: `npx vitest run test/sheets.test.js`.

## Step 2 — `createSheetsClient`: `appendOrder` / `writeOrderFields`

- `appendOrder(sheetId, sheetName, colIndex, fields)`: calls
  `sheetsApi.spreadsheets.values.append({ spreadsheetId: sheetId, range:
  quoteSheetName(sheetName), valueInputOption: 'RAW', insertDataOption:
  'INSERT_ROWS', requestBody: { values: [buildAppendData(colIndex, fields)] } })`.
- `writeOrderFields(sheetId, sheetName, rowNumber, colIndex, fields)`: same
  shape as the existing `writeRow`, but building its `data` via
  `buildOrderWriteData` instead of `buildWriteData`; no-ops (like `writeRow`)
  if the resulting `data` array is empty.
- `test/sheets.test.js`'s `describe('createSheetsClient ...')` block: new
  cases for both methods against a fake `sheetsApi` (assert the exact
  `values.append`/`values.batchUpdate` call shape), mirroring the existing
  `readOrders`/`writeRow` cases immediately above them.
- Checkpoint: `npx vitest run test/sheets.test.js`.

## Step 3 — `src/http/routes/orders.js`: `POST` / `PATCH`, `GET` gains `columns`

- `createOrdersRoutes({ requireAuth, registry, sheets, config })` — add
  `config` per sequencing decision 3.
- `GET /`: after a successful read, respond `{ rows: read.rows, columns:
  Object.keys(read.colIndex) }` instead of the bare array (sequencing
  decision 4). `colIndex` already always includes every column that exists
  for that tenant's sheet (required or not), so no new logic needed beyond
  reshaping the response.
- `POST /`: resolve tenant (same as `GET`), re-read the sheet, then:
  - 400 if `phone` or `status` (trimmed) is blank.
  - 400 if `normalisePhone(phone, req.body.countryCode || countryCodeFor(tenant))`
    returns `null` (message: `invalid phone: <raw>`, matching `contacts.js`'s
    existing error-message convention).
  - `generateOrderId(new Set(read.rows.map(r => r.orderId)))`.
  - Build `fields` from `{ orderId, name, phone: normalised, amount, status
    }`, keeping only keys present in `read.colIndex` (silently drops
    `name`/`amount` if that tenant's sheet has no such column — matches the
    spec's "a tenant without an Amount column simply can't receive one").
  - `sheets.appendOrder(tenant.sheetId, tenant.sheetName, read.colIndex, fields)`,
    respond `201` with the created row (re-fetch not required — echo back
    what was written plus the generated `orderId`, `rowNumber` computed as
    `read.rows.length + 2` (header row + existing rows + the new one), blank
    `lastNotifiedStatus`/`lastError`).
  - Same 502-on-thrown-or-`{ok:false}` handling as `GET` already has, reused
    for the initial re-read.
- `PATCH /:rowNumber`: resolve tenant, re-read the sheet, find `read.rows.find(r
  => r.rowNumber === Number(req.params.rowNumber))`.
  - 404 if not found.
  - 409 if `found.orderId !== req.body.expectedOrderId` (message: `"this
    order changed, please refresh"`).
  - 400 validation for any provided `phone`/`status` exactly as in `POST`.
  - Build `fields` from only the keys actually present in `req.body` among
    `name`/`phone`/`amount`/`status` (partial update), normalising `phone` if
    provided.
  - `sheets.writeOrderFields(tenant.sheetId, tenant.sheetName, found.rowNumber,
    read.colIndex, fields)`, respond `200` with the merged row (`{ ...found,
    ...fields }`, with the just-normalised `phone` if it was provided).
- `test/http/ordersRoutes.test.js`: extend `fakeSheets` with
  `appendOrder`/`writeOrderFields` spies; new `describe('POST /api/orders')`
  and `describe('PATCH /api/orders/:rowNumber')` blocks covering: success
  (asserts the exact `fields`/`colIndex` passed to the fake), missing
  phone/status (400), invalid phone (400), unknown row (404), `orderId`
  mismatch (409), tenant-scoping identical to the existing `GET` tests
  (unauthenticated 401, non-owning tenant blocked, superadmin needs
  `?tenantId=`). Existing `GET` tests updated for the new `{ rows, columns }`
  shape.
- Checkpoint: `npx vitest run test/http/ordersRoutes.test.js`, then `npm
  test` (full backend suite, catches anything else asserting on `GET
  /api/orders`'s old bare-array shape).

## Step 4 — Dashboard UI: `OrdersTable.jsx`

- Response handling: `const { rows, columns } = await api.get('/api/orders')`
  (was a bare array).
- "New order" button opens a form (new local component or inline
  conditional block, following `ContactsPanel.jsx`'s existing inline-form
  pattern rather than introducing a separate screen) with fields filtered to
  `columns` (`name`/`amount` only rendered if present); `phone` field reuses
  `COUNTRY_CODES` from `client/src/countryCodes.js` exactly as
  `ContactsPanel.jsx` already does (a `<select>` beside the phone input,
  defaulting to `'234'`). `status` is a text `<input list="orderStatuses">`
  with a sibling `<datalist id="orderStatuses">` populated from that
  tenant's `notifyStatuses` (already available via the tenant's own config —
  check what the dashboard already has in scope; if `OrdersTable` doesn't
  currently receive the tenant object as a prop, thread it through from
  `DashboardScreen` the same way other tenant-scoped panels already get it).
- Each row gets an "Edit" action opening the same form pre-filled (Order ID
  shown, disabled); submit sends `PATCH` with `expectedOrderId` set to that
  row's current `orderId`.
- Error handling: a `409` response shows "This order was changed elsewhere —
  refreshing…" and immediately calls `fetchOrders()` again; other errors
  show inline like the existing fetch-error banner already does.
- `OrdersTable.test.jsx`: new cases — renders only fields present in
  `columns`; "New order" submits the expected `POST` payload; "Edit" submits
  a `PATCH` with `expectedOrderId`; a `409` shows the conflict message and
  triggers a re-fetch (assert `api.get` called again).
- Checkpoint: `cd client && npm test`, then `npm run build` (production
  bundle sanity check).

## Step 5 — manual smoke check

Needs a real Google Sheet + real service-account credentials in `.env` — the
current `.env` has placeholder/demo Google credentials, so this step is
blocked until real ones are available (flag to the user rather than
attempting it against fake credentials, which would just fail at the Google
auth layer, proving nothing). Once real credentials are available:

- Open the dashboard's Orders tab for a tenant with a real sheet, click "New
  order", fill in a scratch order, submit — confirm the row appears both in
  the dashboard and directly in the Google Sheet, with the service columns
  blank and a generated `ORD-...` id.
- If the order's status matches one of that tenant's `notifyStatuses`,
  confirm an SMS actually goes out on the next tick (or immediately if
  `DRY_RUN=true`, check the log).
- Edit that same order's status to a different `notifyStatus` — confirm the
  same row's `Last Notified Status` updates on the next tick, without a
  second row being created.
- Open the Sheet directly in another tab, delete that scratch row by hand,
  then try to "Edit" it from the still-open dashboard form — confirm the
  `409`/refresh behavior, not a corrupted write to whatever row now occupies
  that position.
- Clean up the scratch row afterward.

## Out of scope reminders (carried from the spec)

No delete/remove-row. No-sheets/SQLite-backed orders and any change to
`processor.js` — separate future spec. No change to `writeRow`/
`SERVICE_FIELDS` or the notification engine's own write-back path. No bulk
create/import.
