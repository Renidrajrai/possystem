import { prisma, Prisma } from '../../config/prisma';
import type { AuthUser } from '../../middleware/auth';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { D, ZERO, round2, sum } from '../../utils/money';
import { emit } from '../../realtime/realtime';
import { canAccessOrder } from '../orders/orders.service';
import { lockBill, maybeCompleteOrder } from '../orders/order.helpers';

export interface PaymentInput {
  paymentMethodId: number;
  amount: number;
  amountTendered?: number;
  providerReference?: string;
  idempotencyKey: string;
}

const same = (p: { billId: number; paymentMethodId: number; amount: Prisma.Decimal }, billId: number, i: PaymentInput) =>
  p.billId === billId && p.paymentMethodId === i.paymentMethodId && p.amount.equals(round2(D(i.amount)));

/**
 * Record a payment against a bill.
 *  - Never trusts the client for what is owed: the bill (computed server-side) decides the outstanding balance.
 *  - Idempotent: the same Idempotency-Key replays the original result, so double-clicks/retries cannot double-charge.
 *  - Runs under a row lock on the bill, so two cashiers cannot over-pay the same bill at once.
 *  - Manual methods only (cash, QR/card terminal slips): the cashier is confirming money received.
 *    Gateway-confirmed payments need provider verification before they may be marked successful (see README).
 */
export async function recordPayment(user: AuthUser, billId: number, input: PaymentInput) {
  const amount = round2(D(input.amount));
  if (amount.lessThanOrEqualTo(0)) throw badRequest('Payment amount must be greater than zero');

  // Fast path for retries
  const replay = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return replayResult(replay, billId, input);

  const result = await prisma.$transaction(async (tx) => {
    await lockBill(tx, billId);
    const again = await tx.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (again) return { replayed: again };

    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId }, include: { order: true, payments: true } });
    if (!canAccessOrder(user, bill.order)) throw conflict('You can only take payment on your own orders');
    if (bill.status === 'VOID') throw conflict('This bill is void');
    if (bill.status === 'PAID') throw conflict('This bill is already fully paid');

    const method = await tx.paymentMethod.findUnique({ where: { id: input.paymentMethodId } });
    if (!method || !method.isActive) throw badRequest('Payment method not available');
    if (method.requiresReference && !input.providerReference?.trim()) throw badRequest(`${method.name} payments need a transaction reference`);

    const reference = input.providerReference?.trim() || null;
    if (reference && (await tx.payment.findUnique({ where: { providerReference: reference } }))) {
      throw conflict('This transaction reference has already been recorded');
    }

    const paidSoFar = sum(bill.payments.filter((p) => p.status === 'SUCCESS').map((p) => p.amount));
    const outstanding = bill.totalDue.minus(paidSoFar);
    if (amount.greaterThan(outstanding)) throw badRequest(`Amount exceeds the balance due (${outstanding.toString()})`);

    let tendered: Prisma.Decimal | null = null;
    let change: Prisma.Decimal | null = null;
    let shiftId: number | null = null;
    const shift = await tx.shift.findFirst({ where: { userId: user.id, status: 'OPEN' }, select: { id: true } });
    shiftId = shift?.id ?? null;

    if (method.isCash) {
      if (!shift) throw conflict('Open a shift before taking cash payments');
      tendered = input.amountTendered !== undefined ? round2(D(input.amountTendered)) : amount;
      if (tendered.lessThan(amount)) throw badRequest('Cash received is less than the amount being paid');
      change = tendered.minus(amount);
    } else if (input.amountTendered !== undefined) {
      throw badRequest('amountTendered only applies to cash payments');
    }

    const payment = await tx.payment.create({
      data: {
        billId,
        paymentMethodId: method.id,
        receivedById: user.id,
        shiftId,
        amount,
        amountTendered: tendered,
        changeGiven: change,
        status: 'SUCCESS',
        providerReference: reference,
        idempotencyKey: input.idempotencyKey,
        paidAt: new Date(),
      },
      include: { paymentMethod: true },
    });

    if (method.isCash && shiftId) {
      await tx.cashMovement.create({ data: { shiftId, type: 'CASH_SALE', amount, reason: `Bill ${bill.billNumber}`, createdById: user.id } });
    }

    const nowPaid = paidSoFar.plus(amount);
    const full = nowPaid.greaterThanOrEqualTo(bill.totalDue);
    const updatedBill = await tx.bill.update({
      where: { id: billId },
      data: { amountPaid: nowPaid, status: full ? 'PAID' : 'PARTIALLY_PAID', paidAt: full ? new Date() : null },
    });
    await tx.order.update({ where: { id: bill.orderId }, data: { paymentStatus: full ? 'PAID' : 'PARTIALLY_PAID' } });
    if (full) await maybeCompleteOrder(tx, bill.orderId);

    return { payment, bill: updatedBill, orderId: bill.orderId };
  });

  if ('replayed' in result && result.replayed) return replayResult(result.replayed, billId, input);
  const ok = result as { payment: Prisma.PaymentGetPayload<{ include: { paymentMethod: true } }>; bill: Prisma.BillGetPayload<object>; orderId: number };
  emit('order:updated', { orderId: ok.orderId }, ['pos']);
  return { replayed: false, payment: ok.payment, bill: ok.bill, changeDue: ok.payment.changeGiven ?? ZERO };
}

