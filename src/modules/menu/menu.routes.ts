import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma, Prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { badRequest, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { emit } from '../../realtime/realtime';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const variantParam = z.object({ id: z.coerce.number().int().positive(), variantId: z.coerce.number().int().positive() });
const money = z.coerce.number().min(0).max(1_000_000).transform((n) => n.toFixed(2));

const itemInclude = {
  variants: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] },
  modifierGroups: {
    orderBy: { sortOrder: 'asc' },
    include: {
      modifierGroup: { include: { options: { orderBy: { sortOrder: 'asc' } } } },
    },
  },
} satisfies Prisma.MenuItemInclude;

type ItemWithRels = Awaited<ReturnType<typeof loadItems>>[number];
async function loadItems(where: object) {
  return prisma.menuItem.findMany({ where, include: itemInclude, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
}

function shapeItem(i: ItemWithRels, admin: boolean) {
  const { modifierGroups, ...rest } = i;
  return {
    ...rest,
    modifierGroups: modifierGroups
      .filter((mg) => mg.modifierGroup.isActive)
      .map((mg) => ({
        ...mg.modifierGroup,
        options: mg.modifierGroup.options.filter((o) => admin || o.isAvailable),
      })),
  };
}

export const menuRouter = Router();
menuRouter.use(authenticate);

/**
 * POS menu: categories with their items, variants and modifier groups in one call.
 * Archived (isActive=false) items never appear here. Unavailable items are returned with isAvailable=false
 * so the POS can grey them out.
 */
menuRouter.get(
  '/',
  requirePermission(PERMISSIONS.MENU_VIEW),
  asyncHandler(async (_req, res) => {
    const [categories, items] = await Promise.all([
      prisma.category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      loadItems({ isActive: true, category: { isActive: true } }),
    ]);
    const shaped = items.map((i) => shapeItem(i, false));
    res.json(categories.map((c) => ({ ...c, items: shaped.filter((i) => i.categoryId === c.id) })));
  }),
);

menuRouter.get(
  '/items',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ query: z.object({ categoryId: z.coerce.number().int().optional(), includeArchived: z.coerce.boolean().default(false), q: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const items = await loadItems({
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.includeArchived ? {} : { isActive: true }),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    });
    res.json(items.map((i) => shapeItem(i, true)));
  }),
);

menuRouter.get(
  '/items/:id',
  requirePermission(PERMISSIONS.MENU_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const [item] = await loadItems({ id: Number(req.params.id) });
    if (!item) throw notFound('Menu item');
    res.json(shapeItem(item, can(req.user!, PERMISSIONS.MENU_MANAGE)));
  }),
);

const itemBase = {
  categoryId: z.number().int().positive(),
  kitchenStationId: z.number().int().positive().nullable(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable(),
  imageUrl: z.string().url().max(500).nullable(),
  basePrice: money,
  isAvailable: z.boolean(),
  isActive: z.boolean(),
  preparationTimeMinutes: z.number().int().min(0).max(600).nullable(),
  sortOrder: z.number().int(),
};

async function assertRefs(categoryId?: number, stationId?: number | null) {
  if (categoryId && !(await prisma.category.findUnique({ where: { id: categoryId } }))) throw badRequest('Category not found');
  if (stationId && !(await prisma.kitchenStation.findUnique({ where: { id: stationId } }))) throw badRequest('Kitchen station not found');
}

menuRouter.post(
  '/items',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({
    body: z
      .object({
        ...itemBase,
        variants: z.array(z.object({ name: z.string().trim().min(1).max(60), price: money, sortOrder: z.number().int().default(0) })).max(12).optional(),
        modifierGroupIds: z.array(z.number().int().positive()).max(20).optional(),
      })
      .partial({ kitchenStationId: true, description: true, imageUrl: true, isAvailable: true, isActive: true, preparationTimeMinutes: true, sortOrder: true }),
  }),
  asyncHandler(async (req, res) => {
    const { variants, modifierGroupIds, ...data } = req.body;
    await assertRefs(data.categoryId, data.kitchenStationId);
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.menuItem.create({ data });
      if (variants?.length) await tx.menuItemVariant.createMany({ data: variants.map((v: any) => ({ ...v, menuItemId: created.id })) });
      if (modifierGroupIds?.length) {
        const found = await tx.modifierGroup.count({ where: { id: { in: modifierGroupIds } } });
        if (found !== new Set(modifierGroupIds).size) throw badRequest('One or more modifier groups do not exist');
        await tx.menuItemModifierGroup.createMany({
          data: [...new Set<number>(modifierGroupIds)].map((modifierGroupId, i) => ({ menuItemId: created.id, modifierGroupId, sortOrder: i })),
        });
      }
      return created;
    });
    await audit({ userId: me(req).id, action: 'MENU_ITEM_CREATED', entityType: 'MenuItem', entityId: item.id, after: { name: item.name, basePrice: item.basePrice.toString() } });
    const [full] = await loadItems({ id: item.id });
    res.status(201).json(shapeItem(full, true));
  }),
);

