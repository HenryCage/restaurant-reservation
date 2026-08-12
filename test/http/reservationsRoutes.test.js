import { describe, it, expect, afterEach } from 'vitest';
import { startTestServer } from './helpers/testServer.js';

let ctx;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

function createTenant(ctx, id = 't1', overrides = {}) {
  const result = ctx.registry.create({
    id,
    name: 'Acme Bistro',
    active: true,
    sheetId: 'sheet-1',
    senderId: 'ACMEBOOK',
    notifyStatuses: ['Confirmed'],
    templates: { Confirmed: 'Hi {name}' },
    ...overrides,
  });
  expect(result.ok).toBe(true);
  return result.tenant;
}

function reservationBody(overrides = {}) {
  return {
    name: 'Ada',
    phone: '08012345678',
    partySize: 4,
    reservationTime: '2026-08-20T19:30',
    notes: 'Window seat',
    ...overrides,
  };
}

describe('POST /api/reservations', () => {
  it('creates a reservation, saves the contact, and sends a confirmation SMS', async () => {
    const sends = [];
    ctx = await startTestServer({
      smsSenderFactory: {
        forTenant: (tenant) => async (to, message, opts) => {
          sends.push({ tenantId: tenant.id, to, message, opts });
          return { ok: true, providerMessageId: 'sms-1' };
        },
      },
    });
    createTenant(ctx);

    const res = await fetch(`${ctx.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody()),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reservation).toMatchObject({
      tenantId: 't1',
      name: 'Ada',
      phone: '+2348012345678',
      partySize: 4,
      smsStatus: 'sent',
      providerMessageId: 'sms-1',
    });
    expect(body.sms).toEqual({ status: 'sent', error: null });
    expect(ctx.contactsStore.listContacts('t1')).toHaveLength(1);
    expect(ctx.reservationsStore.listReservations('t1')).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      tenantId: 't1',
      to: '+2348012345678',
      opts: { senderId: 'ACMEBOOK', channel: 'dnd' },
    });
    expect(sends[0].message).toContain('your reservation at Acme Bistro');
  });

  it('returns 503 when no active tenant is configured', async () => {
    ctx = await startTestServer();

    const res = await fetch(`${ctx.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody()),
    });

    expect(res.status).toBe(503);
  });

  it('requires tenantId when multiple tenants are active', async () => {
    ctx = await startTestServer();
    createTenant(ctx, 't1', { senderId: 'ACMEONE' });
    createTenant(ctx, 't2', { senderId: 'ACMETWO' });

    const missingTenant = await fetch(`${ctx.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody()),
    });
    expect(missingTenant.status).toBe(400);

    const withTenant = await fetch(`${ctx.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody({ tenantId: 't2' })),
    });
    expect(withTenant.status).toBe(201);
    expect((await withTenant.json()).reservation.tenantId).toBe('t2');
  });

  it('records dry-run SMS status without calling the sender', async () => {
    const sends = [];
    ctx = await startTestServer({
      configOverrides: { dryRun: true },
      smsSenderFactory: {
        forTenant: () => async () => {
          sends.push('called');
          return { ok: true, providerMessageId: 'should-not-be-used' };
        },
      },
    });
    createTenant(ctx);

    const res = await fetch(`${ctx.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody()),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).reservation).toMatchObject({
      smsStatus: 'dry-run',
      providerMessageId: 'dry-run',
    });
    expect(sends).toEqual([]);
  });

  it('keeps the reservation when the SMS provider fails', async () => {
    ctx = await startTestServer({
      smsSenderFactory: {
        forTenant: () => async () => ({ ok: false, error: 'provider unavailable' }),
      },
    });
    createTenant(ctx);

    const res = await fetch(`${ctx.baseUrl}/api/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody()),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reservation).toMatchObject({
      smsStatus: 'failed',
      smsError: 'provider unavailable',
    });
    expect(ctx.reservationsStore.listReservations('t1')).toHaveLength(1);
  });
});