async function replayResult(existing: Prisma.PaymentGetPayload<object>, billId: number, input: PaymentInput) {
  if (!same(existing, billId, input)) throw conflict('This Idempotency-Key was already used for a different payment');
  const [payment, bill] = await Promise.all([
    prisma.payment.findUniqueOrThrow({ where: { id: existing.id }, include: { paymentMethod: true } }),
    prisma.bill.findUniqueOrThrow({ where: { id: billId } }),
  ]);
  return { replayed: true, payment, bill, changeDue: payment.changeGiven ?? ZERO };
}

/** Refund (part of) a successful payment. Original payment/bill are preserved; the refund is a new record. */
export async function refundPayment(user: AuthUser, paymentId: number, input: { amount: number; reason: string }) {
  const amount = round2(D(input.amount));
  if (amount.lessThanOrEqualTo(0)) throw badRequest('Refund amount must be greater than zero');

  const refund = await prisma.$transaction(async (tx) => {
    const p0 = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!p0) throw notFound('Payment');
    await lockBill(tx, p0.billId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { refunds: true, paymentMethod: true, bill: true } });
    if (payment.status !== 'SUCCESS') throw conflict('Only successful payments can be refunded');
    const remaining = payment.amount.minus(sum(payment.refunds.map((r) => r.amount)));
    if (amount.greaterThan(remaining)) throw badRequest(`Refund exceeds the refundable amount (${remaining.toString()})`);

    let shiftId: number | null = null;
    if (payment.paymentMethod.isCash) {
      const shift = await tx.shift.findFirst({ where: { userId: user.id, status: 'OPEN' }, select: { id: true } });
      if (!shift) throw conflict('Open a shift to pay out a cash refund');
      shiftId = shift.id;
    }

    const created = await tx.refund.create({ data: { paymentId, amount, reason: input.reason, processedById: user.id } });
    if (shiftId) await tx.cashMovement.create({ data: { shiftId, type: 'REFUND', amount, reason: `Refund on bill ${payment.bill.billNumber}`, createdById: user.id } });

    const allPayments = await tx.payment.findMany({ where: { bill: { orderId: payment.bill.orderId }, status: 'SUCCESS' }, include: { refunds: true } });
    const paid = sum(allPayments.map((x) => x.amount));
    const refunded = sum(allPayments.flatMap((x) => x.refunds.map((r) => r.amount)));
    await tx.order.update({ where: { id: payment.bill.orderId }, data: { paymentStatus: refunded.greaterThanOrEqualTo(paid) ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });

    await audit({ userId: user.id, action: 'REFUND', entityType: 'Payment', entityId: paymentId, reason: input.reason, after: { amount: amount.toString(), billNumber: payment.bill.billNumber } }, tx);
    return created;
  });
  return refund;
}