menuRouter.patch(
  '/items/:id',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam, body: z.object(itemBase).partial() }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.menuItem.findUnique({ where: { id } });
    if (!before) throw notFound('Menu item');
    await assertRefs(req.body.categoryId, req.body.kitchenStationId);
    const after = await prisma.menuItem.update({ where: { id }, data: req.body });
    if (req.body.basePrice !== undefined && !before.basePrice.equals(after.basePrice)) {
      await audit({
        userId: me(req).id,
        action: 'PRICE_EDIT',
        entityType: 'MenuItem',
        entityId: id,
        before: { basePrice: before.basePrice.toString() },
        after: { basePrice: after.basePrice.toString() },
      });
    }
    emit('menu:updated', { itemId: id }, ['pos']);
    const [full] = await loadItems({ id });
    res.json(shapeItem(full, true));
  }),
);

// Quick availability toggle (e.g. "out of oat milk"): managers and anyone with menu.availability
menuRouter.patch(
  '/items/:id/availability',
  requirePermission(PERMISSIONS.MENU_AVAILABILITY),
  validate({ params: idParam, body: z.object({ isAvailable: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.menuItem.findUnique({ where: { id } }))) throw notFound('Menu item');
    const item = await prisma.menuItem.update({ where: { id }, data: { isAvailable: req.body.isAvailable } });
    emit('menu:updated', { itemId: id, isAvailable: item.isAvailable }, ['pos']);
    res.json({ id, isAvailable: item.isAvailable });
  }),
);

// Archive (never hard-delete: past orders reference the item)
menuRouter.delete(
  '/items/:id',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.menuItem.findUnique({ where: { id } }))) throw notFound('Menu item');
    await prisma.menuItem.update({ where: { id }, data: { isActive: false } });
    await audit({ userId: me(req).id, action: 'MENU_ITEM_ARCHIVED', entityType: 'MenuItem', entityId: id });
    res.status(204).end();
  }),
);

// ---- Variants ----
menuRouter.post(
  '/items/:id/variants',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(60), price: money, sortOrder: z.number().int().default(0) }) }),
  asyncHandler(async (req, res) => {
    const menuItemId = Number(req.params.id);
    if (!(await prisma.menuItem.findUnique({ where: { id: menuItemId } }))) throw notFound('Menu item');
    const v = await prisma.menuItemVariant.create({ data: { ...req.body, menuItemId } });
    await audit({ userId: me(req).id, action: 'VARIANT_CREATED', entityType: 'MenuItemVariant', entityId: v.id, after: { name: v.name, price: v.price.toString() } });
    res.status(201).json(v);
  }),
);

menuRouter.patch(
  '/items/:id/variants/:variantId',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: variantParam, body: z.object({ name: z.string().trim().min(1).max(60), price: money, sortOrder: z.number().int(), isActive: z.boolean() }).partial() }),
  asyncHandler(async (req, res) => {
    const { id, variantId } = req.params as any;
    const before = await prisma.menuItemVariant.findFirst({ where: { id: Number(variantId), menuItemId: Number(id) } });
    if (!before) throw notFound('Variant');
    const after = await prisma.menuItemVariant.update({ where: { id: before.id }, data: req.body });
    if (!before.price.equals(after.price)) {
      await audit({ userId: me(req).id, action: 'PRICE_EDIT', entityType: 'MenuItemVariant', entityId: after.id, before: { price: before.price.toString() }, after: { price: after.price.toString() } });
    }
    res.json(after);
  }),
);

// ---- Attach modifier groups (many-to-many through the junction table) ----
menuRouter.put(
  '/items/:id/modifier-groups',
  requirePermission(PERMISSIONS.MENU_MANAGE),
  validate({ params: idParam, body: z.object({ modifierGroupIds: z.array(z.number().int().positive()).max(20) }) }),
  asyncHandler(async (req, res) => {
    const menuItemId = Number(req.params.id);
    const ids = [...new Set<number>(req.body.modifierGroupIds)];
    if (!(await prisma.menuItem.findUnique({ where: { id: menuItemId } }))) throw notFound('Menu item');
    if ((await prisma.modifierGroup.count({ where: { id: { in: ids } } })) !== ids.length) throw badRequest('One or more modifier groups do not exist');
    await prisma.$transaction([
      prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId } }),
      prisma.menuItemModifierGroup.createMany({ data: ids.map((modifierGroupId, i) => ({ menuItemId, modifierGroupId, sortOrder: i })) }),
    ]);
    const [full] = await loadItems({ id: menuItemId });
    res.json(shapeItem(full, true));
  }),
);
