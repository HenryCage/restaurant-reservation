import { describe, it, expect } from 'vitest';
import { createProcessor } from '../src/processor.js';
import { validateRegistry } from '../src/tenants.js';

// --- helpers ---------------------------------------------------------------

function silentLogger() {
  const l = { error() {}, warn() {}, info() {}, debug() {}, child: () => l };
  return l;
}

function baseConfig(over = {}) {
  return {
    defaultCountryCode: '234',
    maxSendsPerTenantPerTick: 50,
    dryRun: false,
    sendDelayMs: 0,
    effectiveGlobalTestNumber: '',
    ...over,
  };
}

function buildTenants(raw) {
  return validateRegistry({ tenants: raw }, silentLogger());
}

function rawTenant(over = {}) {
  return {
    id: 'a',
    name: 'A',
    active: true,
    sheetId: 'sheetA',
    sheetName: 'Orders',
    senderId: 'Aaa1',
    channel: 'dnd',
    notifyStatuses: ['Out for delivery'],
    templates: { 'Out for delivery': 'A {orderId}' },
    testNumber: '',
    ...over,
  };
}

function orderRow(over = {}) {
  return {
    rowNumber: 2,
    orderId: '1',
    name: 'Chidi',
    phone: '08012345678',
    amount: '15000',
    status: 'Out for delivery',
    lastNotifiedStatus: '',
    ...over,
  };
}

const COL_INDEX = { lastNotifiedStatus: 5, notifiedAt: 6, lastError: 7 };

/** sheetMap: { sheetId: { rows } } or { sheetId: () => result | throws }. */
function makeSheets(sheetMap) {
  const writes = [];
  const reads = [];
  return {
    writes,
    reads,
    client: {
      async readOrders(sheetId, sheetName) {
        reads.push({ sheetId, sheetName });
        const entry = sheetMap[sheetId];
        if (typeof entry === 'function') return entry();
        return { ok: true, colIndex: COL_INDEX, rows: entry?.rows ?? [] };
      },
      async writeRow(sheetId, sheetName, rowNumber, colIndex, fields) {
        writes.push({ sheetId, rowNumber, fields });
      },
    },
  };
}

function makeSendSms(impl) {
  const calls = [];
  const fn = async (to, message, opts) => {
    calls.push({ to, message, opts });
    return impl ? impl(calls.length, { to, message, opts }) : { ok: true, providerMessageId: 'm' + calls.length };
  };
  fn.calls = calls;
  return fn;
}

const FIXED_NOW = () => new Date('2026-06-30T12:00:00.000Z');

// --- tests -----------------------------------------------------------------

describe('processor — multi-tenant isolation & routing', () => {
  it('uses each tenant\'s own sheet, sender ID and template', async () => {
    const tenants = buildTenants([
      rawTenant({ id: 'a', sheetId: 'sheetA', senderId: 'Aaa1', notifyStatuses: ['Out for delivery'], templates: { 'Out for delivery': 'A {orderId}' } }),
      rawTenant({ id: 'b', sheetId: 'sheetB', senderId: 'Bbb2', notifyStatuses: ['Delivered'], templates: { Delivered: 'B {orderId}' } }),
    ]);
    const sheets = makeSheets({
      sheetA: { rows: [orderRow({ orderId: '1', status: 'Out for delivery' })] },
      sheetB: { rows: [orderRow({ orderId: '2', status: 'Delivered' })] },
    });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();

    expect(sendSms.calls).toHaveLength(2);
    const a = sendSms.calls.find((c) => c.opts.senderId === 'Aaa1');
    const b = sendSms.calls.find((c) => c.opts.senderId === 'Bbb2');
    expect(a.message).toBe('A 1');
    expect(b.message).toBe('B 2');
  });

  it('isolates one tenant\'s read crash from the other', async () => {
    const tenants = buildTenants([
      rawTenant({ id: 'a', sheetId: 'sheetA' }),
      rawTenant({ id: 'b', sheetId: 'sheetB', senderId: 'Bbb2' }),
    ]);
    const sheets = makeSheets({
      sheetA: () => {
        throw new Error('sheet read exploded');
      },
      sheetB: { rows: [orderRow({ orderId: '2' })] },
    });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    const out = await processor.run();
    expect(out.skipped).toBe(false);
    expect(sendSms.calls).toHaveLength(1);
    expect(sendSms.calls[0].opts.senderId).toBe('Bbb2');
  });
});

