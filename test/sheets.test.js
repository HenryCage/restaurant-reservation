import { describe, it, expect } from 'vitest';
import {
  columnIndexToLetter,
  quoteSheetName,
  buildColumnIndex,
  parseOrders,
  buildWriteData,
  generateOrderId,
  buildAppendData,
  buildOrderWriteData,
  parseAppendedRowNumber,
  createSheetsClientFactory,
} from '../src/sheets.js';

const FULL_HEADER = [
  'Order ID',
  'Customer Name',
  'Phone',
  'Amount',
  'Status',
  'Last Notified Status',
  'Notified At',
  'Last Error',
];

describe('columnIndexToLetter', () => {
  it('maps indices to A1 letters', () => {
    expect(columnIndexToLetter(0)).toBe('A');
    expect(columnIndexToLetter(5)).toBe('F');
    expect(columnIndexToLetter(25)).toBe('Z');
    expect(columnIndexToLetter(26)).toBe('AA');
    expect(columnIndexToLetter(27)).toBe('AB');
  });
});

describe('quoteSheetName', () => {
  it('leaves simple names unquoted and quotes names with spaces', () => {
    expect(quoteSheetName('Orders')).toBe('Orders');
    expect(quoteSheetName('My Orders')).toBe("'My Orders'");
    expect(quoteSheetName("Ade's Orders")).toBe("'Ade''s Orders'");
  });
});

describe('buildColumnIndex', () => {
  it('maps headers case/space-insensitively', () => {
    const out = buildColumnIndex(['  order id ', 'PHONE', 'status', 'last notified status', 'notified at', 'last error']);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.colIndex.orderId).toBe(0);
      expect(out.colIndex.phone).toBe(1);
      expect(out.colIndex.lastError).toBe(5);
    }
  });

  it('reports missing required headers', () => {
    const out = buildColumnIndex(['Order ID', 'Phone']); // missing Status + service columns
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/missing required header/);
  });

  it('reports duplicate required headers', () => {
    const out = buildColumnIndex([...FULL_HEADER, 'Status']);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/duplicate header/);
  });

  it('ignores unrelated duplicate columns', () => {
    const out = buildColumnIndex([...FULL_HEADER, 'Notes', 'Notes']);
    expect(out.ok).toBe(true);
  });
});

describe('parseOrders — header-driven mapping survives reordering/insertion', () => {
  it('maps the right cells when columns are reordered and a column is inserted', () => {
    const values = [
      ['Notes', 'Phone', 'Order ID', 'Status', 'Customer Name', 'Amount', 'Last Error', 'Notified At', 'Last Notified Status'],
      ['ignore me', '08012345678', '1234', 'Out for delivery', 'Chidi', '15000', 'timeout', '', ''],
    ];
    const out = parseOrders(values);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows).toHaveLength(1);
      const r = out.rows[0];
      expect(r.rowNumber).toBe(2);
      expect(r.orderId).toBe('1234');
      expect(r.phone).toBe('08012345678');
      expect(r.status).toBe('Out for delivery');
      expect(r.name).toBe('Chidi');
      expect(r.amount).toBe('15000');
      expect(r.lastNotifiedStatus).toBe('');
      expect(r.lastError).toBe('timeout');
    }
  });

  it('skips rows missing Order ID / Phone / Status and tolerates ragged rows', () => {
    const values = [
      FULL_HEADER,
      ['1', 'Chidi', '08012345678', '15000', 'Out for delivery'], // ragged: no service cells -> ''
      ['', 'NoOrder', '08012345678', '', 'Out for delivery'], // missing orderId -> skip
      ['3', 'NoPhone', '', '', 'Out for delivery'], // missing phone -> skip
      ['4', 'NoStatus', '08012345678', '', ''], // missing status -> skip
    ];
    const out = parseOrders(values);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows.map((r) => r.orderId)).toEqual(['1']);
      expect(out.rows[0].lastNotifiedStatus).toBe('');
    }
  });

  it('fails on an empty sheet', () => {
    expect(parseOrders([]).ok).toBe(false);
  });
});

