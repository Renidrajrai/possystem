import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { conflict, notFound } from '../../utils/errors';
import { pageArgs, pageMeta, paginationSchema } from '../../utils/pagination';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../../utils/audit';
import * as svc from './customers.service';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export const customersRouter = Router();
customersRouter.use(authenticate);

// Search by phone, name or membership number
customersRouter.get(
  '/',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ query: paginationSchema.extend({ q: z.string().trim().max(50).optional(), includeInactive: z.coerce.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const term: string | undefined = q.q || undefined;
    const digits = term?.replace(/\D/g, '');
    const where = {
      ...(q.includeInactive ? {} : { isActive: true }),
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' as const } },
              { membershipNumber: { contains: term, mode: 'insensitive' as const } },
              ...(digits && digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      prisma.customer.findMany({ where, orderBy: { joinedAt: 'desc' }, ...pageArgs(q) }),
      prisma.customer.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(q, total) });
  }),
);

// Exact lookup used at the counter: GET /customers/lookup?phone=98xxxxxxxx
customersRouter.get(
  '/lookup',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ query: z.object({ phone: z.string().min(5) }) }),
  asyncHandler(async (req, res) => {
    res.json(await svc.lookupByPhone((req.query as any).phone));
  }),
);

customersRouter.post(
  '/',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({
    body: z.object({
      phone: z.string().min(5),
      name: z.string().trim().min(1).max(100).optional(),
      email: z.string().email().optional(),
      notes: z.string().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (await prisma.customer.findUnique({ where: { phone } })) throw conflict('A customer with this phone number already exists');
    const customer = await prisma.$transaction((tx) => svc.createCustomer(tx, req.body));
    res.status(201).json(customer);
  }),
);

customersRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) throw notFound('Customer');
    const [orders, agg] = await Promise.all([
      prisma.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, orderNumber: true, orderType: true, totalAmount: true, paymentStatus: true, fulfilmentStatus: true, createdAt: true },
      }),
      prisma.order.aggregate({
        where: { customerId: id, paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        _count: true,
        _sum: { totalAmount: true },
      }),
    ]);
    res.json({ ...customer, stats: { paidOrders: agg._count, totalSpent: agg._sum.totalAmount ?? '0' }, recentOrders: orders });
  }),
);

customersRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({
    params: idParam,
    body: z
      .object({
        name: z.string().trim().min(1).max(100).nullable(),
        email: z.string().email().nullable(),
        notes: z.string().max(500).nullable(),
        phone: z.string().min(5),
        isActive: z.boolean(),
      })
      .partial(),
  }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) throw notFound('Customer');
    const data: Record<string, unknown> = { ...req.body };
    if (req.body.phone !== undefined) {
      const phone = normalizePhone(req.body.phone);
      if (phone !== existing.phone) {
        if (await prisma.customer.findUnique({ where: { phone } })) throw conflict('Another customer already has this phone number');
        await audit({ userId: me(req).id, action: 'CUSTOMER_PHONE_CHANGED', entityType: 'Customer', entityId: id, before: { phone: existing.phone }, after: { phone } });
      }
      data.phone = phone; // membershipNumber never changes when the phone changes
    }
    res.json(await prisma.customer.update({ where: { id }, data }));
  }),
);
