import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { createContactsStore } from '../src/contacts.js';
import { createCampaignsStore } from '../src/campaigns.js';

function makeStores(now = () => new Date('2026-01-01T00:00:00.000Z')) {
  const db = createDb(':memory:');
  const contacts = createContactsStore(db, { now });
  const campaigns = createCampaignsStore(db, { now });
  return { db, contacts, campaigns };
}

describe('createCampaignsStore', () => {
  describe('createCampaign', () => {
    it('creates a pending sms campaign targeting "all"', () => {
      const { campaigns } = makeStores();
      const c = campaigns.createCampaign('t1', {
        name: 'Promo',
        message: 'hello there',
        sendTo: 'all',
        scheduledTime: '2026-01-02T00:00:00.000Z',
      });
      expect(c).toMatchObject({ tenantId: 't1', type: 'sms', status: 'pending', sendTo: 'all' });
    });

    it('rejects a sendTo that is not a known contact for the tenant', () => {
      const { campaigns } = makeStores();
      expect(() =>
        campaigns.createCampaign('t1', {
          name: 'Promo',
          message: 'hi',
          sendTo: 'nonexistent-id',
          scheduledTime: '2026-01-02T00:00:00.000Z',
        }),
      ).toThrow(/not a known contact/);
    });

    it('rejects a contact that belongs to a different tenant', () => {
      const { contacts, campaigns } = makeStores();
      const other = contacts.createContact('t2', { name: 'Bola', phone: '+2348023456789' });
      expect(() =>
        campaigns.createCampaign('t1', {
          name: 'Promo',
          message: 'hi',
          sendTo: other.id,
          scheduledTime: '2026-01-02T00:00:00.000Z',
        }),
      ).toThrow(/not a known contact/);
    });

    it('rejects an empty message and an invalid scheduledTime', () => {
      const { campaigns } = makeStores();
      expect(() =>
        campaigns.createCampaign('t1', { name: 'Promo', message: '   ', sendTo: 'all', scheduledTime: '2026-01-02T00:00:00.000Z' }),
      ).toThrow(/message/);
      expect(() =>
        campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: 'not-a-date' }),
      ).toThrow(/scheduledTime/);
    });
  });

  describe('listDueCampaigns', () => {
    it('returns only pending/processing campaigns whose time has passed', () => {
      const { campaigns } = makeStores();
      campaigns.createCampaign('t1', { name: 'Past', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.createCampaign('t1', { name: 'Future', message: 'hi', sendTo: 'all', scheduledTime: '2099-01-01T00:00:00.000Z' });

      const due = campaigns.listDueCampaigns(new Date('2026-01-01T00:00:00.000Z'));
      expect(due).toHaveLength(1);
      expect(due[0].name).toBe('Past');
    });
  });

  describe('listCampaigns', () => {
    it('returns only the requesting tenant campaigns, newest first', () => {
      // Distinct, increasing timestamps so ORDER BY created_at DESC is deterministic
      // (the shared-fixed-clock makeStores() would tie all rows to the same instant).
      let clock = new Date('2025-01-01T00:00:00.000Z').getTime();
      const tickingNow = () => new Date(clock++);
      const { campaigns } = makeStores(tickingNow);

      campaigns.createCampaign('t1', { name: 'First', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.createCampaign('t2', { name: 'Other tenant', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.createCampaign('t1', { name: 'Second', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });

      const list = campaigns.listCampaigns('t1');
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.name)).toEqual(['Second', 'First']);
    });
  });

  describe('ensureRecipients', () => {
    it('creates one recipient per tenant contact for "all", and is idempotent', () => {
      const { contacts, campaigns } = makeStores();
      contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      contacts.createContact('t1', { name: 'Bola', phone: '+2348023456789' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });

      campaigns.ensureRecipients(c.id, 't1', 'all');
      expect(campaigns.pendingRecipients(c.id, 10)).toHaveLength(2);

      // second call must not duplicate
      campaigns.ensureRecipients(c.id, 't1', 'all');
      expect(campaigns.pendingRecipients(c.id, 10)).toHaveLength(2);
    });

    it('creates exactly one recipient for a specific contact id', () => {
      const { contacts, campaigns } = makeStores();
      const ada = contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      contacts.createContact('t1', { name: 'Bola', phone: '+2348023456789' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: ada.id, scheduledTime: '2025-01-01T00:00:00.000Z' });

      campaigns.ensureRecipients(c.id, 't1', ada.id);
      const pending = campaigns.pendingRecipients(c.id, 10);
      expect(pending).toHaveLength(1);
      expect(pending[0].contactId).toBe(ada.id);
    });

    it('flips the campaign from pending to processing', () => {
      const { contacts, campaigns, db } = makeStores();
      contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.ensureRecipients(c.id, 't1', 'all');
      const row = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id);
      expect(row.status).toBe('processing');
    });
  });

  describe('pendingRecipients', () => {
    it('respects the limit and only returns pending rows', () => {
      const { contacts, campaigns } = makeStores();
      for (let i = 0; i < 5; i++) contacts.createContact('t1', { name: `C${i}`, phone: `+234801234567${i}` });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.ensureRecipients(c.id, 't1', 'all');

      const firstBatch = campaigns.pendingRecipients(c.id, 2);
      expect(firstBatch).toHaveLength(2);

      campaigns.recordRecipientResult(firstBatch[0].id, { status: 'sent', providerMessageId: 'p1' });
      const remaining = campaigns.pendingRecipients(c.id, 10);
      expect(remaining).toHaveLength(4);
    });
  });

  describe('recomputeCampaignStatus', () => {
    it('leaves status alone while any recipient is still pending', () => {
      const { contacts, campaigns, db } = makeStores();
      contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      contacts.createContact('t1', { name: 'Bola', phone: '+2348023456789' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.ensureRecipients(c.id, 't1', 'all');
      const [r1] = campaigns.pendingRecipients(c.id, 1);
      campaigns.recordRecipientResult(r1.id, { status: 'sent' });
      campaigns.recomputeCampaignStatus(c.id);
      expect(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id).status).toBe('processing');
    });

    it('sets sent when all recipients succeeded', () => {
      const { contacts, campaigns, db } = makeStores();
      contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.ensureRecipients(c.id, 't1', 'all');
      const [r1] = campaigns.pendingRecipients(c.id, 1);
      campaigns.recordRecipientResult(r1.id, { status: 'sent' });
      campaigns.recomputeCampaignStatus(c.id);
      expect(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id).status).toBe('sent');
    });

    it('sets failed when all recipients failed', () => {
      const { contacts, campaigns, db } = makeStores();
      contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.ensureRecipients(c.id, 't1', 'all');
      const [r1] = campaigns.pendingRecipients(c.id, 1);
      campaigns.recordRecipientResult(r1.id, { status: 'failed', error: 'invalid number' });
      campaigns.recomputeCampaignStatus(c.id);
      expect(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id).status).toBe('failed');
    });

    it('sets partial on a mix of sent and failed', () => {
      const { contacts, campaigns, db } = makeStores();
      contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
      contacts.createContact('t1', { name: 'Bola', phone: '+2348023456789' });
      const c = campaigns.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: '2025-01-01T00:00:00.000Z' });
      campaigns.ensureRecipients(c.id, 't1', 'all');
      const [r1, r2] = campaigns.pendingRecipients(c.id, 10);
      campaigns.recordRecipientResult(r1.id, { status: 'sent' });
      campaigns.recordRecipientResult(r2.id, { status: 'failed', error: 'x' });
      campaigns.recomputeCampaignStatus(c.id);
      expect(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id).status).toBe('partial');
    });
  });
});
