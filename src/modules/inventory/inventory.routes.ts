import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { D, sum } from '../../utils/money';
import { pageArgs, pageMeta, paginationSchema } from '../../utils/pagination';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const qty = z.number().positive().max(10_000_000);
const view = requirePermission(PERMISSIONS.INVENTORY_VIEW);
const manage = requirePermission(PERMISSIONS.INVENTORY_MANAGE);

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

// ---------------- Ingredients ----------------
inventoryRouter.get(
  '/items',
  view,
  validate({ query: z.object({ q: z.string().optional(), lowStock: z.coerce.boolean().default(false), includeInactive: z.coerce.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const items = await prisma.inventoryItem.findMany({
      where: { ...(q.includeInactive ? {} : { isActive: true }), ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}) },
      orderBy: { name: 'asc' },
    });
    res.json(q.lowStock ? items.filter((i) => i.currentQuantity.lessThanOrEqualTo(i.reorderLevel)) : items);
  }),
);

const itemBody = z.object({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(50).nullable(),
  unit: z.enum(['g', 'kg', 'ml', 'litre', 'piece']),
  reorderLevel: z.number().min(0),
  costPerUnit: z.number().min(0),
  isActive: z.boolean(),
});

inventoryRouter.post(
  '/items',
  manage,
  validate({ body: itemBody.partial({ sku: true, reorderLevel: true, costPerUnit: true, isActive: true }).extend({ openingQuantity: z.number().min(0).optional() }) }),
  asyncHandler(async (req, res) => {
    const { openingQuantity, ...data } = req.body;
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({ data: { ...data, currentQuantity: openingQuantity ?? 0 } });
      if (openingQuantity) {
        await tx.stockMovement.create({ data: { inventoryItemId: created.id, movementType: 'COUNT_ADJUSTMENT', quantityDelta: openingQuantity, unitCost: created.costPerUnit, note: 'Opening stock', createdById: me(req).id } });
      }
      return created;
    });
    res.status(201).json(item);
  }),
);

inventoryRouter.patch(
  '/items/:id',
  manage,
  validate({ params: idParam, body: itemBody.partial() }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.inventoryItem.findUnique({ where: { id } }))) throw notFound('Inventory item');
    res.json(await prisma.inventoryItem.update({ where: { id }, data: req.body }));
  }),
);

