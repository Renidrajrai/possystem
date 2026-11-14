import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { pageArgs, pageMeta, paginationSchema } from '../../utils/pagination';

export const auditRouter = Router();
auditRouter.use(authenticate, requirePermission(PERMISSIONS.AUDIT_VIEW));

auditRouter.get(
  '/',
  validate({
    query: paginationSchema.extend({
      userId: z.coerce.number().int().optional(),
      action: z.string().optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<ReturnType<typeof paginationSchema.extend>> & Record<string, any>;
    const where = {
      userId: q.userId,
      action: q.action,
      entityType: q.entityType,
      entityId: q.entityId,
      createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, include: { user: { select: { id: true, name: true } } }, ...pageArgs(q as any) }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ data: rows, meta: pageMeta(q as any, total) });
  }),
);
