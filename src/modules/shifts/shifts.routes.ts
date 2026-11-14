import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma, type Tx } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { conflict, forbidden, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { D, ZERO, round2, sum } from '../../utils/money';
import { pageArgs, pageMeta, paginationSchema } from '../../utils/pagination';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const amount = z.number().positive().max(10_000_000);

/**
 * Expected drawer cash = opening + cash sales + cash in - payouts - petty cash - cash drops - cash refunds.
 * (Matches the worked example in the blueprint: 2,000 + 8,000 - 500 = 9,500.)
 */
export async function shiftSummary(tx: Tx | typeof prisma, shiftId: number) {
  const shift = await tx.shift.findUnique({ where: { id: shiftId }, include: { user: { select: { id: true, name: true } } } });
  if (!shift) throw notFound('Shift');
  const [movements, payments, orders] = await Promise.all([
    tx.cashMovement.findMany({ where: { shiftId }, orderBy: { id: 'asc' } }),
    tx.payment.findMany({ where: { shiftId, status: 'SUCCESS' }, include: { paymentMethod: true, refunds: true } }),
    tx.order.count({ where: { shiftId, fulfilmentStatus: { not: 'CANCELLED' } } }),
  ]);
  const by = (t: string) => sum(movements.filter((m) => m.type === t).map((m) => m.amount));
  const cashSales = by('CASH_SALE');
  const cashIn = by('CASH_IN');
  const payouts = by('PAYOUT');
  const pettyCash = by('PETTY_CASH');
  const cashDrops = by('CASH_DROP');
  const refunds = by('REFUND');
  const expected = shift.openingCash.plus(cashSales).plus(cashIn).minus(payouts).minus(pettyCash).minus(cashDrops).minus(refunds);

  const methods = new Map<string, { method: string; count: number; amount: ReturnType<typeof D> }>();
  for (const p of payments) {
    const m = methods.get(p.paymentMethod.name) ?? { method: p.paymentMethod.name, count: 0, amount: ZERO };
    m.count += 1;
    m.amount = m.amount.plus(p.amount);
    methods.set(p.paymentMethod.name, m);
  }
  return {
    shift,
    orders,
    cash: { opening: shift.openingCash, cashSales, cashIn, payouts, pettyCash, cashDrops, refunds, expectedClosing: expected },
    paymentsByMethod: [...methods.values()],
    movements,
  };
}

export const shiftsRouter = Router();
shiftsRouter.use(authenticate);

shiftsRouter.post(
  '/open',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  validate({ body: z.object({ openingCash: z.number().min(0).max(10_000_000), notes: z.string().trim().max(300).optional() }) }),
  asyncHandler(async (req, res) => {
    const user = me(req);
    const shift = await prisma.$transaction(async (tx) => {
      // Serialise per user so two taps cannot open two shifts.
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${user.id} FOR UPDATE`;
      if (await tx.shift.findFirst({ where: { userId: user.id, status: 'OPEN' } })) throw conflict('You already have an open shift');
      return tx.shift.create({ data: { userId: user.id, openingCash: round2(D(req.body.openingCash)), notes: req.body.notes } });
    });
    res.status(201).json(shift);
  }),
);

shiftsRouter.get(
  '/current',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  asyncHandler(async (req, res) => {
    const shift = await prisma.shift.findFirst({ where: { userId: me(req).id, status: 'OPEN' } });
    if (!shift) throw notFound('Open shift');
    res.json(await shiftSummary(prisma, shift.id));
  }),
);

shiftsRouter.post(
  '/current/cash-movements',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  validate({ body: z.object({ type: z.enum(['PAYOUT', 'PETTY_CASH', 'CASH_DROP', 'CASH_IN']), amount, reason: z.string().trim().min(3).max(200) }) }),
  asyncHandler(async (req, res) => {
    const user = me(req);
    const shift = await prisma.shift.findFirst({ where: { userId: user.id, status: 'OPEN' } });
    if (!shift) throw conflict('Open a shift first');
    const m = await prisma.cashMovement.create({ data: { shiftId: shift.id, type: req.body.type, amount: round2(D(req.body.amount)), reason: req.body.reason, createdById: user.id } });
    await audit({ userId: user.id, action: `CASH_${req.body.type}`, entityType: 'Shift', entityId: shift.id, reason: req.body.reason, after: { amount: String(req.body.amount) } });
    res.status(201).json(m);
  }),
);

shiftsRouter.post(
  '/current/close',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  validate({ body: z.object({ actualClosingCash: z.number().min(0).max(10_000_000), notes: z.string().trim().max(300).optional() }) }),
  asyncHandler(async (req, res) => {
    const user = me(req);
    const result = await prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findFirst({ where: { userId: user.id, status: 'OPEN' } });
      if (!shift) throw conflict('You have no open shift');
      const summary = await shiftSummary(tx, shift.id);
      const actual = round2(D(req.body.actualClosingCash));
      const difference = actual.minus(summary.cash.expectedClosing);
      const closed = await tx.shift.update({
        where: { id: shift.id },
        data: { status: 'CLOSED', closedAt: new Date(), expectedClosingCash: summary.cash.expectedClosing, actualClosingCash: actual, cashDifference: difference, notes: req.body.notes ?? shift.notes },
      });
      if (!difference.isZero()) {
        await audit({ userId: user.id, action: 'SHIFT_CASH_DIFFERENCE', entityType: 'Shift', entityId: shift.id, after: { expected: summary.cash.expectedClosing.toString(), actual: actual.toString(), difference: difference.toString() } }, tx);
      }
      return { ...(await shiftSummary(tx, closed.id)), difference };
    });
    res.json(result);
  }),
);

shiftsRouter.get(
  '/',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  validate({ query: paginationSchema.extend({ userId: z.coerce.number().int().optional(), status: z.enum(['OPEN', 'CLOSED']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const user = me(req);
    const where = { status: q.status, userId: can(user, PERMISSIONS.SHIFT_VIEW_ALL) ? q.userId : user.id };
    const [data, total] = await Promise.all([
      prisma.shift.findMany({ where, orderBy: { openedAt: 'desc' }, include: { user: { select: { id: true, name: true } } }, ...pageArgs(q) }),
      prisma.shift.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(q, total) });
  }),
);

shiftsRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const summary = await shiftSummary(prisma, Number(req.params.id));
    if (summary.shift.userId !== me(req).id && !can(me(req), PERMISSIONS.SHIFT_VIEW_ALL)) throw forbidden('You can only view your own shifts');
    res.json(summary);
  }),
);