// ---------------- Stock adjustments (wastage, returns, counts) ----------------
inventoryRouter.post(
  '/items/:id/adjust',
  manage,
  validate({
    params: idParam,
    body: z.discriminatedUnion('type', [
      z.object({ type: z.literal('WASTAGE'), quantity: qty, reason: z.string().trim().min(3).max(200) }),
      z.object({ type: z.literal('RETURN'), quantity: qty, reason: z.string().trim().min(3).max(200) }), // back to supplier (stock out)
      z.object({ type: z.literal('COUNT'), countedQuantity: z.number().min(0).max(100_000_000), reason: z.string().trim().min(3).max(200) }), // stock take
    ]),
  }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body;
    const user = me(req);
    const movement = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "inventory_items" WHERE id = ${id} FOR UPDATE`;
      const item = await tx.inventoryItem.findUnique({ where: { id } });
      if (!item) throw notFound('Inventory item');
      let delta;
      let movementType: 'WASTAGE' | 'RETURN' | 'COUNT_ADJUSTMENT';
      if (b.type === 'COUNT') {
        delta = D(b.countedQuantity).minus(item.currentQuantity);
        movementType = 'COUNT_ADJUSTMENT';
      } else {
        delta = D(b.quantity).negated();
        movementType = b.type;
      }
      if (delta.isZero()) throw badRequest('Nothing to adjust');
      const m = await tx.stockMovement.create({
        data: { inventoryItemId: id, movementType, quantityDelta: delta, unitCost: item.costPerUnit, note: b.reason, createdById: user.id },
      });
      await tx.inventoryItem.update({ where: { id }, data: { currentQuantity: { increment: delta } } });
      await audit({ userId: user.id, action: `STOCK_${movementType}`, entityType: 'InventoryItem', entityId: id, reason: b.reason, after: { delta: delta.toString() } }, tx);
      return m;
    });
    res.status(201).json(movement);
  }),
);

inventoryRouter.get(
  '/movements',
  view,
  validate({
    query: paginationSchema.extend({
      inventoryItemId: z.coerce.number().int().optional(),
      type: z.enum(['PURCHASE_RECEIVED', 'RECIPE_CONSUMPTION', 'CONSUMPTION_REVERSAL', 'WASTAGE', 'RETURN', 'COUNT_ADJUSTMENT']).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const where = { inventoryItemId: q.inventoryItemId, movementType: q.type, ...(q.from || q.to ? { createdAt: { gte: q.from, lte: q.to } } : {}) };
    const [data, total] = await Promise.all([
      prisma.stockMovement.findMany({ where, orderBy: { id: 'desc' }, include: { inventoryItem: { select: { name: true, unit: true } } }, ...pageArgs(q) }),
      prisma.stockMovement.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(q, total) });
  }),
);

// The cached current_quantity must equal the sum of the ledger. Reports any drift.
inventoryRouter.get(
  '/reconcile',
  view,
  asyncHandler(async (_req, res) => {
    const [items, sums] = await Promise.all([
      prisma.inventoryItem.findMany({ select: { id: true, name: true, currentQuantity: true } }),
      prisma.stockMovement.groupBy({ by: ['inventoryItemId'], _sum: { quantityDelta: true } }),
    ]);
    const ledger = new Map(sums.map((s) => [s.inventoryItemId, s._sum.quantityDelta ?? D(0)]));
    const drift = items
      .map((i) => ({ id: i.id, name: i.name, cached: i.currentQuantity, ledger: ledger.get(i.id) ?? D(0) }))
      .filter((r) => !r.cached.equals(r.ledger))
      .map((r) => ({ ...r, difference: r.cached.minus(r.ledger) }));
    res.json({ ok: drift.length === 0, drift });
  }),
);

// ---------------- Recipes ----------------
inventoryRouter.get(
  '/recipes',
  view,
  validate({ query: z.object({ menuItemId: z.coerce.number().int().optional() }) }),
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.recipe.findMany({
        where: { menuItemId: (req.query as any).menuItemId, isActive: true },
        include: { items: { include: { inventoryItem: { select: { name: true, unit: true, costPerUnit: true } } } }, menuItem: { select: { name: true } }, variant: { select: { name: true } } },
      }),
    );
  }),
);

// Create or replace the recipe for a menu item (or a specific variant).
inventoryRouter.put(
  '/recipes',
  manage,
  validate({
    body: z.object({
      menuItemId: z.number().int().positive(),
      variantId: z.number().int().positive().nullable().default(null),
      name: z.string().trim().min(1).max(120).optional(),
      yieldQuantity: z.number().int().min(1).max(1000).default(1),
      items: z.array(z.object({ inventoryItemId: z.number().int().positive(), quantityRequired: qty })).min(1).max(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const menuItem = await prisma.menuItem.findUnique({ where: { id: b.menuItemId }, include: { variants: true } });
    if (!menuItem) throw badRequest('Menu item not found');
    if (b.variantId && !menuItem.variants.some((v) => v.id === b.variantId)) throw badRequest('Variant does not belong to this menu item');
    const ids = [...new Set<number>(b.items.map((i: any) => i.inventoryItemId))];
    if (ids.length !== b.items.length) throw badRequest('Each ingredient can appear only once in a recipe');
    const inv = await prisma.inventoryItem.findMany({ where: { id: { in: ids } } });
    if (inv.length !== ids.length) throw badRequest('One or more ingredients do not exist');
    const unitOf = new Map(inv.map((i) => [i.id, i.unit]));

    const recipe = await prisma.$transaction(async (tx) => {
      const existing = await tx.recipe.findFirst({ where: { menuItemId: b.menuItemId, variantId: b.variantId } });
      if (existing) await tx.recipeItem.deleteMany({ where: { recipeId: existing.id } });
      const data = { name: b.name ?? menuItem.name, yieldQuantity: b.yieldQuantity, isActive: true };
      const r = existing
        ? await tx.recipe.update({ where: { id: existing.id }, data })
        : await tx.recipe.create({ data: { ...data, menuItemId: b.menuItemId, variantId: b.variantId } });
      await tx.recipeItem.createMany({ data: b.items.map((i: any) => ({ recipeId: r.id, inventoryItemId: i.inventoryItemId, quantityRequired: i.quantityRequired, unit: unitOf.get(i.inventoryItemId)! })) });
      return tx.recipe.findUniqueOrThrow({ where: { id: r.id }, include: { items: true } });
    });
    res.json(recipe);
  }),
);

inventoryRouter.delete(
  '/recipes/:id',
  manage,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.recipe.findUnique({ where: { id } }))) throw notFound('Recipe');
    await prisma.recipe.update({ where: { id }, data: { isActive: false } });
    res.status(204).end();
  }),
);

// ---------------- Suppliers & purchase orders ----------------
const supplierBody = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).nullable(),
  email: z.string().email().nullable(),
  address: z.string().max(300).nullable(),
  notes: z.string().max(500).nullable(),
  isActive: z.boolean(),
});
const supplierMgr = requirePermission(PERMISSIONS.SUPPLIER_MANAGE);

inventoryRouter.get('/suppliers', supplierMgr, asyncHandler(async (_req, res) => {
  res.json(await prisma.supplier.findMany({ orderBy: { name: 'asc' } }));
}));

inventoryRouter.post(
  '/suppliers',
  supplierMgr,
  validate({ body: supplierBody.partial({ phone: true, email: true, address: true, notes: true, isActive: true }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.supplier.create({ data: req.body }));
  }),
);

inventoryRouter.patch(
  '/suppliers/:id',
  supplierMgr,
  validate({ params: idParam, body: supplierBody.partial() }),
  asyncHandler(async (req, res) => {
    res.json(await prisma.supplier.update({ where: { id: Number(req.params.id) }, data: req.body }));
  }),
);

const poInclude = { supplier: { select: { id: true, name: true } }, items: { include: { inventoryItem: { select: { name: true, unit: true } } } } } as const;

inventoryRouter.get(
  '/purchase-orders',
  supplierMgr,
  validate({ query: paginationSchema.extend({ status: z.enum(['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']).optional(), supplierId: z.coerce.number().int().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const where = { status: q.status, supplierId: q.supplierId };
    const [data, total] = await Promise.all([
      prisma.purchaseOrder.findMany({ where, orderBy: { id: 'desc' }, include: poInclude, ...pageArgs(q) }),
      prisma.purchaseOrder.count({ where }),
    ]);
    res.json({ data, meta: pageMeta(q, total) });
  }),
);

inventoryRouter.get(
  '/purchase-orders/:id',
  supplierMgr,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: Number(req.params.id) }, include: poInclude });
    if (!po) throw notFound('Purchase order');
    res.json(po);
  }),
);

inventoryRouter.post(
  '/purchase-orders',
  supplierMgr,
  validate({
    body: z.object({
      supplierId: z.number().int().positive(),
      markOrdered: z.boolean().default(false),
      items: z.array(z.object({ inventoryItemId: z.number().int().positive(), quantityOrdered: qty, unitCost: z.number().min(0) })).min(1).max(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!(await prisma.supplier.findUnique({ where: { id: b.supplierId } }))) throw badRequest('Supplier not found');
    const ids = [...new Set<number>(b.items.map((i: any) => i.inventoryItemId))];
    if ((await prisma.inventoryItem.count({ where: { id: { in: ids } } })) !== ids.length) throw badRequest('One or more ingredients do not exist');
    const total = sum(b.items.map((i: any) => D(i.quantityOrdered).times(i.unitCost))).toDecimalPlaces(2);
    const po = await prisma.purchaseOrder.create({
      data: {
        supplierId: b.supplierId,
        createdById: me(req).id,
        status: b.markOrdered ? 'ORDERED' : 'DRAFT',
        orderedAt: b.markOrdered ? new Date() : null,
        totalCost: total,
        items: { create: b.items },
      },
      include: poInclude,
    });
    res.status(201).json(po);
  }),
);

inventoryRouter.post(
  '/purchase-orders/:id/mark-ordered',
  supplierMgr,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw notFound('Purchase order');
    if (po.status !== 'DRAFT') throw conflict('Only draft purchase orders can be marked as ordered');
    res.json(await prisma.purchaseOrder.update({ where: { id }, data: { status: 'ORDERED', orderedAt: new Date() }, include: poInclude }));
  }),
);

inventoryRouter.post(
  '/purchase-orders/:id/cancel',
  supplierMgr,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
    if (!po) throw notFound('Purchase order');
    if (po.status === 'RECEIVED' || po.items.some((i) => i.quantityReceived.greaterThan(0))) throw conflict('Stock was already received against this purchase order');
    res.json(await prisma.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' }, include: poInclude }));
  }),
);

// Receive goods: creates PURCHASE_RECEIVED ledger entries and updates stock and last cost.
inventoryRouter.post(
  '/purchase-orders/:id/receive',
  supplierMgr,
  validate({
    params: idParam,
    body: z.object({ items: z.array(z.object({ purchaseOrderItemId: z.number().int().positive(), quantityReceived: qty, unitCost: z.number().min(0).optional() })).min(1) }),
  }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = me(req);
    const po = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "purchase_orders" WHERE id = ${id} FOR UPDATE`;
      const order = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
      if (!order) throw notFound('Purchase order');
      if (order.status === 'CANCELLED' || order.status === 'RECEIVED') throw conflict(`This purchase order is ${order.status.toLowerCase()}`);
      if (order.status === 'DRAFT') throw conflict('Mark the purchase order as ordered before receiving goods');

      for (const line of req.body.items) {
        const poi = order.items.find((i) => i.id === line.purchaseOrderItemId);
        if (!poi) throw badRequest(`Line ${line.purchaseOrderItemId} is not on this purchase order`);
        const received = D(line.quantityReceived);
        if (poi.quantityReceived.plus(received).greaterThan(poi.quantityOrdered)) throw badRequest('Cannot receive more than was ordered');
        const cost = line.unitCost !== undefined ? D(line.unitCost) : poi.unitCost;
        await tx.purchaseOrderItem.update({ where: { id: poi.id }, data: { quantityReceived: { increment: received }, unitCost: cost } });
        await tx.stockMovement.create({
          data: { inventoryItemId: poi.inventoryItemId, movementType: 'PURCHASE_RECEIVED', quantityDelta: received, unitCost: cost, referenceType: 'PURCHASE_ORDER', referenceId: String(id), createdById: user.id },
        });
        await tx.inventoryItem.update({ where: { id: poi.inventoryItemId }, data: { currentQuantity: { increment: received }, costPerUnit: cost } });
      }
      const fresh = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
      const all = fresh.every((i) => i.quantityReceived.greaterThanOrEqualTo(i.quantityOrdered));
      const any = fresh.some((i) => i.quantityReceived.greaterThan(0));
      return tx.purchaseOrder.update({
        where: { id },
        data: { status: all ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : order.status, receivedAt: all ? new Date() : null },
        include: poInclude,
      });
    });
    res.json(po);
  }),
);
