import type { Tx } from '../../config/prisma';
import { D } from '../../utils/money';

const REF = 'KITCHEN_TICKET_ITEM';

/** Pick the recipe for this exact variant, else the variant-less recipe for the item. */
async function findRecipe(tx: Tx, menuItemId: number, variantId: number | null) {
  const recipes = await tx.recipe.findMany({
    where: { menuItemId, isActive: true, OR: [{ variantId: null }, ...(variantId ? [{ variantId }] : [])] },
    include: { items: true },
  });
  return recipes.find((r) => r.variantId === variantId && variantId !== null) ?? recipes.find((r) => r.variantId === null) ?? null;
}

/**
 * Stock is deducted when a ticket line is READY (preparation completed), per the blueprint.
 * Idempotent: a ticket line is never consumed twice. Stock may go negative (service never blocks on a count error);
 * low/negative stock is surfaced in the inventory report.
 */
export async function consumeForTicketItems(tx: Tx, ticketItemIds: number[], userId: number | null) {
  for (const id of ticketItemIds) {
    const ti = await tx.kitchenTicketItem.findUniqueOrThrow({ where: { id }, include: { orderItem: true } });
    if (ti.status === 'CANCELLED') continue;
    const recipe = await findRecipe(tx, ti.orderItem.menuItemId, ti.orderItem.variantId);
    if (!recipe) continue;
    for (const ri of recipe.items) {
      const already = await tx.stockMovement.findFirst({
        where: { inventoryItemId: ri.inventoryItemId, referenceType: REF, referenceId: String(id), movementType: 'RECIPE_CONSUMPTION' },
      });
      if (already) continue;
      const used = D(ri.quantityRequired).times(ti.quantity).div(recipe.yieldQuantity || 1).toDecimalPlaces(3);
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: ri.inventoryItemId } });
      await tx.stockMovement.create({
        data: {
          inventoryItemId: ri.inventoryItemId,
          movementType: 'RECIPE_CONSUMPTION',
          quantityDelta: used.negated(),
          unitCost: item.costPerUnit,
          referenceType: REF,
          referenceId: String(id),
          createdById: userId,
        },
      });
      await tx.inventoryItem.update({ where: { id: ri.inventoryItemId }, data: { currentQuantity: { decrement: used } } });
    }
  }
}

/** Give back stock that was consumed for ticket lines that are later cancelled. Idempotent. */
export async function reverseForTicketItems(tx: Tx, ticketItemIds: number[], userId: number | null, note: string) {
  for (const id of ticketItemIds) {
    const consumed = await tx.stockMovement.findMany({ where: { referenceType: REF, referenceId: String(id), movementType: 'RECIPE_CONSUMPTION' } });
    for (const c of consumed) {
      const reversed = await tx.stockMovement.findFirst({
        where: { inventoryItemId: c.inventoryItemId, referenceType: REF, referenceId: String(id), movementType: 'CONSUMPTION_REVERSAL' },
      });
      if (reversed) continue;
      const back = c.quantityDelta.abs();
      await tx.stockMovement.create({
        data: {
          inventoryItemId: c.inventoryItemId,
          movementType: 'CONSUMPTION_REVERSAL',
          quantityDelta: back,
          unitCost: c.unitCost,
          referenceType: REF,
          referenceId: String(id),
          note,
          createdById: userId,
        },
      });
      await tx.inventoryItem.update({ where: { id: c.inventoryItemId }, data: { currentQuantity: { increment: back } } });
    }
  }
}
