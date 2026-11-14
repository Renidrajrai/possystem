import { prisma } from '../../config/prisma';
import type { AuthUser } from '../../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { nextNumber } from '../../utils/sequence';
import { D, ZERO, round2, sum } from '../../utils/money';
import { emit } from '../../realtime/realtime';
import { getPricingConfig, getSettings } from '../settings/settings.service';
import { canAccessOrder, applyDiscount, type DiscountInput } from '../orders/orders.service';
import { lockBill, lockOrder, maybeCompleteOrder, recalcOrder } from '../orders/order.helpers';
import { lineDescription } from '../orders/pricing';
import { allocateProportionally } from './calc';

const billInclude = { items: { orderBy: { id: 'asc' as const } }, payments: { include: { paymentMethod: true, refunds: true }, orderBy: { id: 'asc' as const } }, adjustmentNotes: true } as const;

// ------------------------------------------------------------------ checkout

/**
 * Issue a bill for an order. The server recalculates EVERYTHING from the database;
 * the client may only suggest a discount (validated against permissions and limits).
 * Idempotent: re-checking out an unchanged, unpaid order returns the same bill.
 */
export async function checkout(user: AuthUser, orderId: number, discount?: DiscountInput) {
  const bill = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!canAccessOrder(user, order)) throw forbidden('You can only check out your own orders');
    if (order.fulfilmentStatus === 'CANCELLED') throw conflict('This order was cancelled');
    if (order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED' || order.paymentStatus === 'PARTIALLY_REFUNDED') throw conflict('This order is already paid');

    const previewBills = await tx.bill.findMany({ where: { orderId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, include: { payments: true } });
    const hasMoney = previewBills.some((b) => b.payments.some((p) => p.status === 'SUCCESS'));
    if (hasMoney && discount) throw conflict('Payments exist on this bill, so the discount can no longer be changed');

    if (discount) await applyDiscount(tx, user, orderId, discount);

    const full = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { include: { modifiers: true }, orderBy: { id: 'asc' } } } });
    const items = full.items.filter((i) => i.itemStatus !== 'CANCELLED');
    if (items.length === 0) throw badRequest('There are no items to bill');

    const totals = await recalcOrder(tx, orderId);
    const cfg = await getPricingConfig(tx);

    // Re-read: applyDiscount above may have voided the open bill(s).
    const activeBills = await tx.bill.findMany({ where: { orderId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, include: { payments: true } });

    // Reuse the open bill if nothing changed; otherwise supersede it.
    for (const b of activeBills) {
      if (b.payments.some((p) => p.status === 'SUCCESS')) {
        if (b.totalDue.equals(totals.total)) return tx.bill.findUniqueOrThrow({ where: { id: b.id }, include: billInclude });
        throw conflict('This order already has payments against a bill with a different total. Void/refund before re-billing.');
      }
      if (b.totalDue.equals(totals.total) && b.tax.equals(totals.taxAmount) && b.subtotal.equals(totals.subtotal) && b.discount.equals(totals.discountAmount)) {
        return tx.bill.findUniqueOrThrow({ where: { id: b.id }, include: billInclude });
      }
      await tx.bill.update({ where: { id: b.id }, data: { status: 'VOID', voidReason: 'Superseded by a new checkout' } });
    }

    const taxPerLine = allocateProportionally(totals.taxAmount, items.map((i) => i.lineTotal));
    const billNumber = await nextNumber(tx, 'BILL', 'INV-');
    const zero = totals.total.isZero();

    const created = await tx.bill.create({
      data: {
        orderId,
        billNumber,
        subtotal: totals.subtotal,
        discount: totals.discountAmount,
        serviceCharge: totals.serviceCharge,
        tax: totals.taxAmount,
        totalDue: totals.total,
        status: zero ? 'PAID' : 'ISSUED',
        paidAt: zero ? new Date() : null,
        items: {
          create: items.map((i, idx) => ({
            descriptionSnapshot: lineDescription(i.itemNameSnapshot, i.variantNameSnapshot, i.modifiers.map((m) => (m.quantity > 1 ? `${m.modifierNameSnapshot} x${m.quantity}` : m.modifierNameSnapshot))),
            quantity: i.quantity,
            unitPrice: i.unitPriceSnapshot,
            // Tax rate and amount are frozen on the bill line at the time of issue.
            taxRate: cfg.taxRatePercent,
            taxAmount: taxPerLine[idx],
            lineTotal: i.lineTotal,
          })),
        },
      },
      include: billInclude,
    });
    if (zero) {
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } });
      await maybeCompleteOrder(tx, orderId);
    }
    return created;
  });
  emit('order:updated', { orderId }, ['pos']);
  return bill;
}

// ------------------------------------------------------------------ bills

