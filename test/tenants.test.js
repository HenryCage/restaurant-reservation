import { describe, it, expect } from 'vitest';
import { createTenantRegistry, validateRegistry, canonicalStatus, maskSmsCredentials, maskGooglePrivateKey } from '../src/tenants.js';
import { createDb } from '../src/db.js';

/** A no-op logger that records error messages for assertions. */
function fakeLogger() {
  const errors = [];
  const l = {
    error: (m, meta) => errors.push({ m, meta }),
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => l,
    errors,
  };
  return l;
}

// No trailing "\n" -- validateTenant trims every string field (same convention
// as senderId/testNumber), so a trailing newline would never round-trip.
const FAKE_PEM_KEY = '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----';

function tenant(overrides = {}) {
  return {
    id: 'swift',
    name: 'Swift',
    active: true,
    sheetId: 'sheet-1',
    sheetName: 'Orders',
    senderId: 'SwiftLog',
    channel: 'dnd',
    notifyStatuses: ['Out for delivery'],
    templates: { 'Out for delivery': 'Hi {name}, #{orderId} out for delivery.' },
    testNumber: '',
    ...overrides,
  };
}

describe('validateRegistry', () => {
  it('returns active, valid tenants and builds canonical maps', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant()] }, log);
    expect(out).toHaveLength(1);
    expect(out[0].notifyStatusesCanonical.has('out for delivery')).toBe(true);
    expect(out[0].templatesByCanonical['out for delivery']).toContain('out for delivery');
  });

  it('skips inactive tenants', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant({ active: false })] }, log);
    expect(out).toHaveLength(0);
  });

  it('matches templates to notify statuses canonically (case/space insensitive)', () => {
    const log = fakeLogger();
    const out = validateRegistry(
      { tenants: [tenant({ notifyStatuses: ['Out For Delivery '], templates: { 'out for delivery': 'X {orderId}' } })] },
      log,
    );
    expect(out).toHaveLength(1);
  });

  it('skips a tenant missing a template for one of its notify statuses', () => {
    const log = fakeLogger();
    const out = validateRegistry(
      { tenants: [tenant({ notifyStatuses: ['Out for delivery', 'Delivered'] })] },
      log,
    );
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => /missing template/.test(e.m))).toBe(true);
  });

  it('skips both tenants sharing a duplicate id', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant({ senderId: 'AaA1' }), tenant({ senderId: 'BbB2' })] }, log);
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => /duplicate "id"/.test(e.m))).toBe(true);
  });

  it('skips a tenant with an invalid senderId format', () => {
    const log = fakeLogger();
    expect(validateRegistry({ tenants: [tenant({ senderId: 'has space' })] }, log)).toHaveLength(0);
    expect(validateRegistry({ tenants: [tenant({ senderId: 'TwelveCharss' })] }, log)).toHaveLength(0); // 12 chars
    expect(validateRegistry({ tenants: [tenant({ senderId: 'ab' })] }, log)).toHaveLength(0); // 2 chars
  });

  it('skips active tenants that share a senderId (impersonation guard)', () => {
    const log = fakeLogger();
    const out = validateRegistry(
      { tenants: [tenant({ id: 'a', senderId: 'Shared1' }), tenant({ id: 'b', senderId: 'shared1' })] },
      log,
    );
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => /shared with another active tenant/.test(e.m))).toBe(true);
  });

  it('does NOT let an inactive duplicate senderId block an active tenant', () => {
    const log = fakeLogger();
    const out = validateRegistry(
      { tenants: [tenant({ id: 'a', senderId: 'Brand1' }), tenant({ id: 'b', active: false, senderId: 'Brand1' })] },
      log,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });

  it('returns null for a structurally invalid registry', () => {
    const log = fakeLogger();
    expect(validateRegistry({}, log)).toBeNull();
    expect(validateRegistry({ tenants: 'nope' }, log)).toBeNull();
    expect(validateRegistry(null, log)).toBeNull();
  });

  it('allows an empty smsProvider (not yet configured)', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant()] }, log);
    expect(out).toHaveLength(1);
    expect(out[0].smsProvider).toBe('');
    expect(out[0].smsCredentials).toEqual({});
  });

  it('rejects an unknown smsProvider value', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant({ smsProvider: 'carrier-pigeon' })] }, log);
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => /unknown "smsProvider"/.test(e.m))).toBe(true);
  });

  it.each([
    ['termii', { apiKey: 'k' }, 'baseUrl'],
    ['termii', { baseUrl: 'https://x' }, 'apiKey'],
    ['africastalking', { apiKey: 'k' }, 'username'],
    ['africastalking', { username: 'sandbox' }, 'apiKey'],
    ['twilio', { accountSid: 'AC', authToken: 't' }, 'fromNumber'],
    ['twilio', { accountSid: 'AC', fromNumber: '+1' }, 'authToken'],
    ['twilio', { authToken: 't', fromNumber: '+1' }, 'accountSid'],
  ])('rejects %s missing required field %s', (smsProvider, smsCredentials, missingField) => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant({ smsProvider, smsCredentials })] }, log);
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => e.m.includes(`smsCredentials.${missingField}`))).toBe(true);
  });

  it('accepts a fully-configured provider', () => {
    const log = fakeLogger();
    const out = validateRegistry(
      { tenants: [tenant({ smsProvider: 'termii', smsCredentials: { apiKey: 'k', baseUrl: 'https://x' } })] },
      log,
    );
    expect(out).toHaveLength(1);
    expect(out[0].smsProvider).toBe('termii');
    expect(out[0].smsCredentials).toEqual({ apiKey: 'k', baseUrl: 'https://x' });
  });

  it('defaultCountryCode defaults to empty (no override) when absent', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant()] }, log);
    expect(out[0].defaultCountryCode).toBe('');
  });

  it('defaultCountryCode strips non-digit characters', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant({ defaultCountryCode: '+370' })] }, log);
    expect(out[0].defaultCountryCode).toBe('370');
  });

  it('allows an empty Google credential pair (not yet configured)', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant()] }, log);
    expect(out).toHaveLength(1);
    expect(out[0].googleServiceAccountEmail).toBe('');
    expect(out[0].googlePrivateKey).toBe('');
  });

  it('accepts a fully-configured Google credential pair', () => {
    const log = fakeLogger();
    const out = validateRegistry(
      { tenants: [tenant({ googleServiceAccountEmail: 'sa@example.iam.gserviceaccount.com', googlePrivateKey: FAKE_PEM_KEY })] },
      log,
    );
    expect(out).toHaveLength(1);
    expect(out[0].googleServiceAccountEmail).toBe('sa@example.iam.gserviceaccount.com');
    expect(out[0].googlePrivateKey).toBe(FAKE_PEM_KEY);
  });

  it('rejects a half-configured Google credential (email without key)', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant({ googleServiceAccountEmail: 'sa@example.com' })] }, log);
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => /must both be set, or both left blank/.test(e.m))).toBe(true);
  });

  it('rejects a half-configured Google credential (key without email)', () => {
    const log = fakeLogger();
    const out = validateRegistry({ tenants: [tenant({ googlePrivateKey: FAKE_PEM_KEY })] }, log);
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => /must both be set, or both left blank/.test(e.m))).toBe(true);
  });

  it('rejects a Google private key that does not look like a PEM key', () => {
    const log = fakeLogger();
    const out = validateRegistry(
      { tenants: [tenant({ googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: 'not-a-real-key' })] },
      log,
    );
    expect(out).toHaveLength(0);
    expect(log.errors.some((e) => /does not look like a PEM private key/.test(e.m))).toBe(true);
  });
});

