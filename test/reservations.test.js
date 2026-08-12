import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { createContactsStore } from '../src/contacts.js';
import { createReservationsStore } from '../src/reservations.js';

function makeStores() {
  const db = createDb(':memory:');
  return {
    contactsStore: createContactsStore(db, { now: () => new Date('2026-01-01T00:00:00.000Z') }),
    reservationsStore: createReservationsStore(db, { now: () => new Date('2026-01-01T00:00:00.000Z') }),
  };
}

describe('createReservationsStore', () => {
  it('creates and lists reservations for one tenant', () => {
    const { contactsStore, reservationsStore } = makeStores();
    const contact = contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });

    const reservation = reservationsStore.createReservation('t1', {
      contactId: contact.id,
      name: 'Ada',
      phone: contact.phone,
      partySize: 4,
      reservationTime: '2026-08-20T19:30',
      notes: 'Window seat',
    });

    expect(reservation).toMatchObject({
      tenantId: 't1',
      contactId: contact.id,
      name: 'Ada',
      phone: '+2348012345678',
      partySize: 4,
      notes: 'Window seat',
      smsStatus: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(reservationsStore.listReservations('t1')).toHaveLength(1);
    expect(reservationsStore.listReservations('t2')).toHaveLength(0);
  });

  it('rejects incomplete reservation details', () => {
    const { contactsStore, reservationsStore } = makeStores();
    const contact = contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });

    expect(() =>
      reservationsStore.createReservation('t1', {
        contactId: contact.id,
        name: '',
        phone: contact.phone,
        partySize: 4,
        reservationTime: '2026-08-20T19:30',
      }),
    ).toThrow(/name is required/);

    expect(() =>
      reservationsStore.createReservation('t1', {
        contactId: contact.id,
        name: 'Ada',
        phone: contact.phone,
        partySize: 0,
        reservationTime: '2026-08-20T19:30',
      }),
    ).toThrow(/partySize/);

    expect(() =>
      reservationsStore.createReservation('t1', {
        contactId: contact.id,
        name: 'Ada',
        phone: contact.phone,
        partySize: 4,
        reservationTime: 'not-a-date',
      }),
    ).toThrow(/reservationTime/);
  });

  it('records the SMS outcome on the reservation', () => {
    const { contactsStore, reservationsStore } = makeStores();
    const contact = contactsStore.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    const reservation = reservationsStore.createReservation('t1', {
      contactId: contact.id,
      name: 'Ada',
      phone: contact.phone,
      partySize: 2,
      reservationTime: '2026-08-20T19:30',
    });

    const updated = reservationsStore.recordSmsResult('t1', reservation.id, {
      status: 'sent',
      providerMessageId: 'sms-1',
    });

    expect(updated).toMatchObject({ smsStatus: 'sent', providerMessageId: 'sms-1', smsError: null });
  });
});
