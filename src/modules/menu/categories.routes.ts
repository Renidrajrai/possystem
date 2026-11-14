import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const base = {
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullable(),
  imageUrl: z.string().url().max(500).nullable(),
  parentId: z.number().int().positive().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
};

export const categoriesRouter = Router();
categoriesRouter.use(authenticate);

categoriesRouter.get(
  '/',
  requirePermission(PERMISSIONS.MENU_VIEW),
  validate({ query: z.object({ all: z.coerce.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const all = (req.query as any).all && can(req.user!, PERMISSIONS.MENU_MANAGE);
    res.json(await prisma.category.findMany({ where: all ? {} : { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
  }),
);

async function assertValidParent(parentId: number | null | undefined, selfId?: number) {
  if (!parentId) return;
  if (parentId === selfId) throw badRequest('A category cannot be its own parent');
  const parent = await prisma.category.findUnique({ where: { id: parentId } });
  if (!parent) throw badRequest('Parent category not found');
  // prevent cycles
  let cursor = parent.parentId;
  while (cursor && selfId) {
    if (cursor === selfId) throw badRequest('This would create a category loop');
    cursor = (await prisma.category.findUnique({ where: { id: cursor } }))?.parentId ?? null;
  }
}

categoriesRouter.post(
  '/',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ body: z.object(base).partial({ description: true, imageUrl: true, parentId: true, sortOrder: true, isActive: true }) }),
  asyncHandler(async (req, res) => {
    await assertValidParent(req.body.parentId);
    res.status(201).json(await prisma.category.create({ data: req.body }));
  }),
);

categoriesRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam, body: z.object(base).partial() }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.category.findUnique({ where: { id } }))) throw notFound('Category');
    await assertValidParent(req.body.parentId, id);
    res.json(await prisma.category.update({ where: { id }, data: req.body }));
  }),
);

// "Delete" = archive. Categories used by historical items are never hard-deleted.
categoriesRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.category.findUnique({ where: { id } }))) throw notFound('Category');
    const [items, children] = await Promise.all([
      prisma.menuItem.count({ where: { categoryId: id, isActive: true } }),
      prisma.category.count({ where: { parentId: id, isActive: true } }),
    ]);
    if (items || children) throw conflict('Archive or move the active items and subcategories in this category first');
    await prisma.category.update({ where: { id }, data: { isActive: false } });
    await audit({ userId: me(req).id, action: 'CATEGORY_ARCHIVED', entityType: 'Category', entityId: id });
    res.status(204).end();
  }),
);