describe('maskSmsCredentials', () => {
  it('masks apiKey for termii, leaving baseUrl visible', () => {
    const masked = maskSmsCredentials('termii', { apiKey: 'abcd1234ab12', baseUrl: 'https://x' });
    expect(masked).toEqual({ apiKey: '••••ab12', baseUrl: 'https://x' });
  });

  it('masks apiKey for africastalking, leaving username visible', () => {
    const masked = maskSmsCredentials('africastalking', { apiKey: 'secretvalue', username: 'sandbox' });
    expect(masked).toEqual({ apiKey: '••••alue', username: 'sandbox' });
  });

  it('masks authToken for twilio, leaving accountSid/fromNumber visible', () => {
    const masked = maskSmsCredentials('twilio', { accountSid: 'ACxxx', authToken: 'tok_secret1', fromNumber: '+1' });
    expect(masked).toEqual({ accountSid: 'ACxxx', authToken: '••••ret1', fromNumber: '+1' });
  });

  it('masks a short value entirely rather than revealing it', () => {
    expect(maskSmsCredentials('termii', { apiKey: 'ab', baseUrl: 'https://x' }).apiKey).toBe('••••');
  });

  it('passes through unchanged for an unconfigured (empty) provider', () => {
    expect(maskSmsCredentials('', {})).toEqual({});
  });
});

describe('maskGooglePrivateKey', () => {
  it('masks a non-empty key as a fixed indicator, never any real fragment', () => {
    expect(maskGooglePrivateKey(FAKE_PEM_KEY)).toBe('(private key set)');
  });

  it('returns empty string for an unconfigured (empty) key', () => {
    expect(maskGooglePrivateKey('')).toBe('');
  });
});

