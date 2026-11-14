import { describe, expect, it } from 'vitest';
import { formatMembershipNumber, normalizePhone } from '../src/utils/phone';

describe('normalizePhone', () => {
  it('formats Nepal mobiles the same way however they are typed', () => {
    for (const v of ['9812345678', '98123 45678', '+977 9812345678', '977-9812345678', '00977 9812345678', '(0)9812345678']) {
      expect(normalizePhone(v, '977')).toBe('+9779812345678');
    }
  });
  it('keeps other international numbers', () => expect(normalizePhone('+1 415 555 0123', '977')).toBe('+14155550123'));
  it('rejects junk', () => {
    expect(() => normalizePhone('abc', '977')).toThrow();
    expect(() => normalizePhone('123', '977')).toThrow();
    expect(() => normalizePhone('', '977')).toThrow();
  });
});

describe('formatMembershipNumber', () => {
  it('pads the sequence', () => {
    expect(formatMembershipNumber(7, 'CAFE')).toBe('CAFE-000007');
    expect(formatMembershipNumber(123456, 'CAFE')).toBe('CAFE-123456');
  });
});
