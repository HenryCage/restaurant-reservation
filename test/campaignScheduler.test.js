import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';
import { createContactsStore } from '../src/contacts.js';
import { createCampaignsStore } from '../src/campaigns.js';
import { createCampaignScheduler } from '../src/campaignScheduler.js';
import { validateRegistry } from '../src/tenants.js';

// --- helpers (mirrors test/processor.test.js's conventions) ----------------

function silentLogger() {
  const l = { error() {}, warn() {}, info() {}, debug() {}, child: () => l };
  return l;
}

function baseConfig(over = {}) {
  return {
    defaultCountryCode: '234',
    maxCampaignRecipientsPerTick: 50,
    dryRun: false,
    effectiveGlobalTestNumber: '',
    ...over,
  };
}

function buildTenants(raw) {
  return validateRegistry({ tenants: raw }, silentLogger());
}

function rawTenant(over = {}) {
  return {
    id: 't1',
    name: 'T1',
    active: true,
    sheetId: 'sheetA',
    sheetName: 'Orders',
    senderId: 'Aaa1',
    channel: 'dnd',
    notifyStatuses: ['x'],
    templates: { x: 'x' },
    testNumber: '',
    ...over,
  };
}

function makeRegistry(tenants) {
  return { load: () => tenants };
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
const PAST = '2026-06-30T11:00:00.000Z';

function makeHarness(configOver = {}) {
  const db = createDb(':memory:');
  const contacts = createContactsStore(db, { now: FIXED_NOW });
  const campaignsStore = createCampaignsStore(db, { now: FIXED_NOW });
  return { db, contacts, campaignsStore, config: baseConfig(configOver) };
}

// --- tests -------------------------------------------------------------------

describe('campaignScheduler — single-flight', () => {
  it('skips a tick if the previous one is still running', async () => {
    const { contacts, campaignsStore, config } = makeHarness();
    const tenants = buildTenants([rawTenant()]);
    contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    campaignsStore.createCampaign('t1', { name: 'Promo', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    let resolveSend;
    const sendSms = () => new Promise((r) => (resolveSend = r));
    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    const first = scheduler.run();
    const second = await scheduler.run();
    expect(second).toEqual({ skipped: true });

    resolveSend({ ok: true, providerMessageId: 'm1' });
    await first;
  });
});

describe('campaignScheduler — per-tenant isolation', () => {
  it("one tenant's crash does not stop another tenant's campaign", async () => {
    const { contacts, campaignsStore, config } = makeHarness();
    const tenants = buildTenants([rawTenant({ id: 't1' }), rawTenant({ id: 't2', senderId: 'Bbb2' })]);
    contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    contacts.createContact('t2', { name: 'Bola', phone: '+2348023456789' });
    campaignsStore.createCampaign('t1', { name: 'P1', message: 'hi', sendTo: 'all', scheduledTime: PAST });
    campaignsStore.createCampaign('t2', { name: 'P2', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms((n, { opts }) => {
      if (opts.senderId === 'Aaa1') throw new Error('boom');
      return { ok: true, providerMessageId: 'm' + n };
    });

    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();

    // t2's send succeeded despite t1's sendSms throwing.
    const t2Calls = sendSms.calls.filter((c) => c.opts.senderId === 'Bbb2');
    expect(t2Calls).toHaveLength(1);
  });

  it('defers campaigns for a tenant that is not currently active', async () => {
    const { contacts, campaignsStore, config } = makeHarness();
    const tenants = buildTenants([rawTenant({ id: 't1' })]); // t2 not in registry
    contacts.createContact('t2', { name: 'Bola', phone: '+2348023456789' });
    // Can't create a contact under a tenant not in the registry via normal flow in
    // real life, but the store itself doesn't enforce registry membership -- this
    // simulates a tenant that existed when the campaign/contact were created and
    // was since deactivated/removed from tenants.json.
    campaignsStore.createCampaign('t2', { name: 'Orphan', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms();
    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();
    expect(sendSms.calls).toHaveLength(0);
  });
});

describe('campaignScheduler — send outcomes', () => {
  it('leaves a recipient pending on a transient failure (retried next tick)', async () => {
    const { contacts, campaignsStore, config } = makeHarness();
    const tenants = buildTenants([rawTenant()]);
    contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    const c = campaignsStore.createCampaign('t1', { name: 'P', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms(() => ({ ok: false, error: 'timeout', permanent: false }));
    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();
    expect(campaignsStore.pendingRecipients(c.id, 10)).toHaveLength(1);

    await scheduler.run();
    expect(sendSms.calls).toHaveLength(2); // retried next tick
  });

  it('marks a permanent failure as failed and does not retry', async () => {
    const { contacts, campaignsStore, config } = makeHarness();
    const tenants = buildTenants([rawTenant()]);
    contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    const c = campaignsStore.createCampaign('t1', { name: 'P', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms(() => ({ ok: false, error: 'invalid number', permanent: true }));
    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();
    expect(campaignsStore.pendingRecipients(c.id, 10)).toHaveLength(0);

    await scheduler.run();
    expect(sendSms.calls).toHaveLength(1); // not retried
  });

  it('marks campaigns.status sent / partial / failed based on the outcome mix', async () => {
    const { contacts, campaignsStore, config, db } = makeHarness();
    const tenants = buildTenants([rawTenant()]);
    contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    contacts.createContact('t1', { name: 'Bola', phone: '+2348023456789' });
    const c = campaignsStore.createCampaign('t1', { name: 'P', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms((n) => (n === 1 ? { ok: true, providerMessageId: 'm1' } : { ok: false, error: 'bad', permanent: true }));
    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();
    const status = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id).status;
    expect(status).toBe('partial');
  });

  it('does not call sendSms under DRY_RUN and marks recipients sent', async () => {
    const { contacts, campaignsStore, config } = makeHarness({ dryRun: true });
    const tenants = buildTenants([rawTenant()]);
    contacts.createContact('t1', { name: 'Ada', phone: '+2348012345678' });
    const c = campaignsStore.createCampaign('t1', { name: 'P', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms();
    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();
    expect(sendSms.calls).toHaveLength(0);
    expect(campaignsStore.pendingRecipients(c.id, 10)).toHaveLength(0);
  });
});

describe('campaignScheduler — bulk-edit guardrail', () => {
  it('caps sends per tick and processes the remainder on the next tick', async () => {
    const { contacts, campaignsStore, config } = makeHarness({ maxCampaignRecipientsPerTick: 2 });
    const tenants = buildTenants([rawTenant()]);
    contacts.createContact('t1', { name: 'A', phone: '+2348012345671' });
    contacts.createContact('t1', { name: 'B', phone: '+2348012345672' });
    contacts.createContact('t1', { name: 'C', phone: '+2348012345673' });
    campaignsStore.createCampaign('t1', { name: 'P', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms();
    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();
    expect(sendSms.calls).toHaveLength(2);

    await scheduler.run();
    expect(sendSms.calls).toHaveLength(3); // the 3rd recipient sent on the next tick
  });
});

describe('campaignScheduler — crash safety', () => {
  it('leaves only the un-sent recipients pending after a mid-batch throw', async () => {
    const { contacts, campaignsStore, config } = makeHarness();
    const tenants = buildTenants([rawTenant()]);
    contacts.createContact('t1', { name: 'A', phone: '+2348012345671' });
    contacts.createContact('t1', { name: 'B', phone: '+2348012345672' });
    const c = campaignsStore.createCampaign('t1', { name: 'P', message: 'hi', sendTo: 'all', scheduledTime: PAST });

    const sendSms = makeSendSms((n) => {
      if (n === 2) throw new Error('process crashed mid-send');
      return { ok: true, providerMessageId: 'm' + n };
    });

    const scheduler = createCampaignScheduler({
      config,
      logger: silentLogger(),
      registry: makeRegistry(tenants),
      campaignsStore,
      sendSms,
      now: FIXED_NOW,
    });

    await scheduler.run();
    // The first recipient's send succeeded and was written back; the second
    // recipient's send threw and stays pending -- isolated, not fatal to the tick.
    expect(campaignsStore.pendingRecipients(c.id, 10)).toHaveLength(1);

    await scheduler.run();
    expect(campaignsStore.pendingRecipients(c.id, 10)).toHaveLength(0);
  });
});
