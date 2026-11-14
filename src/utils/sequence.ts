import type { Tx } from '../config/prisma';

/**
 * Gap-free, race-safe numbering (order / bill / KOT / note numbers).
 * The upsert takes a row lock, so concurrent transactions get distinct numbers.
 * Call INSIDE the same transaction that uses the number.
 */
export async function nextNumber(tx: Tx, key: 'ORDER' | 'BILL' | 'KOT' | 'NOTE', prefix: string, pad = 6): Promise<string> {
  const row = await tx.invoiceSequence.upsert({
    where: { key },
    create: { key, prefix: key === 'NOTE' ? '' : prefix, nextNumber: 2 }, // NOTE keeps prefix per call (CN-/DN-)
    update: { nextNumber: { increment: 1 } },
  });
  const issued = row.nextNumber - 1;
  return `${row.prefix || prefix}${String(issued).padStart(pad, '0')}`;
}