describe('processor — idempotency', () => {
  it('does not resend when status equals last notified status (case/space insensitive)', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({
      sheetA: { rows: [orderRow({ status: 'Out for delivery ', lastNotifiedStatus: 'out for delivery' })] },
    });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sendSms.calls).toHaveLength(0);
    expect(sheets.writes).toHaveLength(0);
  });

  it('marks the row with canonical status + UTC timestamp + empty error on success', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sheets.writes).toHaveLength(1);
    expect(sheets.writes[0].fields).toEqual({
      lastNotifiedStatus: 'out for delivery',
      notifiedAt: '2026-06-30T12:00:00.000Z',
      lastError: '',
    });
  });
});

describe('processor — transient vs permanent failure', () => {
  it('leaves last notified status unchanged on a transient failure (will retry)', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms(() => ({ ok: false, permanent: false, error: 'network down' }));
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sheets.writes).toHaveLength(1);
    expect(sheets.writes[0].fields).toEqual({ lastError: 'network down' });
    expect(sheets.writes[0].fields).not.toHaveProperty('lastNotifiedStatus');
    expect(sheets.writes[0].fields).not.toHaveProperty('notifiedAt');
  });

  it('gives up on a permanent failure by marking the status (un-parks on status change)', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms(() => ({ ok: false, permanent: true, error: 'invalid sender id' }));
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sheets.writes[0].fields).toEqual({ lastNotifiedStatus: 'out for delivery', lastError: 'invalid sender id' });
    expect(sheets.writes[0].fields).not.toHaveProperty('notifiedAt');
  });
});

describe('processor — onNotified hook', () => {
  it('calls onNotified with (tenant, {name, phone}) on a successful send', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms();
    const calls = [];
    const onNotified = (tenant, contact) => calls.push({ tenant, contact });
    const processor = createProcessor({
      config: baseConfig(),
      logger: silentLogger(),
      registry: { load: () => tenants },
      sheets: sheets.client,
      sendSms,
      onNotified,
      now: FIXED_NOW,
    });

    await processor.run();
    expect(calls).toHaveLength(1);
    expect(calls[0].tenant.id).toBe('a');
    expect(calls[0].contact).toEqual({ name: 'Chidi', phone: '+2348012345678' });
  });

  it('is not called on a transient failure', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms(() => ({ ok: false, permanent: false, error: 'network down' }));
    let callCount = 0;
    const onNotified = () => callCount++;
    const processor = createProcessor({
      config: baseConfig(),
      logger: silentLogger(),
      registry: { load: () => tenants },
      sheets: sheets.client,
      sendSms,
      onNotified,
      now: FIXED_NOW,
    });

    await processor.run();
    expect(callCount).toBe(0);
  });

  it('is not called on a permanent failure', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms(() => ({ ok: false, permanent: true, error: 'invalid sender id' }));
    let callCount = 0;
    const onNotified = () => callCount++;
    const processor = createProcessor({
      config: baseConfig(),
      logger: silentLogger(),
      registry: { load: () => tenants },
      sheets: sheets.client,
      sendSms,
      onNotified,
      now: FIXED_NOW,
    });

    await processor.run();
    expect(callCount).toBe(0);
  });

  it('is not called during DRY_RUN', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms();
    let callCount = 0;
    const onNotified = () => callCount++;
    const processor = createProcessor({
      config: baseConfig({ dryRun: true }),
      logger: silentLogger(),
      registry: { load: () => tenants },
      sheets: sheets.client,
      sendSms,
      onNotified,
      now: FIXED_NOW,
    });

    await processor.run();
    expect(callCount).toBe(0);
  });

  it('a throwing onNotified does not fail the row (write-back and summary still happen)', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms();
    const onNotified = () => {
      throw new Error('contacts db is down');
    };
    const processor = createProcessor({
      config: baseConfig(),
      logger: silentLogger(),
      registry: { load: () => tenants },
      sheets: sheets.client,
      sendSms,
      onNotified,
      now: FIXED_NOW,
    });

    const { summaries } = await processor.run();
    expect(summaries[0].sentOk).toBe(1);
    expect(sheets.writes).toHaveLength(1);
    expect(sheets.writes[0].fields.lastNotifiedStatus).toBe('out for delivery');
  });

  it('omitting onNotified entirely leaves behavior unchanged', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms();
    const processor = createProcessor({
      config: baseConfig(),
      logger: silentLogger(),
      registry: { load: () => tenants },
      sheets: sheets.client,
      sendSms,
      now: FIXED_NOW,
    });

    const { summaries } = await processor.run();
    expect(summaries[0].sentOk).toBe(1);
  });
});

