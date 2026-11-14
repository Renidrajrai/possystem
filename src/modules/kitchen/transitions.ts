import type { FulfilmentStatus, OrderItemStatus, TicketStatus } from '@prisma/client';

const ORDER: TicketStatus[] = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'];

/** Tickets move forward only (steps may be skipped, e.g. NEW -> READY for a quick drink); CANCELLED from any live state. */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return false;
  if (from === 'SERVED' || from === 'CANCELLED') return false;
  if (to === 'CANCELLED') return true;
  return ORDER.indexOf(to) > ORDER.indexOf(from);
}

/** Map a ticket status to the order-item status shown on the order. */
export function itemStatusFor(ticket: TicketStatus): OrderItemStatus {
  switch (ticket) {
    case 'NEW':
    case 'ACCEPTED':
      return 'SENT';
    case 'PREPARING':
      return 'PREPARING';
    case 'READY':
      return 'READY';
    case 'SERVED':
      return 'SERVED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
}

/** Derive the order's fulfilment status from its item statuses. Payment is tracked separately. */
export function deriveFulfilment(items: OrderItemStatus[], current: FulfilmentStatus): FulfilmentStatus {
  if (current === 'CANCELLED' || current === 'COMPLETED') return current;
  const active = items.filter((s) => s !== 'CANCELLED');
  if (active.length === 0) return current;
  if (active.every((s) => s === 'SERVED')) return 'SERVED';
  if (active.every((s) => s === 'READY' || s === 'SERVED')) return 'READY';
  if (active.some((s) => s === 'PREPARING' || s === 'READY' || s === 'SERVED')) return 'IN_PROGRESS';
  if (active.some((s) => s === 'SENT')) return 'SENT_TO_KITCHEN';
  return 'OPEN';
}
