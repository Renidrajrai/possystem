import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { notFound } from '../../utils/errors';
import { ticketInclude, updateTicketStatus } from './kitchen.service';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export const kitchenRouter = Router();
kitchenRouter.use(authenticate);

// Active tickets (kitchen display). Default: everything not yet SERVED/CANCELLED, oldest first.
kitchenRouter.get(
  '/tickets',
  requirePermission(PERMISSIONS.KITCHEN_VIEW),
  validate({
    query: z.object({
      stationId: z.coerce.number().int().optional(),
      status: z.enum(['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const tickets = await prisma.kitchenTicket.findMany({
      where: {
        stationId: q.stationId,
        status: q.status ?? { in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] },
      },
      orderBy: { createdAt: 'asc' },
      include: ticketInclude,
    });
    res.json(tickets);
  }),
);

kitchenRouter.get(
  '/tickets/:id',
  requirePermission(PERMISSIONS.KITCHEN_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const t = await prisma.kitchenTicket.findUnique({ where: { id: Number(req.params.id) }, include: ticketInclude });
    if (!t) throw notFound('Ticket');
    res.json(t);
  }),
);

kitchenRouter.patch(
  '/tickets/:id',
  requirePermission(PERMISSIONS.KITCHEN_UPDATE),
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED']),
      reason: z.string().trim().min(3).max(200).optional(), // required when CANCELLED
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await updateTicketStatus(Number(req.params.id), req.body.status, me(req).id, req.body.reason));
  }),
);
