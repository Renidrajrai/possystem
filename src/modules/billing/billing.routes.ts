import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requireAnyPermission, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS, type PermissionCode } from '../../config/permissions';
import { badRequest } from '../../utils/errors';
import { pageArgs, pageMeta, paginationSchema } from '../../utils/pagination';
import { localDayRange } from '../../utils/time';
import { discountSchema } from '../orders/orders.routes';
import * as billing from './billing.service';
import * as payments from './payments.service';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * Mounted at the API root (full paths below), so authentication is attached per route
 * instead of with router.use(), which would otherwise guard unrelated routes.
 */
export const billingRouter = Router();
const guard = (...perms: PermissionCode[]) => [authenticate, requirePermission(...perms)];

// Issue (or re-fetch) the bill for an order. Totals are always recalculated on the server.
billingRouter.post(
  '/orders/:id/checkout',
  ...guard(PERMISSIONS.BILL_CHECKOUT),
  validate({ params: idParam, body: z.object({ discount: discountSchema.optional() }).default({}) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await billing.checkout(me(req), Number(req.params.id), req.body.discount));
  }),
);

billingRouter.get(
  '/bills',
  authenticate,
  requireAnyPermission(PERMISSIONS.BILL_CHECKOUT, PERMISSIONS.REPORT_VIEW),
  validate({
    query: paginationSchema.extend({
      orderId: z.coerce.number().int().optional(),
      status: z.enum(['ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID']).optional(),
      date: z.string().optional(),
      q: z.string().trim().max(40).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const range = q.date ? localDayRange(q.date) : undefined;
    const user = me(req);
    const where = {
      orderId: q.orderId,
      status: q.status,
      ...(range ? { issuedAt: { gte: range.start, lt: range.end } } : {}),
      ...(q.q ? { billNumber: { contains: q.q, mode: 'insensitive' as const } } : {}),
      ...(user.permissions.has(PERMISSIONS.ORDER_VIEW_ALL) ? {} : { order: { createdById: user.id } }),
    };
    const [data, total] = await Promise.all([
      prisma.bill.findMany({ where, orderBy: { id: 'desc' }, include: { order: { select: { orderNumber: true, orderType: true } } }, ...pageArgs(q) }),
      prisma.bill.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(q, total) });
  }),
);

billingRouter.get(
  '/bills/:id',
  ...guard(PERMISSIONS.BILL_CHECKOUT),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await billing.getBill(me(req), Number(req.params.id)));
  }),
);

billingRouter.get(
  '/bills/:id/receipt',
  ...guard(PERMISSIONS.BILL_CHECKOUT),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await billing.receipt(me(req), Number(req.params.id)));
  }),
);

billingRouter.post(
  '/bills/:id/void',
  ...guard(PERMISSIONS.BILL_VOID),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(200) }) }),
  asyncHandler(async (req, res) => {
    res.json(await billing.voidBill(me(req), Number(req.params.id), req.body.reason));
  }),
);

billingRouter.post(
  '/bills/:id/adjustments',
  ...guard(PERMISSIONS.BILL_ADJUST),
  validate({
    params: idParam,
    body: z.object({ type: z.enum(['CREDIT', 'DEBIT']), amount: z.number().positive().max(10_000_000), taxAmount: z.number().min(0).optional(), reason: z.string().trim().min(3).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await billing.createAdjustment(me(req), Number(req.params.id), req.body));
  }),
);

// Record a payment. Send a unique `Idempotency-Key` header (e.g. a UUID generated per click/attempt).
billingRouter.post(
  '/bills/:id/payments',
  ...guard(PERMISSIONS.PAYMENT_CREATE),
  validate({
    params: idParam,
    body: z.object({
      paymentMethodId: z.number().int().positive(),
      amount: z.number().positive().max(10_000_000),
      amountTendered: z.number().positive().max(10_000_000).optional(),
      providerReference: z.string().trim().min(2).max(100).optional(),
      idempotencyKey: z.string().trim().min(8).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const key = (req.get('Idempotency-Key') ?? req.body.idempotencyKey ?? '').trim();
    if (key.length < 8 || key.length > 100) throw badRequest('An Idempotency-Key header (8-100 characters) is required');
    const result = await payments.recordPayment(me(req), Number(req.params.id), { ...req.body, idempotencyKey: key });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

billingRouter.post(
  '/payments/:id/refunds',
  ...guard(PERMISSIONS.PAYMENT_REFUND),
  validate({ params: idParam, body: z.object({ amount: z.number().positive().max(10_000_000), reason: z.string().trim().min(3).max(200) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await payments.refundPayment(me(req), Number(req.params.id), req.body));
  }),
);