describe('processor — guardrails & robustness', () => {
  it('caps sends per tenant per tick and defers the rest', async () => {
    const tenants = buildTenants([rawTenant()]);
    const rows = Array.from({ length: 5 }, (_, i) => orderRow({ rowNumber: i + 2, orderId: String(i + 1) }));
    const sheets = makeSheets({ sheetA: { rows } });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig({ maxSendsPerTenantPerTick: 2 }), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    const out = await processor.run();
    expect(sendSms.calls).toHaveLength(2);
    expect(out.summaries[0].capped).toBe(true);
  });

  it('persists an earlier success even if a later row throws unexpectedly', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({
      sheetA: { rows: [orderRow({ rowNumber: 2, orderId: '1' }), orderRow({ rowNumber: 3, orderId: '2' })] },
    });
    const sendSms = makeSendSms((n) => {
      if (n === 2) throw new Error('boom on row 2');
      return { ok: true, providerMessageId: 'ok1' };
    });
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sendSms.calls).toHaveLength(2);
    expect(sheets.writes).toHaveLength(1);
    expect(sheets.writes[0].rowNumber).toBe(2);
  });

  it('skips and counts invalid phone numbers without sending', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow({ phone: 'not-a-number' })] } });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    const out = await processor.run();
    expect(sendSms.calls).toHaveLength(0);
    expect(out.summaries[0].invalidPhone).toBe(1);
  });

  it('skips-and-logs a tenant whose sheet fails to parse', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: () => ({ ok: false, error: 'missing required header(s): Status' }) });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sendSms.calls).toHaveLength(0);
  });
});

describe('processor — DRY_RUN and test-number override', () => {
  it('DRY_RUN marks the row but never calls the gateway', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig({ dryRun: true }), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sendSms.calls).toHaveLength(0);
    expect(sheets.writes).toHaveLength(1);
    expect(sheets.writes[0].fields.lastNotifiedStatus).toBe('out for delivery');
  });

  it('redirects to the effective global test number', async () => {
    const tenants = buildTenants([rawTenant()]);
    const sheets = makeSheets({ sheetA: { rows: [orderRow()] } });
    const sendSms = makeSendSms();
    const processor = createProcessor({ config: baseConfig({ effectiveGlobalTestNumber: '+2348000000000' }), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms, now: FIXED_NOW });

    await processor.run();
    expect(sendSms.calls[0].to).toBe('+2348000000000');
  });
});

describe('processor — single-flight', () => {
  it('skips a tick while a previous tick is still running', async () => {
    const tenants = buildTenants([rawTenant()]);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const sheets = {
      writes: [],
      client: {
        async readOrders() {
          await gate;
          return { ok: true, colIndex: COL_INDEX, rows: [] };
        },
        async writeRow() {},
      },
    };
    const processor = createProcessor({ config: baseConfig(), logger: silentLogger(), registry: { load: () => tenants }, sheets: sheets.client, sendSms: makeSendSms(), now: FIXED_NOW });

    const first = processor.run(); // hangs at readOrders
    const second = await processor.run(); // should be skipped
    expect(second.skipped).toBe(true);
    release();
    await first;
  });
});
