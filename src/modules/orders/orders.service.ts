import { prisma, type Tx } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { can, type AuthUser } from '../../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { nextNumber } from '../../utils/sequence';
import { D, round2 } from '../../utils/money';
import { emit } from '../../realtime/realtime';
import { computeTotals, discountPercentOf, type DiscountType } from '../billing/calc';
import { findOrCreateByPhone } from '../customers/customers.service';
import { getPricingConfig } from '../settings/settings.service';
import { cancelTicketLinesForOrderItem, sendToKitchen } from '../kitchen/kitchen.service';
import { invalidateUnpaidBill, lockOrder, maybeCompleteOrder, recalcOrder, refreshOrderFulfilment, syncTableStatus, OPEN_FULFILMENT } from './order.helpers';
import { priceLine, type LineInput, type MenuItemDef } from './pricing';

export const orderInclude = {
  table: { select: { id: true, name: true, floorId: true } },
  customer: { select: { id: true, name: true, phone: true, membershipNumber: true } },
  createdBy: { select: { id: true, name: true } },
  items: { include: { modifiers: true }, orderBy: { id: 'asc' as const } },
  tickets: { select: { id: true, ticketNumber: true, status: true, stationId: true, batchNumber: true } },
  bills: { select: { id: true, billNumber: true, status: true, totalDue: true, amountPaid: true }, orderBy: { id: 'asc' as const } },
} as const;

export interface CreateOrderInput {
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableId?: number;
  customerId?: number;
  customerPhone?: string;
  customerName?: string;
  guestCount?: number;
  notes?: string;
  items: LineInput[];
  sendToKitchen?: boolean;
}

// ------------------------------------------------------------------ helpers

async function loadDefs(tx: Tx, ids: number[]): Promise<Map<number, MenuItemDef>> {
  const unique = [...new Set(ids)];
  const rows = await tx.menuItem.findMany({
    where: { id: { in: unique } },
    include: { variants: true, modifierGroups: { include: { modifierGroup: { include: { options: true } } } } },
  });
  const map = new Map<number, MenuItemDef>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      name: r.name,
      basePrice: r.basePrice,
      isAvailable: r.isAvailable,
      isActive: r.isActive,
      variants: r.variants.map((v) => ({ id: v.id, name: v.name, price: v.price, isActive: v.isActive })),
      modifierGroups: r.modifierGroups.map((mg) => ({
        id: mg.modifierGroup.id,
        name: mg.modifierGroup.name,
        minSelections: mg.modifierGroup.minSelections,
        maxSelections: mg.modifierGroup.maxSelections,
        isRequired: mg.modifierGroup.isRequired,
        isActive: mg.modifierGroup.isActive,
        options: mg.modifierGroup.options.map((o) => ({ id: o.id, name: o.name, additionalPrice: o.additionalPrice, isAvailable: o.isAvailable })),
      })),
    });
  }
  for (const id of unique) if (!map.has(id)) throw badRequest(`Menu item ${id} does not exist`);
  return map;
}

async function priceLines(tx: Tx, inputs: LineInput[]) {
  const defs = await loadDefs(tx, inputs.map((i) => i.menuItemId));
  return inputs.map((i) => priceLine(defs.get(i.menuItemId)!, i));
}

const lineCreate = (l: ReturnType<typeof priceLine>) => ({
  menuItemId: l.menuItemId,
  variantId: l.variantId,
  itemNameSnapshot: l.itemNameSnapshot,
  variantNameSnapshot: l.variantNameSnapshot,
  quantity: l.quantity,
  unitPriceSnapshot: l.unitPriceSnapshot,
  lineTotal: l.lineTotal,
  notes: l.notes,
  modifiers: { create: l.modifiers },
});

export function canAccessOrder(user: AuthUser, order: { createdById: number }) {
  return order.createdById === user.id || can(user, PERMISSIONS.ORDER_VIEW_ALL);
}

