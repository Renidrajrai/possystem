import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { emit } from '../../realtime/realtime';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const OPEN_STATUSES = ['OPEN', 'SENT_TO_KITCHEN', 'IN_PROGRESS', 'READY', 'SERVED'] as const;

export const tablesRouter = Router();
tablesRouter.use(authenticate);

// Floors with their tables and the active order on each table
tablesRouter.get(
  '/',
  requirePermission(PERMISSIONS.TABLE_VIEW),
  asyncHandler(async (_req, res) => {
    const floors = await prisma.floor.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        tables: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          include: {
            orders: {
              where: { fulfilmentStatus: { in: [...OPEN_STATUSES] } },
              select: { id: true, orderNumber: true, totalAmount: true, paymentStatus: true, fulfilmentStatus: true, createdAt: true, guestCount: true },
            },
          },
        },
      },
    });
    res.json(
      floors.map((f) => ({
        ...f,
        tables: f.tables.map(({ orders, ...t }) => ({ ...t, activeOrders: orders })),
      })),
    );
  }),
);

tablesRouter.post(
  '/floors',
  requirePermission(PERMISSIONS.TABLE_MANAGE),
  validate({ body: z.object({ name: z.string().trim().min(1).max(60), sortOrder: z.number().int().default(0) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.floor.create({ data: req.body }));
  }),
);

tablesRouter.patch(
  '/floors/:id',
  requirePermission(PERMISSIONS.TABLE_MANAGE),
  validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(60), sortOrder: z.number().int(), isActive: z.boolean() }).partial() }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (req.body.isActive === false && (await prisma.diningTable.count({ where: { floorId: id, isActive: true } }))) {
      throw conflict('Deactivate the tables on this floor first');
    }
    res.json(await prisma.floor.update({ where: { id }, data: req.body }));
  }),
);

tablesRouter.post(
  '/',
  requirePermission(PERMISSIONS.TABLE_MANAGE),
  validate({ body: z.object({ floorId: z.number().int().positive(), name: z.string().trim().min(1).max(30), capacity: z.number().int().min(1).max(50).default(2) }) }),
  asyncHandler(async (req, res) => {
    if (!(await prisma.floor.findUnique({ where: { id: req.body.floorId } }))) throw badRequest('Floor not found');
    res.status(201).json(await prisma.diningTable.create({ data: req.body }));
  }),
);

tablesRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.TABLE_MANAGE),
  validate({
    params: idParam,
    body: z
      .object({
        name: z.string().trim().min(1).max(30),
        capacity: z.number().int().min(1).max(50),
        floorId: z.number().int().positive(),
        isActive: z.boolean(),
        status: z.enum(['AVAILABLE', 'RESERVED', 'OUT_OF_SERVICE']), // OCCUPIED is set by the order flow only
      })
      .partial(),
  }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const table = await prisma.diningTable.findUnique({ where: { id } });
    if (!table) throw notFound('Table');
    const hasOpen = await prisma.order.count({ where: { tableId: id, fulfilmentStatus: { in: [...OPEN_STATUSES] } } });
    if (hasOpen && (req.body.isActive === false || req.body.status)) throw conflict('This table has an open order');
    const updated = await prisma.diningTable.update({ where: { id }, data: req.body });
    emit('table:updated', updated, ['pos']);
    res.json(updated);
  }),
);
