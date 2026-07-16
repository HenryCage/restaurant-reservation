import { describe, it, expect } from 'vitest';
import { createDb } from '../src/db.js';

describe('createDb', () => {
  it('creates all three tables on an in-memory database', () => {
    const db = createDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(['campaign_recipients', 'campaigns', 'contacts']);
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