/** Load + lock an order inside a transaction and check the caller may touch it. */
async function loadEditable(tx: Tx, user: AuthUser, orderId: number, opts: { allowPaid?: boolean } = {}) {
  await lockOrder(tx, orderId);
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!canAccessOrder(user, order)) throw forbidden('You can only change your own orders');
  if (order.fulfilmentStatus === 'CANCELLED' || order.fulfilmentStatus === 'COMPLETED') throw conflict('This order is already closed');
  if (!opts.allowPaid && order.paymentStatus !== 'UNPAID') throw conflict('This order has payments. Refund/void the bill before changing it.');
  return order;
}

async function assertTableUsable(tx: Tx, tableId: number) {
  const table = await tx.diningTable.findUnique({ where: { id: tableId } });
  if (!table || !table.isActive) throw badRequest('Table not found');
  if (table.status === 'OUT_OF_SERVICE') throw conflict('This table is out of service');
  return table;
}

const afterCommit = (orderId: number) => emit('order:updated', { orderId }, ['pos']);

export async function getOrder(user: AuthUser, id: number) {
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  if (!order) throw notFound('Order');
  if (!canAccessOrder(user, order)) throw forbidden('You can only view your own orders');
  return order;
}

// ------------------------------------------------------------------ create

export async function createOrder(user: AuthUser, input: CreateOrderInput) {
  if (input.orderType === 'DINE_IN' && !input.tableId) throw badRequest('Choose a table for dine-in orders');
  if (input.orderType !== 'DINE_IN' && input.tableId) throw badRequest('Only dine-in orders can have a table');

  const order = await prisma.$transaction(async (tx) => {
    if (input.tableId) await assertTableUsable(tx, input.tableId);

    let customerId: number | null = null;
    if (input.customerPhone) {
      customerId = (await findOrCreateByPhone(tx, input.customerPhone, input.customerName)).id;
    } else if (input.customerId) {
      const c = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!c || !c.isActive) throw badRequest('Customer not found');
      customerId = c.id;
    }

    const lines = await priceLines(tx, input.items);
    const shift = await tx.shift.findFirst({ where: { userId: user.id, status: 'OPEN' }, select: { id: true } });
    const orderNumber = await nextNumber(tx, 'ORDER', 'ORD-');

    const created = await tx.order.create({
      data: {
        orderNumber,
        orderType: input.orderType,
        tableId: input.tableId ?? null,
        customerId,
        createdById: user.id,
        shiftId: shift?.id ?? null,
        guestCount: input.guestCount ?? null,
        notes: input.notes?.trim() || null,
        items: { create: lines.map(lineCreate) },
      },
    });
    await recalcOrder(tx, created.id);
    await syncTableStatus(tx, input.tableId);
    return created;
  });

  if (input.sendToKitchen) await sendToKitchen(order.id, user.id);
  afterCommit(order.id);
  return getOrder(user, order.id);
}

// ------------------------------------------------------------------ items

export async function addItems(user: AuthUser, orderId: number, items: LineInput[], sendNow = false) {
  await prisma.$transaction(async (tx) => {
    await loadEditable(tx, user, orderId);
    const lines = await priceLines(tx, items);
    await invalidateUnpaidBill(tx, orderId, 'Order modified after bill was issued', user.id);
    for (const l of lines) await tx.orderItem.create({ data: { ...lineCreate(l), orderId } });
    await recalcOrder(tx, orderId);
    await refreshOrderFulfilment(tx, orderId);
  });
  if (sendNow) await sendToKitchen(orderId, user.id);
  afterCommit(orderId);
  return getOrder(user, orderId);
}

