import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { badRequest, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const optionParam = z.object({ id: z.coerce.number().int().positive(), optionId: z.coerce.number().int().positive() });
const money = z.coerce.number().min(0).max(100_000).transform((n) => n.toFixed(2));

const groupBase = {
  name: z.string().trim().min(1).max(80),
  minSelections: z.number().int().min(0).max(20),
  maxSelections: z.number().int().min(1).max(20),
  isRequired: z.boolean(),
  isActive: z.boolean(),
};

function checkLimits(g: { minSelections?: number; maxSelections?: number; isRequired?: boolean }) {
  if (g.minSelections !== undefined && g.maxSelections !== undefined && g.minSelections > g.maxSelections) {
    throw badRequest('minSelections cannot be greater than maxSelections');
  }
}

export const modifiersRouter = Router();
modifiersRouter.use(authenticate);

modifiersRouter.get(
  '/groups',
  requirePermission(PERMISSIONS.MENU_VIEW),
  asyncHandler(async (_req, res) => {
    res.json(await prisma.modifierGroup.findMany({ include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { name: 'asc' } }));
  }),
);

modifiersRouter.post(
  '/groups',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({
    body: z
      .object({
        ...groupBase,
        options: z.array(z.object({ name: z.string().trim().min(1).max(80), additionalPrice: money.default('0.00'), sortOrder: z.number().int().default(0) })).max(40).optional(),
      })
      .partial({ minSelections: true, maxSelections: true, isRequired: true, isActive: true }),
  }),
  asyncHandler(async (req, res) => {
    const { options, ...g } = req.body;
    const data = { minSelections: g.isRequired ? 1 : 0, maxSelections: 1, ...g };
    if (data.isRequired && data.minSelections < 1) data.minSelections = 1;
    checkLimits(data);
    const group = await prisma.modifierGroup.create({ data: { ...data, ...(options?.length ? { options: { create: options } } : {}) }, include: { options: true } });
    res.status(201).json(group);
  }),
);

modifiersRouter.patch(
  '/groups/:id',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam, body: z.object(groupBase).partial() }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.modifierGroup.findUnique({ where: { id } });
    if (!existing) throw notFound('Modifier group');
    checkLimits({ minSelections: req.body.minSelections ?? existing.minSelections, maxSelections: req.body.maxSelections ?? existing.maxSelections });
    res.json(await prisma.modifierGroup.update({ where: { id }, data: req.body, include: { options: true } }));
  }),
);

modifiersRouter.post(
  '/groups/:id/options',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(80), additionalPrice: money.default('0.00'), sortOrder: z.number().int().default(0) }) }),
  asyncHandler(async (req, res) => {
    const modifierGroupId = Number(req.params.id);
    if (!(await prisma.modifierGroup.findUnique({ where: { id: modifierGroupId } }))) throw notFound('Modifier group');
    res.status(201).json(await prisma.modifierOption.create({ data: { ...req.body, modifierGroupId } }));
  }),
);

modifiersRouter.patch(
  '/groups/:id/options/:optionId',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({
    params: optionParam,
    body: z.object({ name: z.string().trim().min(1).max(80), additionalPrice: money, isAvailable: z.boolean(), sortOrder: z.number().int() }).partial(),
  }),
  asyncHandler(async (req, res) => {
    const { id, optionId } = req.params as any;
    const before = await prisma.modifierOption.findFirst({ where: { id: Number(optionId), modifierGroupId: Number(id) } });
    if (!before) throw notFound('Modifier option');
    const after = await prisma.modifierOption.update({ where: { id: before.id }, data: req.body });
    if (!before.additionalPrice.equals(after.additionalPrice)) {
      await audit({
        userId: me(req).id,
        action: 'PRICE_EDIT',
        entityType: 'ModifierOption',
        entityId: after.id,
        before: { additionalPrice: before.additionalPrice.toString() },
        after: { additionalPrice: after.additionalPrice.toString() },
      });
    }
    res.json(after);
  }),
);