export async function getBill(user: AuthUser, billId: number) {
  const bill = await prisma.bill.findUnique({ where: { id: billId }, include: { ...billInclude, order: true } });
  if (!bill) throw notFound('Bill');
  if (!canAccessOrder(user, bill.order)) throw forbidden('You can only view your own bills');
  return bill;
}

/** Everything needed to print a receipt/invoice, with the business details as configured now. */
export async function receipt(user: AuthUser, billId: number) {
  const bill = await getBill(user, billId);
  const [settings, order] = await Promise.all([
    getSettings(),
    prisma.order.findUniqueOrThrow({
      where: { id: bill.orderId },
      include: { table: { select: { name: true } }, customer: { select: { name: true, phone: true, membershipNumber: true } }, createdBy: { select: { name: true } } },
    }),
  ]);
  const paid = sum(bill.payments.filter((p) => p.status === 'SUCCESS').map((p) => p.amount));
  return {
    business: {
      name: settings.businessName,
      address: settings.address,
      phone: settings.phone,
      panNumber: settings.panNumber,
      vatNumber: settings.vatNumber,
      currency: settings.currency,
      footer: settings.receiptFooter,
    },
    bill: {
      id: bill.id,
      billNumber: bill.billNumber,
      status: bill.status,
      issuedAt: bill.issuedAt,
      paidAt: bill.paidAt,
      subtotal: bill.subtotal,
      discount: bill.discount,
      serviceCharge: bill.serviceCharge,
      tax: bill.tax,
      totalDue: bill.totalDue,
      amountPaid: paid,
      balance: bill.totalDue.minus(paid),
    },
    order: { orderNumber: order.orderNumber, orderType: order.orderType, table: order.table?.name ?? null, cashier: order.createdBy.name, guestCount: order.guestCount },
    customer: order.customer,
    items: bill.items,
    payments: bill.payments
      .filter((p) => p.status === 'SUCCESS')
      .map((p) => ({ method: p.paymentMethod.name, amount: p.amount, amountTendered: p.amountTendered, changeGiven: p.changeGiven, reference: p.providerReference, paidAt: p.paidAt })),
    adjustments: bill.adjustmentNotes,
    isDuplicate: false,
  };
}

export async function voidBill(user: AuthUser, billId: number, reason: string) {
  await prisma.$transaction(async (tx) => {
    await lockBill(tx, billId);
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId }, include: { payments: true } });
    if (bill.status === 'VOID') throw conflict('Bill is already void');
    if (bill.payments.some((p) => p.status === 'SUCCESS' || p.status === 'PENDING')) {
      throw conflict('This bill has payments. Refund them first; a paid bill cannot be voided.');
    }
    await tx.bill.update({ where: { id: billId }, data: { status: 'VOID', voidReason: reason } });
    const stillActive = await tx.bill.count({ where: { orderId: bill.orderId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } } });
    if (!stillActive) await tx.order.update({ where: { id: bill.orderId }, data: { paymentStatus: 'UNPAID' } });
    await audit({ userId: user.id, action: 'BILL_VOID', entityType: 'Bill', entityId: billId, reason, before: { status: bill.status, totalDue: bill.totalDue.toString() } }, tx);
  });
  return getBill(user, billId);
}

/** Credit/debit notes correct an issued bill without editing or deleting it. */
export async function createAdjustment(user: AuthUser, billId: number, input: { type: 'CREDIT' | 'DEBIT'; amount: number; taxAmount?: number; reason: string }) {
  return prisma.$transaction(async (tx) => {
    await lockBill(tx, billId);
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId } });
    if (bill.status === 'VOID') throw conflict('Cannot adjust a void bill');
    const amount = round2(D(input.amount));
    if (amount.lessThanOrEqualTo(0)) throw badRequest('Amount must be greater than zero');
    if (input.type === 'CREDIT') {
      const existing = await tx.adjustmentNote.aggregate({ where: { billId, type: 'CREDIT' }, _sum: { amount: true } });
      if ((existing._sum.amount ?? ZERO).plus(amount).greaterThan(bill.totalDue)) throw badRequest('Total credit notes cannot exceed the bill total');
    }
    const noteNumber = await nextNumber(tx, 'NOTE', input.type === 'CREDIT' ? 'CN-' : 'DN-', 5);
    const note = await tx.adjustmentNote.create({
      data: { billId, noteNumber, type: input.type, amount, taxAmount: round2(D(input.taxAmount ?? 0)), reason: input.reason, createdById: user.id },
    });
    await audit({ userId: user.id, action: `${input.type}_NOTE_ISSUED`, entityType: 'Bill', entityId: billId, reason: input.reason, after: { noteNumber, amount: amount.toString() } }, tx);
    return note;
  });
}