/** Only items not yet sent to the kitchen can be edited (quantity / note). */
export async function updateItem(user: AuthUser, orderId: number, itemId: number, patch: { quantity?: number; notes?: string | null }) {
  await prisma.$transaction(async (tx) => {
    await loadEditable(tx, user, orderId);
    const item = await tx.orderItem.findFirst({ where: { id: itemId, orderId } });
    if (!item) throw notFound('Order item');
    if (item.itemStatus !== 'PENDING') throw conflict('This item was already sent to the kitchen. Cancel it and add a new one instead.');
    await invalidateUnpaidBill(tx, orderId, 'Order modified after bill was issued', user.id);
    const quantity = patch.quantity ?? item.quantity;
    await tx.orderItem.update({
      where: { id: itemId },
      data: { quantity, lineTotal: round2(item.unitPriceSnapshot.times(quantity)), ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}) },
    });
    await recalcOrder(tx, orderId);
  });
  afterCommit(orderId);
  return getOrder(user, orderId);
}

export async function cancelItem(user: AuthUser, orderId: number, itemId: number, reason: string) {
  const touchedTickets = await prisma.$transaction(async (tx) => {
    await loadEditable(tx, user, orderId);
    const item = await tx.orderItem.findFirst({ where: { id: itemId, orderId } });
    if (!item) throw notFound('Order item');
    if (item.itemStatus === 'CANCELLED') throw conflict('Item is already cancelled');
    if (item.itemStatus === 'SERVED') throw conflict('A served item cannot be cancelled. Use a refund instead.');
    if (item.itemStatus !== 'PENDING' && !can(user, PERMISSIONS.ORDER_CANCEL)) throw forbidden('Cancelling an item already sent to the kitchen needs manager approval');

    await invalidateUnpaidBill(tx, orderId, 'Order modified after bill was issued', user.id);
    const tickets = await cancelTicketLinesForOrderItem(tx, itemId, user.id, reason);
    await tx.orderItem.update({ where: { id: itemId }, data: { itemStatus: 'CANCELLED', cancelReason: reason } });
    await recalcOrder(tx, orderId);
    await refreshOrderFulfilment(tx, orderId);
    if (item.itemStatus !== 'PENDING') {
      await audit({ userId: user.id, action: 'ORDER_ITEM_CANCELLED', entityType: 'OrderItem', entityId: itemId, reason, before: { status: item.itemStatus, lineTotal: item.lineTotal.toString() } }, tx);
    }
    return tickets;
  });
  for (const id of touchedTickets) {
    const t = await prisma.kitchenTicket.findUnique({ where: { id } });
    if (t) emit('ticket:updated', { id, status: t.status, orderId }, ['kitchen', `station:${t.stationId}`, 'pos']);
  }
  afterCommit(orderId);
  return getOrder(user, orderId);
}

// ------------------------------------------------------------------ discount

export interface DiscountInput {
  type: DiscountType;
  value?: number;
  reason?: string;
}

