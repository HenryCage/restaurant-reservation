import { describe, it, expect } from 'vitest';
import { createTenantRegistry, validateRegistry, canonicalStatus } from '../src/tenants.js';

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

  it('defaults syncContactsFromSheet to false when absent, parses true when present', () => {
    const log = fakeLogger();
    const [withoutField] = validateRegistry({ tenants: [tenant()] }, log);
    expect(withoutField.syncContactsFromSheet).toBe(false);

    const [withField] = validateRegistry({ tenants: [tenant({ syncContactsFromSheet: true })] }, log);
    expect(withField.syncContactsFromSheet).toBe(true);

    // Any non-true value (wrong type, truthy-but-not-boolean) also defaults to false.
    const [wrongType] = validateRegistry({ tenants: [tenant({ syncContactsFromSheet: 'true' })] }, log);
    expect(wrongType.syncContactsFromSheet).toBe(false);
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
});

describe('createTenantRegistry — last-known-good fallback', () => {
  const goodJson = JSON.stringify({ tenants: [tenant()] });

  it('keeps the previous registry when the file becomes invalid JSON', () => {
    let content = goodJson;
    const log = fakeLogger();
    const reg = createTenantRegistry({ filePath: 'x.json', logger: log, readFile: () => content });
    expect(reg.load()).toHaveLength(1);

    content = '{ this is not valid json';
    const out = reg.load();
    expect(out).toHaveLength(1); // fell back, did not zero the fleet
    expect(log.errors.some((e) => /invalid JSON/.test(e.m))).toBe(true);
  });

  it('keeps the previous registry when the file cannot be read', () => {
    let fail = false;
    const log = fakeLogger();
    const reg = createTenantRegistry({
      filePath: 'x.json',
      logger: log,
      readFile: () => {
        if (fail) throw new Error('ENOENT: no such file');
        return goodJson;
      },
    });
    expect(reg.load()).toHaveLength(1);
    fail = true;
    expect(reg.load()).toHaveLength(1);
    expect(log.errors.some((e) => /cannot read/.test(e.m))).toBe(true);
  });

  it('keeps the previous registry when the shape is wrong', () => {
    let content = goodJson;
    const log = fakeLogger();
    const reg = createTenantRegistry({ filePath: 'x.json', logger: log, readFile: () => content });
    expect(reg.load()).toHaveLength(1);
    content = JSON.stringify({ notTenants: [] });
    expect(reg.load()).toHaveLength(1);
  });
});

describe('canonicalStatus', () => {
  it('trims and lower-cases', () => {
    expect(canonicalStatus('  Out For Delivery ')).toBe('out for delivery');
    expect(canonicalStatus(null)).toBe('');
  });
});
