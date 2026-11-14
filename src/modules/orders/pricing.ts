import { badRequest } from '../../utils/errors';
import { round2, sum, type Money } from '../../utils/money';

export interface ModifierOptionDef {
  id: number;
  name: string;
  additionalPrice: Money;
  isAvailable: boolean;
}
export interface ModifierGroupDef {
  id: number;
  name: string;
  minSelections: number;
  maxSelections: number;
  isRequired: boolean;
  isActive: boolean;
  options: ModifierOptionDef[];
}
export interface VariantDef {
  id: number;
  name: string;
  price: Money;
  isActive: boolean;
}
export interface MenuItemDef {
  id: number;
  name: string;
  basePrice: Money;
  isAvailable: boolean;
  isActive: boolean;
  variants: VariantDef[];
  modifierGroups: ModifierGroupDef[];
}

export interface LineInput {
  menuItemId: number;
  variantId?: number | null;
  quantity: number;
  notes?: string | null;
  modifiers?: { optionId: number; quantity?: number }[];
}

export interface PricedLine {
  menuItemId: number;
  variantId: number | null;
  itemNameSnapshot: string;
  variantNameSnapshot: string | null;
  quantity: number;
  unitPriceSnapshot: Money; // variant/base price + modifiers, per unit
  lineTotal: Money;
  notes: string | null;
  modifiers: { modifierOptionId: number; modifierNameSnapshot: string; priceSnapshot: Money; quantity: number }[];
}

/**
 * Price one order line from CURRENT database definitions. The client never supplies prices.
 * Enforces: item active/available, variant rules, option availability, group membership, min/max, required.
 */
export function priceLine(def: MenuItemDef, input: LineInput): PricedLine {
  if (!def.isActive) throw badRequest(`"${def.name}" is no longer on the menu`);
  if (!def.isAvailable) throw badRequest(`"${def.name}" is currently unavailable`);
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
    throw badRequest(`Invalid quantity for "${def.name}"`);
  }

  const activeVariants = def.variants.filter((v) => v.isActive);
  let variant: VariantDef | null = null;
  if (activeVariants.length > 0) {
    if (!input.variantId) throw badRequest(`Choose a size/variant for "${def.name}"`);
    variant = activeVariants.find((v) => v.id === input.variantId) ?? null;
    if (!variant) throw badRequest(`Variant does not belong to "${def.name}"`);
  } else if (input.variantId) {
    throw badRequest(`"${def.name}" has no variants`);
  }

  // Merge duplicate option ids
  const requested = new Map<number, number>();
  for (const m of input.modifiers ?? []) {
    const q = m.quantity ?? 1;
    if (!Number.isInteger(q) || q < 1 || q > 10) throw badRequest('Invalid modifier quantity');
    requested.set(m.optionId, (requested.get(m.optionId) ?? 0) + q);
  }

  const activeGroups = def.modifierGroups.filter((g) => g.isActive);
  const chosen: PricedLine['modifiers'] = [];
  const claimed = new Set<number>();

  for (const group of activeGroups) {
    let count = 0;
    for (const opt of group.options) {
      const q = requested.get(opt.id);
      if (!q) continue;
      if (!opt.isAvailable) throw badRequest(`"${opt.name}" is currently unavailable`);
      claimed.add(opt.id);
      count += q;
      chosen.push({ modifierOptionId: opt.id, modifierNameSnapshot: opt.name, priceSnapshot: round2(opt.additionalPrice), quantity: q });
    }
    const required = Math.max(group.minSelections, group.isRequired ? 1 : 0);
    if (count < required) throw badRequest(`Choose at least ${required} option(s) for "${group.name}" on "${def.name}"`);
    if (count > group.maxSelections) throw badRequest(`Choose at most ${group.maxSelections} option(s) for "${group.name}" on "${def.name}"`);
  }

  for (const optionId of requested.keys()) {
    if (!claimed.has(optionId)) throw badRequest(`Option ${optionId} is not valid for "${def.name}"`);
  }

  const basePrice = round2(variant ? variant.price : def.basePrice);
  const modifiersPerUnit = sum(chosen.map((m) => m.priceSnapshot.times(m.quantity)));
  const unit = round2(basePrice.plus(modifiersPerUnit));

  return {
    menuItemId: def.id,
    variantId: variant?.id ?? null,
    itemNameSnapshot: def.name,
    variantNameSnapshot: variant?.name ?? null,
    quantity: input.quantity,
    unitPriceSnapshot: unit,
    lineTotal: round2(unit.times(input.quantity)),
    notes: input.notes?.trim() || null,
    modifiers: chosen,
  };
}

export const lineDescription = (name: string, variant: string | null, modifiers: string[]) =>
  [name, variant ? `(${variant})` : null, modifiers.length ? `+ ${modifiers.join(', ')}` : null].filter(Boolean).join(' ');
