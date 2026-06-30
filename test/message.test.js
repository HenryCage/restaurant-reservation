import { describe, it, expect } from 'vitest';
import { buildMessage, sanitiseText, formatAmount } from '../src/message.js';

const SWIFT_TPL =
  'Hi {name}, your order #{orderId} is out for delivery.[[ Please have NGN {amount} ready (cash or transfer).]] Thank you - Swift Logistics.';

describe('buildMessage — placeholders & optional clauses', () => {
  it('fills all placeholders and keeps the optional clause when amount is present', () => {
    const msg = buildMessage(SWIFT_TPL, { name: 'Chidi', orderId: '1234', amount: '15000' });
    expect(msg).toBe(
      'Hi Chidi, your order #1234 is out for delivery. Please have NGN 15,000 ready (cash or transfer). Thank you - Swift Logistics.',
    );
  });

  it('drops the optional clause cleanly when amount is empty (no double-space)', () => {
    const msg = buildMessage(SWIFT_TPL, { name: 'Chidi', orderId: '1234', amount: '' });
    expect(msg).toBe('Hi Chidi, your order #1234 is out for delivery. Thank you - Swift Logistics.');
    expect(msg).not.toContain('NGN');
    expect(msg).not.toMatch(/ {2,}/);
  });

  it('drops the optional clause when amount is non-numeric', () => {
    const msg = buildMessage(SWIFT_TPL, { name: 'Ada', orderId: 'X9', amount: 'N/A' });
    expect(msg).not.toContain('NGN');
  });

  it('handles a missing name without leaving doubled spaces', () => {
    const msg = buildMessage(SWIFT_TPL, { orderId: '1234', amount: '15000' });
    expect(msg).toContain('your order #1234');
    expect(msg).not.toMatch(/ {2,}/);
  });

  it('leaves unknown placeholders untouched', () => {
    expect(buildMessage('Hi {name}, ref {unknown}', { name: 'Ada' })).toBe('Hi Ada, ref {unknown}');
  });

  it('treats null/empty template safely', () => {
    expect(buildMessage(null, { name: 'Ada' })).toBe('');
    expect(buildMessage('', { name: 'Ada' })).toBe('');
  });
});

describe('formatAmount', () => {
  it('groups plain integers', () => {
    expect(formatAmount('15000')).toBe('15,000');
    expect(formatAmount(15000)).toBe('15,000');
    expect(formatAmount('1500000')).toBe('1,500,000');
    expect(formatAmount('999')).toBe('999');
  });

  it('drops kobo and keeps whole naira (does NOT inflate decimals)', () => {
    expect(formatAmount('15,000.00')).toBe('15,000'); // the classic strip-non-digits bug
    expect(formatAmount('15000.99')).toBe('15,000');
    expect(formatAmount('1,500,000.50')).toBe('1,500,000');
  });

  it('returns empty string for empty / non-numeric', () => {
    expect(formatAmount('')).toBe('');
    expect(formatAmount('   ')).toBe('');
    expect(formatAmount(null)).toBe('');
    expect(formatAmount(undefined)).toBe('');
    expect(formatAmount('N/A')).toBe('');
    expect(formatAmount('abc')).toBe('');
  });
});

describe('sanitiseText', () => {
  it('strips newlines/control chars and collapses whitespace', () => {
    expect(sanitiseText('Ada\nNwosu', 40)).toBe('Ada Nwosu');
    expect(sanitiseText('  spaced   out  ', 40)).toBe('spaced out');
    expect(sanitiseText('tab\tsep', 40)).toBe('tab sep');
  });

  it('caps length', () => {
    expect(sanitiseText('x'.repeat(100), 10)).toBe('x'.repeat(10));
  });

  it('handles null/undefined', () => {
    expect(sanitiseText(null, 10)).toBe('');
    expect(sanitiseText(undefined, 10)).toBe('');
  });

  it('removes injected control characters used to break the message', () => {
    // NUL between the words, BEL at the end — built at runtime to keep source printable.
    const withCtrl = 'Ada' + String.fromCharCode(0) + 'Nwosu' + String.fromCharCode(7);
    expect(sanitiseText(withCtrl, 40)).toBe('Ada Nwosu');
  });
});
