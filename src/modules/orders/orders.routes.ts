import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { pageArgs, pageMeta, paginationSchema } from '../../utils/pagination';
import { localDayRange } from '../../utils/time';
import { sendToKitchen } from '../kitchen/kitchen.service';
import { OPEN_FULFILMENT } from './order.helpers';
import * as svc from './orders.service';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const itemParam = z.object({ id: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() });

const lineSchema = z.object({
  menuItemId: z.number().int().positive(),
  variantId: z.number().int().positive().nullish(),
  quantity: z.number().int().min(1).max(99),
  notes: z.string().trim().max(200).nullish(),
  modifiers: z.array(z.object({ optionId: z.number().int().positive(), quantity: z.number().int().min(1).max(10).optional() })).max(20).optional(),
});

export const discountSchema = z.object({
  type: z.enum(['NONE', 'FIXED', 'PERCENTAGE']),
  value: z.number().positive().max(10_000_000).optional(),
  reason: z.string().trim().max(200).optional(),
});

export const ordersRouter = Router();
ordersRouter.use(authenticate);

const listQuery = paginationSchema.extend({
  fulfilmentStatus: z.enum(['OPEN', 'SENT_TO_KITCHEN', 'IN_PROGRESS', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED']).optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOID']).optional(),
  orderType: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).optional(),
  tableId: z.coerce.number().int().optional(),
  customerId: z.coerce.number().int().optional(),
  createdById: z.coerce.number().int().optional(),
  date: z.string().optional(), // café-local day, YYYY-MM-DD
  q: z.string().trim().max(50).optional(), // order number, customer name / phone / membership no.
});

const listWhere = (req: any, q: any) => {
  const user = me(req);
  const digits = q.q?.replace(/\D/g, '');
  const range = q.date ? localDayRange(q.date) : undefined;
  return {
    ...(can(user, PERMISSIONS.ORDER_VIEW_ALL) ? { createdById: q.createdById } : { createdById: user.id }),
    fulfilmentStatus: q.fulfilmentStatus,
    paymentStatus: q.paymentStatus,
    orderType: q.orderType,
    tableId: q.tableId,
    customerId: q.customerId,
    ...(range ? { createdAt: { gte: range.start, lt: range.end } } : {}),
    ...(q.q
      ? {
          OR: [
            { orderNumber: { contains: q.q, mode: 'insensitive' as const } },
            { customer: { name: { contains: q.q, mode: 'insensitive' as const } } },
            { customer: { membershipNumber: { contains: q.q, mode: 'insensitive' as const } } },
            ...(digits && digits.length >= 3 ? [{ customer: { phone: { contains: digits } } }] : []),
          ],
        }
      : {}),
  };
};

// Order history / search
ordersRouter.get(
  '/',
  requirePermission(PERMISSIONS.ORDER_VIEW),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const where = listWhere(req, q);
    const [data, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, include: svc.orderInclude, ...pageArgs(q) }),
      prisma.order.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(q, total) });
  }),
);

// Open tabs for the POS screen
ordersRouter.get(
  '/active',
  requirePermission(PERMISSIONS.ORDER_VIEW),
  asyncHandler(async (req, res) => {
    const user = me(req);
    const where = { fulfilmentStatus: { in: OPEN_FULFILMENT }, ...(can(user, PERMISSIONS.ORDER_VIEW_ALL) ? {} : { createdById: user.id }) };
    res.json(await prisma.order.findMany({ where, orderBy: { createdAt: 'asc' }, include: svc.orderInclude }));
  }),
);

ordersRouter.post(
  '/',
  requirePermission(PERMISSIONS.ORDER_CREATE),
  validate({
    body: z.object({
      orderType: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
      tableId: z.number().int().positive().optional(),
      customerId: z.number().int().positive().optional(),
      customerPhone: z.string().trim().min(5).max(30).optional(), // finds or registers the member
      customerName: z.string().trim().max(100).optional(),
      guestCount: z.number().int().min(1).max(100).optional(),
      notes: z.string().trim().max(300).optional(),
      items: z.array(lineSchema).min(1).max(60),
      sendToKitchen: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.createOrder(me(req), req.body));
  }),
);

ordersRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.ORDER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.getOrder(me(req), Number(req.params.id)));
  }),
);

// Add items to an open order (items added after a KOT go out as a new ticket batch)
ordersRouter.post(
  '/:id/items',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: idParam, body: z.object({ items: z.array(lineSchema).min(1).max(60), sendToKitchen: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.addItems(me(req), Number(req.params.id), req.body.items, req.body.sendToKitchen));
  }),
);

ordersRouter.patch(
  '/:id/items/:itemId',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: itemParam, body: z.object({ quantity: z.number().int().min(1).max(99), notes: z.string().trim().max(200).nullable() }).partial() }),
  asyncHandler(async (req, res) => {
    const p = req.params as any;
    res.json(await svc.updateItem(me(req), Number(p.id), Number(p.itemId), req.body));
  }),
);

ordersRouter.post(
  '/:id/items/:itemId/cancel',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: itemParam, body: z.object({ reason: z.string().trim().min(3).max(200) }) }),
  asyncHandler(async (req, res) => {
    const p = req.params as any;
    res.json(await svc.cancelItem(me(req), Number(p.id), Number(p.itemId), req.body.reason));
  }),
);

ordersRouter.post(
  '/:id/send-to-kitchen',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await svc.getOrder(me(req), id); // access check
    const tickets = await sendToKitchen(id, me(req).id);
    res.status(201).json(tickets);
  }),
);

ordersRouter.patch(
  '/:id/discount',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: idParam, body: discountSchema }),
  asyncHandler(async (req, res) => {
    res.json(await svc.setDiscount(me(req), Number(req.params.id), req.body));
  }),
);

ordersRouter.post(
  '/:id/move-table',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: idParam, body: z.object({ tableId: z.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json(await svc.moveTable(me(req), Number(req.params.id), req.body.tableId));
  }),
);

ordersRouter.post(
  '/:id/merge',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: idParam, body: z.object({ sourceOrderId: z.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    // POST /orders/:id/merge { sourceOrderId } -> :id is the surviving order
    res.json(await svc.mergeOrders(me(req), req.body.sourceOrderId, Number(req.params.id)));
  }),
);

ordersRouter.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.ORDER_CANCEL),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(200) }) }),
  asyncHandler(async (req, res) => {
    res.json(await svc.cancelOrder(me(req), Number(req.params.id), req.body.reason));
  }),
);

ordersRouter.post(
  '/:id/complete',
  requirePermission(PERMISSIONS.ORDER_UPDATE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await svc.completeOrder(me(req), Number(req.params.id)));
  }),
);