/** Builds a fresh in-memory registry + a raw-row insert helper for seeding it. */
function makeRegistry() {
  const db = createDb(':memory:');
  const logger = fakeLogger();
  const registry = createTenantRegistry({ db, logger });
  return { db, logger, registry };
}

/** Inserts a `tenants` row directly (bypassing create()'s validation), for seeding edge cases. */
function insertRawRow(db, over = {}) {
  const row = {
    id: 'swift',
    name: 'Swift',
    active: 1,
    sheet_id: 'sheet-1',
    sheet_name: 'Orders',
    sender_id: 'SwiftLog',
    channel: 'dnd',
    notify_statuses_json: JSON.stringify(['Out for delivery']),
    templates_json: JSON.stringify({ 'Out for delivery': 'Hi {name}' }),
    test_number: '',
    sms_provider: '',
    sms_credentials_json: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
  db.prepare(
    `INSERT INTO tenants (id, name, active, sheet_id, sheet_name, sender_id, channel, notify_statuses_json, templates_json, test_number, sms_provider, sms_credentials_json, created_at, updated_at)
     VALUES (@id, @name, @active, @sheet_id, @sheet_name, @sender_id, @channel, @notify_statuses_json, @templates_json, @test_number, @sms_provider, @sms_credentials_json, @created_at, @updated_at)`,
  ).run(row);
}

describe('createTenantRegistry (SQLite) — load()', () => {
  it('keeps the previous registry when the query fails', () => {
    const { db, logger, registry } = makeRegistry();
    insertRawRow(db);
    expect(registry.load()).toHaveLength(1);

    db.close();
    const out = registry.load();
    expect(out).toHaveLength(1); // fell back, did not zero the fleet
    expect(logger.errors.some((e) => /cannot read the tenants table/.test(e.m))).toBe(true);
  });

  it('skips an individually invalid row without failing the whole load', () => {
    const { db, logger, registry } = makeRegistry();
    insertRawRow(db, { id: 'a' });
    insertRawRow(db, { id: 'b', sender_id: 'bad sender id' }); // invalid format
    const out = registry.load();
    expect(out.map((t) => t.id)).toEqual(['a']);
    expect(logger.errors.some((e) => /skipped/.test(e.m))).toBe(true);
  });

  it('returns only active tenants', () => {
    const { db, registry } = makeRegistry();
    insertRawRow(db, { id: 'a', active: 1 });
    insertRawRow(db, { id: 'b', active: 0, sender_id: 'Other11' });
    expect(registry.load().map((t) => t.id)).toEqual(['a']);
  });
});

describe('createTenantRegistry (SQLite) — listAll()', () => {
  it('returns every tenant, including inactive ones', () => {
    const { db, registry } = makeRegistry();
    insertRawRow(db, { id: 'a', active: 1 });
    insertRawRow(db, { id: 'b', active: 0, sender_id: 'Other11' });
    const all = registry.listAll();
    expect(all.map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect(all.find((t) => t.id === 'b').active).toBe(false);
  });
});

describe('createTenantRegistry (SQLite) — create()', () => {
  it('creates a valid tenant', () => {
    const { registry } = makeRegistry();
    const res = registry.create(tenant());
    expect(res.ok).toBe(true);
    expect(res.tenant.id).toBe('swift');
    expect(registry.listAll()).toHaveLength(1);
  });

  it('rejects a duplicate id', () => {
    const { registry } = makeRegistry();
    registry.create(tenant());
    const res = registry.create(tenant({ senderId: 'Other11' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/duplicate "id"/);
  });

  it('rejects a senderId collision with another active tenant', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ id: 'a' }));
    const res = registry.create(tenant({ id: 'b' })); // same default senderId 'SwiftLog'
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/shared with another active tenant/);
  });

  it('allows reusing a senderId from an inactive tenant', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ id: 'a', active: false }));
    const res = registry.create(tenant({ id: 'b' }));
    expect(res.ok).toBe(true);
  });

  it('round-trips defaultCountryCode', () => {
    const { registry } = makeRegistry();
    const res = registry.create(tenant({ defaultCountryCode: '370' }));
    expect(res.ok).toBe(true);
    expect(res.tenant.defaultCountryCode).toBe('370');
  });
});