/** Apply/clear a discount. Over the cashier limit needs discount.override. Always audited. */
export async function applyDiscount(tx: Tx, user: AuthUser, orderId: number, input: DiscountInput) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  if (!can(user, PERMISSIONS.DISCOUNT_APPLY) && !can(user, PERMISSIONS.DISCOUNT_OVERRIDE)) throw forbidden('You cannot apply discounts');

  if (input.type === 'NONE') {
    if (order.discountType === 'NONE') return;
    await invalidateUnpaidBill(tx, orderId, 'Discount removed', user.id);
    await tx.order.update({ where: { id: orderId }, data: { discountType: 'NONE', discountValue: 0, discountReason: null } });
    await recalcOrder(tx, orderId);
    await audit({ userId: user.id, action: 'DISCOUNT_REMOVED', entityType: 'Order', entityId: orderId, before: { type: order.discountType, value: order.discountValue.toString() } }, tx);
    return;
  }

  const value = D(input.value ?? 0);
  if (value.lessThanOrEqualTo(0)) throw badRequest('Discount value must be greater than zero');
  if (!input.reason || input.reason.trim().length < 3) throw badRequest('A reason is required for a discount');
  if (input.type === 'PERCENTAGE' && value.greaterThan(100)) throw badRequest('Discount percentage cannot exceed 100');

  const cfg = await getPricingConfig(tx);
  const subtotal = order.items.filter((i) => i.itemStatus !== 'CANCELLED').reduce((s, i) => s.plus(i.lineTotal), D(0));
  const preview = computeTotals({
    subtotal, discountType: input.type, discountValue: value,
    serviceChargePct: D(0), taxRatePercent: D(0), pricesIncludeTax: false,
  });
  const percent = discountPercentOf(preview);
  const overLimit = percent.greaterThan(cfg.maxCashierDiscountPercent);
  if (overLimit && !can(user, PERMISSIONS.DISCOUNT_OVERRIDE)) {
    throw forbidden(`Discounts above ${cfg.maxCashierDiscountPercent}% need manager approval`);
  }

  await invalidateUnpaidBill(tx, orderId, 'Discount changed after bill was issued', user.id);
  await tx.order.update({ where: { id: orderId }, data: { discountType: input.type, discountValue: value, discountReason: input.reason.trim() } });
  await recalcOrder(tx, orderId);
  await audit(
    {
      userId: user.id,
      action: overLimit ? 'DISCOUNT_OVERRIDE' : 'DISCOUNT_APPLIED',
      entityType: 'Order',
      entityId: orderId,
      reason: input.reason.trim(),
      before: { type: order.discountType, value: order.discountValue.toString() },
      after: { type: input.type, value: value.toString(), effectivePercent: percent.toDecimalPlaces(2).toString() },
    },
    tx,
  );
}

export async function setDiscount(user: AuthUser, orderId: number, input: DiscountInput) {
  await prisma.$transaction(async (tx) => {
    await loadEditable(tx, user, orderId);
    await applyDiscount(tx, user, orderId, input);
  });
  afterCommit(orderId);
  return getOrder(user, orderId);
}

// ------------------------------------------------------------------ table moves, merge, cancel, complete

export async function moveTable(user: AuthUser, orderId: number, tableId: number) {
  await prisma.$transaction(async (tx) => {
    const order = await loadEditable(tx, user, orderId, { allowPaid: true });
    if (order.orderType !== 'DINE_IN') throw badRequest('Only dine-in orders have a table');
    if (order.tableId === tableId) throw badRequest('The order is already on this table');
    await assertTableUsable(tx, tableId);
    await tx.order.update({ where: { id: orderId }, data: { tableId } });
    await syncTableStatus(tx, order.tableId);
    await syncTableStatus(tx, tableId);
    await audit({ userId: user.id, action: 'ORDER_TABLE_MOVED', entityType: 'Order', entityId: orderId, before: { tableId: order.tableId }, after: { tableId } }, tx);
  });
  emit('table:updated', { orderId }, ['pos']);
  afterCommit(orderId);
  return getOrder(user, orderId);
}

/** Merge `sourceId` into `targetId` (e.g. two tables joined). The source order is closed as "merged". */
export async function mergeOrders(user: AuthUser, sourceId: number, targetId: number) {
  if (sourceId === targetId) throw badRequest('Choose two different orders');
  await prisma.$transaction(async (tx) => {
    // Lock in id order to avoid deadlocks between concurrent merges.
    const [first, second] = [sourceId, targetId].sort((a, b) => a - b);
    await lockOrder(tx, first);
    await lockOrder(tx, second);
    const [source, target] = await Promise.all([
      tx.order.findUniqueOrThrow({ where: { id: sourceId } }),
      tx.order.findUniqueOrThrow({ where: { id: targetId } }),
    ]);
    for (const o of [source, target]) {
      if (!canAccessOrder(user, o)) throw forbidden('You can only change your own orders');
      if (!OPEN_FULFILMENT.includes(o.fulfilmentStatus)) throw conflict(`Order ${o.orderNumber} is closed`);
      if (o.paymentStatus !== 'UNPAID') throw conflict(`Order ${o.orderNumber} has payments and cannot be merged`);
    }
    await invalidateUnpaidBill(tx, sourceId, 'Order merged', user.id);
    await invalidateUnpaidBill(tx, targetId, 'Order merged', user.id);
    await tx.orderItem.updateMany({ where: { orderId: sourceId }, data: { orderId: targetId } });
    await tx.kitchenTicket.updateMany({ where: { orderId: sourceId }, data: { orderId: targetId } });
    await tx.order.update({
      where: { id: sourceId },
      data: { fulfilmentStatus: 'CANCELLED', paymentStatus: 'VOID', cancelReason: `Merged into ${target.orderNumber}`, closedAt: new Date() },
    });
    await recalcOrder(tx, sourceId);
    await recalcOrder(tx, targetId);
    await refreshOrderFulfilment(tx, targetId);
    await syncTableStatus(tx, source.tableId);
    await syncTableStatus(tx, target.tableId);
    await audit({ userId: user.id, action: 'ORDERS_MERGED', entityType: 'Order', entityId: targetId, after: { mergedFrom: source.orderNumber } }, tx);
  });
  emit('table:updated', { orderId: targetId }, ['pos']);
  afterCommit(targetId);
  return getOrder(user, targetId);
}