describe('buildWriteData', () => {
  it('builds cell-scoped ranges for the provided service fields only', () => {
    const colIndex = { lastNotifiedStatus: 5, notifiedAt: 6, lastError: 7 };
    const data = buildWriteData('Orders', 2, colIndex, {
      lastNotifiedStatus: 'out for delivery',
      notifiedAt: '2026-06-30T00:00:00.000Z',
      lastError: '',
    });
    expect(data).toEqual([
      { range: 'Orders!F2', values: [['out for delivery']] },
      { range: 'Orders!G2', values: [['2026-06-30T00:00:00.000Z']] },
      { range: 'Orders!H2', values: [['']] },
    ]);
  });

  it('only writes fields that are present', () => {
    const colIndex = { lastNotifiedStatus: 5, notifiedAt: 6, lastError: 7 };
    const data = buildWriteData('Orders', 9, colIndex, { lastError: 'boom' });
    expect(data).toEqual([{ range: 'Orders!H9', values: [['boom']] }]);
  });
});

describe('generateOrderId', () => {
  const FIXED_NOW = () => new Date('2026-07-20T12:00:00.000Z');

  it('formats as ORD-YYYYMMDD-XXXX using the injected suffix', () => {
    const id = generateOrderId(new Set(), { now: FIXED_NOW, randomSuffix: () => 'AB12' });
    expect(id).toBe('ORD-20260720-AB12');
  });

  it('retries past a collision against existingIds', () => {
    const suffixes = ['AB12', 'AB12', 'CD34'];
    const randomSuffix = () => suffixes.shift();
    const id = generateOrderId(new Set(['ORD-20260720-AB12']), { now: FIXED_NOW, randomSuffix });
    expect(id).toBe('ORD-20260720-CD34');
  });

  it('accepts a plain array for existingIds and still checks collisions against it', () => {
    const suffixes = ['AB12', 'CD34'];
    const randomSuffix = () => suffixes.shift();
    const id = generateOrderId(['ORD-20260720-AB12'], { now: FIXED_NOW, randomSuffix });
    expect(id).toBe('ORD-20260720-CD34');
  });

  it('throws after exhausting retries against a pathological always-colliding suffix', () => {
    expect(() =>
      generateOrderId(new Set(['ORD-20260720-AB12']), { now: FIXED_NOW, randomSuffix: () => 'AB12' }),
    ).toThrow(/failed to generate/);
  });
});

describe('buildAppendData', () => {
  it('places each field at its mapped column, blank elsewhere', () => {
    const colIndex = { orderId: 0, name: 1, phone: 2, amount: 3, status: 4 };
    const row = buildAppendData(colIndex, { orderId: 'ORD-1', phone: '+2348012345678', status: 'Processing' });
    expect(row).toEqual(['ORD-1', '', '+2348012345678', '', 'Processing']);
  });

  it('ignores a fields key with no matching colIndex entry', () => {
    const colIndex = { orderId: 0, phone: 1, status: 2 }; // no "amount" column for this tenant
    const row = buildAppendData(colIndex, { orderId: 'ORD-1', phone: '123', status: 'New', amount: '5000' });
    expect(row).toEqual(['ORD-1', '123', 'New']);
  });

  it('returns an empty array for an empty colIndex', () => {
    expect(buildAppendData({}, { orderId: 'ORD-1' })).toEqual([]);
  });
});

describe('buildOrderWriteData', () => {
  it('builds cell-scoped ranges for any provided order field', () => {
    const colIndex = { orderId: 0, name: 1, phone: 2, amount: 3, status: 4 };
    const data = buildOrderWriteData('Orders', 5, colIndex, { name: 'Ada', status: 'Delivered' });
    expect(data).toEqual([
      { range: 'Orders!B5', values: [['Ada']] },
      { range: 'Orders!E5', values: [['Delivered']] },
    ]);
  });

  it('skips a field whose column does not exist for this tenant', () => {
    const colIndex = { orderId: 0, phone: 1, status: 2 }; // no "amount" column
    const data = buildOrderWriteData('Orders', 3, colIndex, { amount: '9999', status: 'Cancelled' });
    expect(data).toEqual([{ range: 'Orders!C3', values: [['Cancelled']] }]);
  });
});

describe('parseAppendedRowNumber', () => {
  it('extracts the row number from a plain sheet name range', () => {
    expect(parseAppendedRowNumber('Orders!A5:E5')).toBe(5);
  });

  it('extracts the row number from a quoted sheet name range', () => {
    expect(parseAppendedRowNumber("'My Orders'!A12:E12")).toBe(12);
  });

  it('returns null for an unrecognisable value', () => {
    expect(parseAppendedRowNumber(undefined)).toBeNull();
    expect(parseAppendedRowNumber('')).toBeNull();
  });
});

