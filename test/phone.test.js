import { describe, it, expect } from 'vitest';
import { normalisePhone, isValidE164 } from '../src/phone.js';

describe('normalisePhone (Nigeria, cc=234)', () => {
  it('normalises the four canonical input formats from the spec', () => {
    expect(normalisePhone('08012345678')).toBe('+2348012345678');
    expect(normalisePhone('8012345678')).toBe('+2348012345678');
    expect(normalisePhone('2348012345678')).toBe('+2348012345678');
    expect(normalisePhone('+2348012345678')).toBe('+2348012345678');
  });

  it('strips spaces, dashes, dots, parentheses and stray commas', () => {
    expect(normalisePhone('  0801 234 5678 ')).toBe('+2348012345678');
    expect(normalisePhone('0801-234-5678')).toBe('+2348012345678');
    expect(normalisePhone('+234 (801) 234.5678')).toBe('+2348012345678');
    // commas can appear if Sheets number-formatted the cell
    expect(normalisePhone('8,012,345,678')).toBe('+2348012345678');
  });

  it('coerces a numeric value (lost leading zero) correctly', () => {
    // Google Sheets stores 08012345678 as the number 8012345678
    expect(normalisePhone(8012345678)).toBe('+2348012345678');
  });

  it('accepts all valid Nigerian mobile prefixes 7/8/9', () => {
    expect(normalisePhone('07012345678')).toBe('+2347012345678');
    expect(normalisePhone('08123456789')).toBe('+2348123456789');
    expect(normalisePhone('09087654321')).toBe('+2349087654321');
  });

  it('rejects invalid numbers by returning null', () => {
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('   ')).toBeNull();
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
    expect(normalisePhone('abc')).toBeNull();
    expect(normalisePhone('0801234567')).toBeNull(); // too short (9 NSN digits)
    expect(normalisePhone('080123456789')).toBeNull(); // too long
    expect(normalisePhone('06012345678')).toBeNull(); // landline-ish prefix 6, not mobile
    expect(normalisePhone('01012345678')).toBeNull(); // prefix 1, not mobile
  });

  it('does not crash on weird input types', () => {
    expect(normalisePhone({})).toBeNull();
    expect(normalisePhone([])).toBeNull();
  });
});

describe('normalisePhone (generic country code)', () => {
  it('handles a non-Nigerian country code with a generic length check', () => {
    expect(normalisePhone('+15551234567', '1')).toBe('+15551234567');
    expect(normalisePhone('5551234567', '1')).toBe('+15551234567');
  });

  it('still rejects clearly-too-short generic numbers', () => {
    expect(normalisePhone('123', '1')).toBeNull();
  });
});

describe('isValidE164', () => {
  it('enforces the Nigerian mobile shape', () => {
    expect(isValidE164('+2348012345678', '234')).toBe(true);
    expect(isValidE164('+2346012345678', '234')).toBe(false);
    expect(isValidE164('+234801234567', '234')).toBe(false); // 9 NSN digits
  });

  it('rejects strings not starting with the country code', () => {
    expect(isValidE164('2348012345678', '234')).toBe(false); // missing +
    expect(isValidE164('+1555123456', '234')).toBe(false);
  });
});