export async function cancelOrder(user: AuthUser, orderId: number, reason: string) {
  await prisma.$transaction(async (tx) => {
    await loadEditable(tx, user, orderId, { allowPaid: true });
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, bills: { include: { payments: true } } } });
    if (order.bills.some((b) => b.payments.some((p) => p.status === 'SUCCESS' || p.status === 'PENDING'))) {
      throw conflict('Payments were taken on this order. Refund them first, then cancel.');
    }
    if (order.items.some((i) => i.itemStatus === 'SERVED')) throw conflict('Served items exist. Use refunds/adjustments instead of cancelling.');
    await invalidateUnpaidBill(tx, orderId, `Order cancelled: ${reason}`, user.id);
    for (const item of order.items.filter((i) => i.itemStatus !== 'CANCELLED')) {
      await cancelTicketLinesForOrderItem(tx, item.id, user.id, reason);
    }
    await tx.orderItem.updateMany({ where: { orderId, itemStatus: { not: 'CANCELLED' } }, data: { itemStatus: 'CANCELLED', cancelReason: reason } });
    await tx.order.update({ where: { id: orderId }, data: { fulfilmentStatus: 'CANCELLED', paymentStatus: 'VOID', cancelReason: reason, closedAt: new Date() } });
    await recalcOrder(tx, orderId);
    await syncTableStatus(tx, order.tableId);
    await audit({ userId: user.id, action: 'ORDER_CANCELLED', entityType: 'Order', entityId: orderId, reason, before: { total: order.totalAmount.toString() } }, tx);
  });
  afterCommit(orderId);
  return getOrder(user, orderId);
}

/**
 * Counter hand-off: close a PAID order. Items that are still PENDING (never needed the kitchen) or READY are
 * marked served. Refused while the kitchen is still working on something.
 */
export async function completeOrder(user: AuthUser, orderId: number) {
  await prisma.$transaction(async (tx) => {
    await loadEditable(tx, user, orderId, { allowPaid: true });
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    if (order.paymentStatus !== 'PAID') throw conflict('The order must be fully paid before it is completed');
    if (order.items.some((i) => i.itemStatus === 'SENT' || i.itemStatus === 'PREPARING')) throw conflict('The kitchen is still preparing items for this order');

    await tx.orderItem.updateMany({ where: { orderId, itemStatus: { in: ['PENDING', 'READY'] } }, data: { itemStatus: 'SERVED' } });
    await tx.kitchenTicketItem.updateMany({ where: { ticket: { orderId }, status: 'READY' }, data: { status: 'SERVED' } });
    await tx.kitchenTicket.updateMany({ where: { orderId, status: 'READY' }, data: { status: 'SERVED', servedAt: new Date() } });
    await refreshOrderFulfilment(tx, orderId);
    await maybeCompleteOrder(tx, orderId);
  });
  afterCommit(orderId);
  return getOrder(user, orderId);
}
