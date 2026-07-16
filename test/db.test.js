import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';

describe('createDb', () => {
  it('creates all six tables on an in-memory database', () => {
    const db = createDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(['campaign_recipients', 'campaigns', 'contacts', 'sessions', 'tenants', 'users']);
  });

  it('round-trips a row through each table', () => {
    const db = createDb(':memory:');

    db.prepare(
      'INSERT INTO contacts (id, tenant_id, name, phone, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('c1', 't1', 'Ada', '+2348012345678', '[]', '2026-01-01T00:00:00.000Z');
    expect(db.prepare('SELECT * FROM contacts WHERE id = ?').get('c1')).toMatchObject({ name: 'Ada' });

    db.prepare(
      'INSERT INTO campaigns (id, tenant_id, name, type, message, send_to, scheduled_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('camp1', 't1', 'Test', 'sms', 'hi', 'all', '2026-01-01T00:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z');
    expect(db.prepare('SELECT * FROM campaigns WHERE id = ?').get('camp1')).toMatchObject({ status: 'pending' });

    db.prepare(
      'INSERT INTO campaign_recipients (id, campaign_id, contact_id, phone, status) VALUES (?, ?, ?, ?, ?)',
    ).run('r1', 'camp1', 'c1', '+2348012345678', 'pending');
    expect(db.prepare('SELECT * FROM campaign_recipients WHERE id = ?').get('r1')).toMatchObject({
      status: 'pending',
    });
  });

  it('round-trips a row through users and sessions', () => {
    const db = createDb(':memory:');

    db.prepare(
      'INSERT INTO users (id, tenant_id, email, password_hash, is_superadmin, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('u1', 't1', 'a@example.com', 'scrypt:aa:bb', 0, 1, '2026-01-01T00:00:00.000Z');
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get('u1')).toMatchObject({ email: 'a@example.com' });

    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      's1',
      'u1',
      '2026-01-01T00:00:00.000Z',
      '2026-01-08T00:00:00.000Z',
    );
    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1')).toMatchObject({ user_id: 'u1' });
  });

  it('round-trips a row through tenants', () => {
    const db = createDb(':memory:');
    db.prepare(
      `INSERT INTO tenants (id, name, active, sheet_id, sheet_name, sender_id, channel, notify_statuses_json, templates_json, test_number, sync_contacts_from_sheet, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'swift-logistics',
      'Swift Logistics',
      1,
      'sheet-1',
      'Orders',
      'SwiftLog',
      'dnd',
      '["Out for delivery"]',
      '{"Out for delivery":"Hi {name}"}',
      '',
      0,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get('swift-logistics');
    expect(row).toMatchObject({ name: 'Swift Logistics', active: 1, sender_id: 'SwiftLog' });
  });

  it('enforces UNIQUE(email) on users', () => {
    const db = createDb(':memory:');
    const insert = db.prepare(
      'INSERT INTO users (id, tenant_id, email, password_hash, is_superadmin, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('u1', 't1', 'a@example.com', 'h1', 0, 1, '2026-01-01T00:00:00.000Z');
    expect(() => insert.run('u2', 't2', 'a@example.com', 'h2', 0, 1, '2026-01-01T00:00:00.000Z')).toThrow();
  });

  it('enforces UNIQUE(tenant_id, phone) on contacts', () => {
    const db = createDb(':memory:');
    const insert = db.prepare(
      'INSERT INTO contacts (id, tenant_id, name, phone, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('c1', 't1', 'Ada', '+2348012345678', '[]', '2026-01-01T00:00:00.000Z');
    expect(() => insert.run('c2', 't1', 'Ada Two', '+2348012345678', '[]', '2026-01-01T00:00:00.000Z')).toThrow();
  });

  it('rejects a campaign type other than sms via CHECK constraint', () => {
    const db = createDb(':memory:');
    expect(() =>
      db
        .prepare(
          'INSERT INTO campaigns (id, tenant_id, name, type, message, send_to, scheduled_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('camp1', 't1', 'Test', 'call', 'hi', 'all', '2026-01-01T00:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z'),
    ).toThrow();
  });
});
