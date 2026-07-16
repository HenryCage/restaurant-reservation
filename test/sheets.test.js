import { describe, it, expect } from 'vitest';
import {
  columnIndexToLetter,
  quoteSheetName,
  buildColumnIndex,
  parseOrders,
  buildWriteData,
  createSheetsClient,
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

describe('createSheetsClient (with injected sheetsApi)', () => {
  function fakeApi(values) {
    const calls = { get: [], batchUpdate: [] };
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
        },
      },
    };
    return { api, calls };
  }

  it('readOrders fetches with FORMATTED_VALUE and parses', async () => {
    const { api, calls } = fakeApi([FULL_HEADER, ['1', 'Chidi', '08012345678', '15000', 'Out for delivery', '', '', '']]);
    const client = createSheetsClient({}, { sheetsApi: api });
    const out = await client.readOrders('sheet-1', 'Orders');
    expect(out.ok).toBe(true);
    expect(calls.get[0].valueRenderOption).toBe('FORMATTED_VALUE');
    expect(calls.get[0].range).toBe('Orders');
  });

  it('writeRow issues a single batchUpdate of the service cells', async () => {
    const { api, calls } = fakeApi([FULL_HEADER]);
    const client = createSheetsClient({}, { sheetsApi: api });
    await client.writeRow('sheet-1', 'Orders', 2, { lastNotifiedStatus: 5, notifiedAt: 6, lastError: 7 }, {
      lastNotifiedStatus: 'delivered',
      notifiedAt: 'T',
      lastError: '',
    });
    expect(calls.batchUpdate).toHaveLength(1);
    expect(calls.batchUpdate[0].requestBody.valueInputOption).toBe('RAW');
    expect(calls.batchUpdate[0].requestBody.data).toHaveLength(3);
  });
});