describe('createSheetsClientFactory (with injected sheetsApi)', () => {
  // A fake sheetsApi (deps.sheetsApi) short-circuits the real JWT/googleapis
  // construction entirely, so the tenant's actual credential field values
  // are never read in these tests -- any non-empty placeholder works.
  const FAKE_TENANT = { googleServiceAccountEmail: 'sa@example.iam.gserviceaccount.com', googlePrivateKey: 'fake' };

  function fakeApi(values, { appendedRange = 'Orders!A2:E2' } = {}) {
    const calls = { get: [], batchUpdate: [], append: [] };
    const api = {
      spreadsheets: {
        values: {
          get: async (p) => {
            calls.get.push(p);
            return { data: { values } };
          },
          batchUpdate: async (p) => {
            calls.batchUpdate.push(p);
            return { data: {} };
          },
          append: async (p) => {
            calls.append.push(p);
            return { data: { updates: { updatedRange: appendedRange } } };
          },
        },
      },
    };
    return { api, calls };
  }

  it('readOrders fetches with FORMATTED_VALUE and parses', async () => {
    const { api, calls } = fakeApi([FULL_HEADER, ['1', 'Chidi', '08012345678', '15000', 'Out for delivery', '', '', '']]);
    const client = createSheetsClientFactory({ sheetsApi: api }).forTenant(FAKE_TENANT);
    const out = await client.readOrders('sheet-1', 'Orders');
    expect(out.ok).toBe(true);
    expect(calls.get[0].valueRenderOption).toBe('FORMATTED_VALUE');
    expect(calls.get[0].range).toBe('Orders');
  });

  it('writeRow issues a single batchUpdate of the service cells', async () => {
    const { api, calls } = fakeApi([FULL_HEADER]);
    const client = createSheetsClientFactory({ sheetsApi: api }).forTenant(FAKE_TENANT);
    await client.writeRow('sheet-1', 'Orders', 2, { lastNotifiedStatus: 5, notifiedAt: 6, lastError: 7 }, {
      lastNotifiedStatus: 'delivered',
      notifiedAt: 'T',
      lastError: '',
    });
    expect(calls.batchUpdate).toHaveLength(1);
    expect(calls.batchUpdate[0].requestBody.valueInputOption).toBe('RAW');
    expect(calls.batchUpdate[0].requestBody.data).toHaveLength(3);
  });

  it('appendOrder issues a single values.append with the row placed by colIndex, and returns the actual inserted row number', async () => {
    const { api, calls } = fakeApi([FULL_HEADER], { appendedRange: 'Orders!A9:E9' });
    const client = createSheetsClientFactory({ sheetsApi: api }).forTenant(FAKE_TENANT);
    const colIndex = { orderId: 0, name: 1, phone: 2, amount: 3, status: 4 };
    const result = await client.appendOrder('sheet-1', 'Orders', colIndex, {
      orderId: 'ORD-20260720-AB12',
      name: 'Ada',
      phone: '+2348012345678',
      status: 'Processing',
    });
    expect(calls.append).toHaveLength(1);
    expect(calls.append[0].spreadsheetId).toBe('sheet-1');
    expect(calls.append[0].range).toBe('Orders');
    expect(calls.append[0].insertDataOption).toBe('INSERT_ROWS');
    expect(calls.append[0].requestBody.values).toEqual([
      ['ORD-20260720-AB12', 'Ada', '+2348012345678', '', 'Processing'],
    ]);
    expect(result).toEqual({ rowNumber: 9 }); // real inserted position, not guessed from row count
  });

  it('writeOrderFields issues a single batchUpdate for the provided order fields', async () => {
    const { api, calls } = fakeApi([FULL_HEADER]);
    const client = createSheetsClientFactory({ sheetsApi: api }).forTenant(FAKE_TENANT);
    const colIndex = { orderId: 0, name: 1, phone: 2, amount: 3, status: 4 };
    await client.writeOrderFields('sheet-1', 'Orders', 3, colIndex, { status: 'Delivered' });
    expect(calls.batchUpdate).toHaveLength(1);
    expect(calls.batchUpdate[0].requestBody.data).toEqual([{ range: 'Orders!E3', values: [['Delivered']] }]);
  });

  it('writeOrderFields is a no-op when no field matches an existing column', async () => {
    const { api, calls } = fakeApi([FULL_HEADER]);
    const client = createSheetsClientFactory({ sheetsApi: api }).forTenant(FAKE_TENANT);
    await client.writeOrderFields('sheet-1', 'Orders', 3, { orderId: 0 }, { amount: '9999' });
    expect(calls.batchUpdate).toHaveLength(0);
  });
});