describe('createTenantRegistry (SQLite) — update()', () => {
  it('returns notFound for an unknown id', () => {
    const { registry } = makeRegistry();
    expect(registry.update('nope', { name: 'X' })).toEqual({ ok: false, notFound: true });
  });

  it('applies a partial merge, leaving other fields untouched', () => {
    const { registry } = makeRegistry();
    registry.create(tenant());
    const res = registry.update('swift', { name: 'Swift Renamed' });
    expect(res.ok).toBe(true);
    expect(res.tenant.name).toBe('Swift Renamed');
    expect(res.tenant.senderId).toBe('SwiftLog'); // unchanged
  });

  it('ignores an id in the patch -- the row id never changes', () => {
    const { registry } = makeRegistry();
    registry.create(tenant());
    const res = registry.update('swift', { id: 'renamed' });
    expect(res.ok).toBe(true);
    expect(res.tenant.id).toBe('swift');
  });

  it('does not self-conflict on its own unchanged id/senderId', () => {
    const { registry } = makeRegistry();
    registry.create(tenant());
    const res = registry.update('swift', { name: 'Still Swift' });
    expect(res.ok).toBe(true);
  });

  it('rejects a senderId collision with another active tenant', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ id: 'a' }));
    registry.create(tenant({ id: 'b', senderId: 'Other11' }));
    const res = registry.update('b', { senderId: 'SwiftLog' }); // collides with 'a'
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/shared with another active tenant/);
  });

  it('a blank secret field in the patch preserves the previously stored value', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ smsProvider: 'termii', smsCredentials: { apiKey: 'real-secret', baseUrl: 'https://x' } }));

    const res = registry.update('swift', {
      smsProvider: 'termii',
      smsCredentials: { apiKey: '', baseUrl: 'https://x' }, // blank apiKey = keep existing
    });
    expect(res.ok).toBe(true);
    expect(res.tenant.smsCredentials.apiKey).toBe('real-secret');
  });

  it('a non-blank secret field in the patch overwrites the stored value', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ smsProvider: 'termii', smsCredentials: { apiKey: 'old-secret', baseUrl: 'https://x' } }));

    const res = registry.update('swift', {
      smsCredentials: { apiKey: 'new-secret', baseUrl: 'https://x' },
    });
    expect(res.ok).toBe(true);
    expect(res.tenant.smsCredentials.apiKey).toBe('new-secret');
  });

  it('switching provider leaves the new provider\'s fields correctly blank, rejected if not filled', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ smsProvider: 'termii', smsCredentials: { apiKey: 'k', baseUrl: 'https://x' } }));

    const res = registry.update('swift', {
      smsProvider: 'twilio',
      smsCredentials: { accountSid: '', authToken: '', fromNumber: '' }, // nothing to inherit from termii's shape
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/smsCredentials.accountSid/);
  });

  it('switching provider with real values for the new provider succeeds', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ smsProvider: 'termii', smsCredentials: { apiKey: 'k', baseUrl: 'https://x' } }));

    const res = registry.update('swift', {
      smsProvider: 'twilio',
      smsCredentials: { accountSid: 'AC1', authToken: 'tok1', fromNumber: '+15005550006' },
    });
    expect(res.ok).toBe(true);
    expect(res.tenant.smsCredentials).toEqual({ accountSid: 'AC1', authToken: 'tok1', fromNumber: '+15005550006' });
  });

  it('a blank googlePrivateKey in the patch preserves the previously stored key', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: FAKE_PEM_KEY }));

    const res = registry.update('swift', {
      googleServiceAccountEmail: 'sa@example.com', // unchanged, as the form always resends it
      googlePrivateKey: '', // blank field left untouched -> keep existing
    });
    expect(res.ok).toBe(true);
    expect(res.tenant.googlePrivateKey).toBe(FAKE_PEM_KEY);
  });

  it('a non-blank googlePrivateKey in the patch overwrites the stored key', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: FAKE_PEM_KEY }));

    const newKey = '-----BEGIN PRIVATE KEY-----\nNEW\n-----END PRIVATE KEY-----';
    const res = registry.update('swift', { googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: newKey });
    expect(res.ok).toBe(true);
    expect(res.tenant.googlePrivateKey).toBe(newKey);
  });

  it('clearing both Google fields together actually removes the configuration, not resurrects the old key', () => {
    const { registry } = makeRegistry();
    registry.create(tenant({ googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: FAKE_PEM_KEY }));

    const res = registry.update('swift', { googleServiceAccountEmail: '', googlePrivateKey: '' });
    expect(res.ok).toBe(true);
    expect(res.tenant.googleServiceAccountEmail).toBe('');
    expect(res.tenant.googlePrivateKey).toBe('');
  });
});

describe('canonicalStatus', () => {
  it('trims and lower-cases', () => {
    expect(canonicalStatus('  Out For Delivery ')).toBe('out for delivery');
    expect(canonicalStatus(null)).toBe('');
  });
});
