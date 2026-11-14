import { describe, expect, it } from 'vitest';
import { allocateProportionally, computeTotals, discountPercentOf } from '../src/modules/billing/calc';
import { D, sum } from '../src/utils/money';

const base = { discountType: 'NONE' as const, discountValue: D(0), serviceChargePct: D(0), taxRatePercent: D(0), pricesIncludeTax: false };

describe('computeTotals', () => {
  it('no tax, no discount', () => {
    const t = computeTotals({ ...base, subtotal: D('500') });
    expect(t.total.toString()).toBe('500');
  });
  it('adds 13% tax on top (prices exclude tax)', () => {
    const t = computeTotals({ ...base, subtotal: D('1000'), taxRatePercent: D(13) });
    expect(t.taxAmount.toString()).toBe('130');
    expect(t.total.toString()).toBe('1130');
  });
  it('extracts tax when prices include tax', () => {
    const t = computeTotals({ ...base, subtotal: D('1130'), taxRatePercent: D(13), pricesIncludeTax: true });
    expect(t.taxAmount.toString()).toBe('130');
    expect(t.total.toString()).toBe('1130');
  });
  it('percentage discount then service charge then tax', () => {
    const t = computeTotals({ ...base, subtotal: D('1000'), discountType: 'PERCENTAGE', discountValue: D(10), serviceChargePct: D(10), taxRatePercent: D(13) });
    expect(t.discountAmount.toString()).toBe('100'); // net 900
    expect(t.serviceCharge.toString()).toBe('90'); // base 990
    expect(t.taxAmount.toString()).toBe('128.7');
    expect(t.total.toString()).toBe('1118.7');
  });
  it('fixed discount is capped at the subtotal', () => {
    const t = computeTotals({ ...base, subtotal: D('200'), discountType: 'FIXED', discountValue: D('999') });
    expect(t.discountAmount.toString()).toBe('200');
    expect(t.total.toString()).toBe('0');
  });
  it('rejects a discount over 100%', () => {
    expect(() => computeTotals({ ...base, subtotal: D('100'), discountType: 'PERCENTAGE', discountValue: D(101) })).toThrow();
  });
  it('rounds half up to 2 decimals', () => {
    const t = computeTotals({ ...base, subtotal: D('10.05'), taxRatePercent: D(13) });
    expect(t.taxAmount.toString()).toBe('1.31'); // 1.3065
    expect(t.total.toString()).toBe('11.36');
  });
  it('discountPercentOf', () => {
    expect(discountPercentOf({ subtotal: D(200), discountAmount: D(30) }).toString()).toBe('15');
    expect(discountPercentOf({ subtotal: D(0), discountAmount: D(0) }).toString()).toBe('0');
  });
});

describe('allocateProportionally', () => {
  it('parts always sum exactly to the total', () => {
    const parts = allocateProportionally(D('10.00'), [D(1), D(1), D(1)]);
    expect(sum(parts).toString()).toBe('10');
  });
  it('handles zero weights', () => {
    expect(sum(allocateProportionally(D('5'), [D(0), D(0)])).toString()).toBe('5');
  });
});
