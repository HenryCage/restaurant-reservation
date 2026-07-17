import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { createContactsStore } from '../src/contacts.js';
import { createCampaignsStore } from '../src/campaigns.js';

function makeStore() {
  const db = createDb(':memory:');
  return createContactsStore(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
}

describe('createContactsStore', () => {
  describe('createContact', () => {
    it('normalises the phone before storing', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Ada', phone: '08012345678' });
      expect(c.phone).toBe('+2348012345678');
      expect(c.tenantId).toBe('t1');
      expect(c.tags).toEqual([]);
    });

    it('rejects an invalid phone', () => {
      const store = makeStore();
      expect(() => store.createContact('t1', { name: 'Ada', phone: 'not-a-phone' })).toThrow(/invalid phone/);
    });

    it('rejects a duplicate (tenant, phone) with a clear error', () => {
      const store = makeStore();
      store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      expect(() => store.createContact('t1', { name: 'Ada 2', phone: '+2348012345678' })).toThrow(
        /already exists/,
      );
    });

    it('does not leak the duplicate check across tenants', () => {
      const store = makeStore();
      store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const c = store.createContact('t2', { name: 'Ada', phone: '+2348012345678' });
      expect(c.tenantId).toBe('t2');
    });

    it('uses the per-call countryCode override instead of the store default', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Rimas', phone: '60012345', countryCode: '370' });
      expect(c.phone).toBe('+37060012345');
    });

    it('accepts a "+"-prefixed number regardless of countryCode -- its own prefix is trusted', () => {
      // phone.js's isValidE164 judges a "+"-prefixed number purely by its own
      // embedded country, never against any default/override -- so this
      // passes identically whether countryCode is given, omitted, or even
      // set to something else entirely (a stale/wrong selection in the UI
      // can't make an otherwise-valid international number get rejected).
      const store = makeStore();
      const withOverride = store.createContact('t1', { name: 'Rimas', phone: '+37060012345', countryCode: '370' });
      expect(withOverride.phone).toBe('+37060012345');

      const withoutOverride = store.createContact('t2', { name: 'Rimas 2', phone: '+37060012345' });
      expect(withoutOverride.phone).toBe('+37060012345');
    });

    it('falls back to the store default when countryCode is omitted', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Ada', phone: '08012345678' });
      expect(c.phone).toBe('+2348012345678');
    });
  });

  describe('upsertContact', () => {
    it('inserts a new contact', () => {
      const store = makeStore();
      const c = store.upsertContact('t1', { name: 'Ada', phone: '+2348012345678' });
      expect(c).toMatchObject({ tenantId: 't1', name: 'Ada', phone: '+2348012345678' });
    });

    it('updates the name in place on an existing phone, keeping the same id', () => {
      const store = makeStore();
      const first = store.upsertContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const second = store.upsertContact('t1', { name: 'Ada Lovelace', phone: '+2348012345678' });
      expect(second.id).toBe(first.id);
      expect(second.name).toBe('Ada Lovelace');
      expect(store.listContacts('t1')).toHaveLength(1);
    });

    it('scopes the same phone as separate rows under different tenants', () => {
      const store = makeStore();
      store.upsertContact('t1', { name: 'Ada', phone: '+2348012345678' });
      store.upsertContact('t2', { name: 'Bola', phone: '+2348012345678' });
      expect(store.listContacts('t1')).toHaveLength(1);
      expect(store.listContacts('t2')).toHaveLength(1);
    });

    it('returns null for an invalid phone instead of throwing', () => {
      const store = makeStore();
      expect(store.upsertContact('t1', { name: 'Ada', phone: 'nope' })).toBeNull();
    });
  });

  describe('listContacts', () => {
    it('returns only the requesting tenant rows', () => {
      const store = makeStore();
      store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      store.createContact('t2', { name: 'Bola', phone: '+2348023456789' });
      const list = store.listContacts('t1');
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Ada');
    });
  });

  describe('updateContact', () => {
    it('updates only the given fields, leaving the rest untouched', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Ada', phone: '+2348012345678', tags: ['vip'] });
      const updated = store.updateContact('t1', c.id, { name: 'Ada Lovelace' });
      expect(updated).toMatchObject({ name: 'Ada Lovelace', phone: '+2348012345678', tags: ['vip'] });
    });

    it('re-normalises and validates a new phone', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const updated = store.updateContact('t1', c.id, { phone: '60012345', countryCode: '370' });
      expect(updated.phone).toBe('+37060012345');
    });

    it('rejects an invalid new phone', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      expect(() => store.updateContact('t1', c.id, { phone: 'not-a-phone' })).toThrow(/invalid phone/);
    });

    it('rejects a new phone that collides with another contact in the same tenant', () => {
      const store = makeStore();
      store.createContact('t1', { name: 'Bola', phone: '+2348023456789' });
      const ada = store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      expect(() => store.updateContact('t1', ada.id, { phone: '+2348023456789' })).toThrow(/already exists/);
    });

    it('allows re-saving the same phone unchanged (no false collision with itself)', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const updated = store.updateContact('t1', c.id, { phone: '+2348012345678', name: 'Ada 2' });
      expect(updated.name).toBe('Ada 2');
    });

    it('throws when the contact does not exist for this tenant', () => {
      const store = makeStore();
      expect(() => store.updateContact('t1', 'nonexistent', { name: 'x' })).toThrow(/not found/);
    });

    it('does not leak across tenants', () => {
      const store = makeStore();
      const c = store.createContact('t2', { name: 'Bola', phone: '+2348023456789' });
      expect(() => store.updateContact('t1', c.id, { name: 'x' })).toThrow(/not found/);
    });
  });

  describe('deleteContact', () => {
    it('deletes an existing contact and returns true', () => {
      const store = makeStore();
      const c = store.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      expect(store.deleteContact('t1', c.id)).toBe(true);
      expect(store.listContacts('t1')).toHaveLength(0);
    });

    it('returns false for a nonexistent contact', () => {
      const store = makeStore();
      expect(store.deleteContact('t1', 'nonexistent')).toBe(false);
    });

    it('does not delete across tenants', () => {
      const store = makeStore();
      const c = store.createContact('t2', { name: 'Bola', phone: '+2348023456789' });
      expect(store.deleteContact('t1', c.id)).toBe(false);
      expect(store.listContacts('t2')).toHaveLength(1);
    });

    it('refuses to delete a contact with existing campaign history, with a clear error', () => {
      // better-sqlite3 enforces campaign_recipients.contact_id's FK by
      // default -- a contact that was ever targeted by a campaign can't be
      // hard-deleted, since its send history must survive. Needs a shared db
      // (not makeStore()'s isolated one) so a campaigns store can reference it.
      const db = createDb(':memory:');
      const contacts = createContactsStore(db);
      const campaigns = createCampaignsStore(db);
      const ada = contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.ensureRecipients(c.id, 't1', 'all');

      expect(() => contacts.deleteContact('t1', ada.id)).toThrow(/existing campaign history/);
      expect(contacts.listContacts('t1')).toHaveLength(1); // not deleted
    });
  });
});
