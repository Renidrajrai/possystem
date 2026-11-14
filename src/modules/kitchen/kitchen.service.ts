import type { TicketStatus } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { nextNumber } from '../../utils/sequence';
import { audit } from '../../utils/audit';
import { emit } from '../../realtime/realtime';
import { lockOrder, maybeCompleteOrder, refreshOrderFulfilment } from '../orders/order.helpers';
import { consumeForTicketItems, reverseForTicketItems } from '../inventory/stock.service';
import { canTransition, itemStatusFor } from './transitions';

export const ticketInclude = {
  station: true,
  order: { select: { id: true, orderNumber: true, orderType: true, notes: true, table: { select: { id: true, name: true } } } },
  items: {
    include: {
      orderItem: {
        select: {
          id: true,
          itemNameSnapshot: true,
          variantNameSnapshot: true,
          quantity: true,
          notes: true,
          modifiers: { select: { modifierNameSnapshot: true, quantity: true } },
        },
      },
    },
  },
} as const;

/**
 * Turn the order's PENDING items into kitchen tickets, one per station.
 * Items added later create a NEW batch/ticket; earlier tickets are never replaced.
 */
export async function sendToKitchen(orderId: number, userId: number) {
  const result = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { where: { itemStatus: 'PENDING' }, include: { menuItem: { select: { kitchenStationId: true } } } } },
    });
    if (order.fulfilmentStatus === 'CANCELLED' || order.fulfilmentStatus === 'COMPLETED') throw conflict('This order is closed');
    if (order.items.length === 0) throw badRequest('There are no new items to send to the kitchen');

    const stations = await tx.kitchenStation.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
    if (stations.length === 0) throw badRequest('No kitchen stations are configured');
    const fallback = stations.find((s) => s.name.toLowerCase() === 'kitchen') ?? stations[0];

    const byStation = new Map<number, typeof order.items>();
    for (const item of order.items) {
      const sid = item.menuItem.kitchenStationId && stations.some((s) => s.id === item.menuItem.kitchenStationId) ? item.menuItem.kitchenStationId : fallback.id;
      byStation.set(sid, [...(byStation.get(sid) ?? []), item]);
    }

    const lastBatch = await tx.kitchenTicket.aggregate({ where: { orderId }, _max: { batchNumber: true } });
    const batchNumber = (lastBatch._max.batchNumber ?? 0) + 1;

    const created = [];
    for (const [stationId, items] of byStation) {
      const ticketNumber = await nextNumber(tx, 'KOT', 'KOT-', 5);
      const ticket = await tx.kitchenTicket.create({
        data: {
          orderId,
          stationId,
          ticketNumber,
          batchNumber,
          items: { create: items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) },
        },
        include: ticketInclude,
      });
      created.push(ticket);
    }
    await tx.orderItem.updateMany({ where: { id: { in: order.items.map((i) => i.id) } }, data: { itemStatus: 'SENT' } });
    await refreshOrderFulfilment(tx, orderId);
    return created;
  });

  for (const t of result) emit('ticket:new', t, ['kitchen', `station:${t.stationId}`, 'pos']);
  emit('order:updated', { orderId }, ['pos']);
  return result;
}

export async function updateTicketStatus(ticketId: number, to: TicketStatus, userId: number, reason?: string) {
  const ticket = await prisma.$transaction(async (tx) => {
    const t = await tx.kitchenTicket.findUnique({ where: { id: ticketId } });
    if (!t) throw notFound('Ticket');
    await lockOrder(tx, t.orderId);
    const current = await tx.kitchenTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { items: true } });
    if (!canTransition(current.status, to)) throw conflict(`Cannot move a ticket from ${current.status} to ${to}`);
    if (to === 'CANCELLED' && !reason) throw badRequest('A reason is required to cancel a ticket');

    const live = current.items.filter((i) => i.status !== 'CANCELLED');
    const now = new Date();
    await tx.kitchenTicket.update({
      where: { id: ticketId },
      data: {
        status: to,
        ...(to === 'ACCEPTED' ? { acceptedAt: now } : {}),
        ...(to === 'READY' ? { readyAt: now } : {}),
        ...(to === 'SERVED' ? { servedAt: now } : {}),
        ...(to === 'CANCELLED' ? { cancelReason: reason, cancelledById: userId } : {}),
      },
    });
    await tx.kitchenTicketItem.updateMany({ where: { id: { in: live.map((i) => i.id) } }, data: { status: to } });
    await tx.orderItem.updateMany({ where: { id: { in: live.map((i) => i.orderItemId) } }, data: { itemStatus: itemStatusFor(to) } });

    if (to === 'READY' || to === 'SERVED') await consumeForTicketItems(tx, live.map((i) => i.id), userId); // SERVED covers skipped READY
    if (to === 'CANCELLED') {
      await reverseForTicketItems(tx, live.map((i) => i.id), userId, `Ticket ${current.ticketNumber} cancelled`);
      await audit({ userId, action: 'TICKET_CANCELLED', entityType: 'KitchenTicket', entityId: ticketId, reason }, tx);
    }
    await refreshOrderFulfilment(tx, current.orderId);
    await maybeCompleteOrder(tx, current.orderId);
    return tx.kitchenTicket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude });
  });

  emit('ticket:updated', ticket, ['kitchen', `station:${ticket.stationId}`, 'pos']);
  emit('order:updated', { orderId: ticket.orderId }, ['pos']);
  return ticket;
}

/**
 * An order line was cancelled by the cashier/manager: cancel its ticket lines, give back stock,
 * and cancel any ticket left with no live lines. Call inside the order transaction.
 */
export async function cancelTicketLinesForOrderItem(tx: Tx, orderItemId: number, userId: number, reason: string) {
  const lines = await tx.kitchenTicketItem.findMany({ where: { orderItemId, status: { not: 'CANCELLED' } }, include: { ticket: true } });
  if (lines.length === 0) return [];
  await reverseForTicketItems(tx, lines.map((l) => l.id), userId, `Order item cancelled: ${reason}`);
  await tx.kitchenTicketItem.updateMany({ where: { id: { in: lines.map((l) => l.id) } }, data: { status: 'CANCELLED' } });
  const touched: number[] = [];
  for (const ticketId of new Set(lines.map((l) => l.ticketId))) {
    const remaining = await tx.kitchenTicketItem.count({ where: { ticketId, status: { not: 'CANCELLED' } } });
    if (remaining === 0) {
      await tx.kitchenTicket.update({ where: { id: ticketId }, data: { status: 'CANCELLED', cancelReason: reason, cancelledById: userId } });
    }
    touched.push(ticketId);
  }
  return touched;
}
