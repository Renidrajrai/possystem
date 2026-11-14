import { D, ZERO, min, round2, sum, type Money } from '../../utils/money';
import { badRequest } from '../../utils/errors';

export type DiscountType = 'NONE' | 'FIXED' | 'PERCENTAGE';

export interface TotalsInput {
  subtotal: Money;
  discountType: DiscountType;
  discountValue: Money;
  /** Percentage; pass 0 for non-dine-in orders. */
  serviceChargePct: Money;
  taxRatePercent: Money;
  /** true = item prices already contain tax (tax is extracted, not added). */
  pricesIncludeTax: boolean;
}

export interface Totals {
  subtotal: Money;
  discountAmount: Money;
  serviceCharge: Money;
  taxAmount: Money;
  total: Money;
}

/**
 * Single source of truth for order/bill maths. Runs ONLY on the server.
 *   net     = subtotal - discount
 *   service = net * service%
 *   base    = net + service
 *   tax     = base * rate%            (prices exclude tax)  -> total = base + tax
 *           = base * rate/(100+rate)  (prices include tax)  -> total = base
 */
export function computeTotals(i: TotalsInput): Totals {
  const subtotal = round2(i.subtotal);
  let discountAmount = ZERO;
  if (i.discountType === 'FIXED') {
    discountAmount = min(round2(i.discountValue), subtotal);
  } else if (i.discountType === 'PERCENTAGE') {
    if (i.discountValue.greaterThan(100)) throw badRequest('Discount percentage cannot exceed 100');
    discountAmount = round2(subtotal.times(i.discountValue).div(100));
  }
  if (discountAmount.isNegative()) throw badRequest('Discount cannot be negative');

  const net = subtotal.minus(discountAmount);
  const serviceCharge = round2(net.times(i.serviceChargePct).div(100));
  const base = net.plus(serviceCharge);

  let taxAmount: Money;
  let total: Money;
  if (i.pricesIncludeTax) {
    taxAmount = round2(base.times(i.taxRatePercent).div(D(100).plus(i.taxRatePercent)));
    total = base;
  } else {
    taxAmount = round2(base.times(i.taxRatePercent).div(100));
    total = base.plus(taxAmount);
  }
  return { subtotal, discountAmount, serviceCharge, taxAmount, total };
}

/** Effective discount as a percentage of subtotal (used for the cashier discount limit). */
export function discountPercentOf(totals: Pick<Totals, 'subtotal' | 'discountAmount'>): Money {
  if (totals.subtotal.isZero()) return ZERO;
  return totals.discountAmount.div(totals.subtotal).times(100);
}

/**
 * Split an amount across lines proportionally to their weights so the parts add up EXACTLY to the
 * total (any rounding remainder goes to the last line).
 */
export function allocateProportionally(total: Money, weights: Money[]): Money[] {
  const weightSum = sum(weights);
  if (weights.length === 0) return [];
  if (weightSum.isZero()) {
    const out = weights.map(() => ZERO);
    out[out.length - 1] = total;
    return out;
  }
  const parts: Money[] = [];
  let allocated = ZERO;
  weights.forEach((w, idx) => {
    if (idx === weights.length - 1) {
      parts.push(total.minus(allocated));
    } else {
      const part = round2(total.times(w).div(weightSum));
      parts.push(part);
      allocated = allocated.plus(part);
    }
  });
  return parts;
}
