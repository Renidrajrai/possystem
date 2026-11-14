import type { FulfilmentStatus } from '@prisma/client';
import type { Tx } from '../../config/prisma';
import { conflict, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { D, sum } from '../../utils/money';
import { computeTotals } from '../billing/calc';
import { getPricingConfig } from '../settings/settings.service';
import { deriveFulfilment } from '../kitchen/transitions';

export const OPEN_FULFILMENT: FulfilmentStatus[] = ['OPEN', 'SENT_TO_KITCHEN', 'IN_PROGRESS', 'READY', 'SERVED'];

/** Row-level lock so concurrent requests on the same order/bill are serialised inside a transaction. */
export async function lockOrder(tx: Tx, orderId: number) {
  const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
  if (rows.length === 0) throw notFound('Order');
}
export async function lockBill(tx: Tx, billId: number) {
  const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "bills" WHERE id = ${billId} FOR UPDATE`;
  if (rows.length === 0) throw notFound('Bill');
}

/** Keep the table's OCCUPIED/AVAILABLE flag in step with whether it has open orders. */
export async function syncTableStatus(tx: Tx, tableId: number | null | undefined) {
  if (!tableId) return;
  const table = await tx.diningTable.findUnique({ where: { id: tableId } });
  if (!table || table.status === 'OUT_OF_SERVICE') return;
  const open = await tx.order.count({ where: { tableId, fulfilmentStatus: { in: OPEN_FULFILMENT } } });
  const next = open > 0 ? 'OCCUPIED' : table.status === 'OCCUPIED' ? 'AVAILABLE' : table.status;
  if (next !== table.status) await tx.diningTable.update({ where: { id: tableId }, data: { status: next } });
}

/** Re-derive the order's fulfilment status from its items (called after kitchen/cancel changes). */
export async function refreshOrderFulfilment(tx: Tx, orderId: number) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { select: { itemStatus: true } } } });
  const next = deriveFulfilment(order.items.map((i) => i.itemStatus), order.fulfilmentStatus);
  if (next !== order.fulfilmentStatus) await tx.order.update({ where: { id: orderId }, data: { fulfilmentStatus: next } });
  return next;
}

/** Close the order once it is fully paid AND fully served. */
export async function maybeCompleteOrder(tx: Tx, orderId: number) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.paymentStatus === 'PAID' && order.fulfilmentStatus === 'SERVED') {
    await tx.order.update({ where: { id: orderId }, data: { fulfilmentStatus: 'COMPLETED', closedAt: new Date() } });
    await syncTableStatus(tx, order.tableId);
    return true;
  }
  return false;
}

/**
 * Recalculate the order's provisional totals from its non-cancelled items.
 * Totals become final only when a bill is issued at checkout.
 */
export async function recalcOrder(tx: Tx, orderId: number) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  const cfg = await getPricingConfig(tx);
  const subtotal = sum(order.items.filter((i) => i.itemStatus !== 'CANCELLED').map((i) => i.lineTotal));
  const totals = computeTotals({
    subtotal,
    discountType: order.discountType,
    discountValue: order.discountValue,
    serviceChargePct: order.orderType === 'DINE_IN' ? cfg.serviceChargePct : D(0),
    taxRatePercent: cfg.taxRatePercent,
    pricesIncludeTax: cfg.pricesIncludeTax,
  });
  await tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      serviceCharge: totals.serviceCharge,
      taxAmount: totals.taxAmount,
      totalAmount: totals.total,
    },
  });
  return totals;
}

/**
 * The order is about to change, so any issued-but-unpaid bill is stale. Void it (kept for the audit trail).
 * If money has already been taken against the bill, the change is refused.
 */
export async function invalidateUnpaidBill(tx: Tx, orderId: number, reason: string, userId: number) {
  const bills = await tx.bill.findMany({ where: { orderId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, include: { payments: true } });
  for (const bill of bills) {
    if (bill.payments.some((p) => p.status === 'SUCCESS' || p.status === 'PENDING')) {
      throw conflict('Payments exist on this order’s bill. Refund and void the bill before changing the order.');
    }
    await tx.bill.update({ where: { id: bill.id }, data: { status: 'VOID', voidReason: reason } });
    await audit({ userId, action: 'BILL_VOID', entityType: 'Bill', entityId: bill.id, reason }, tx);
  }
  if (bills.length) await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'UNPAID' } });
}
