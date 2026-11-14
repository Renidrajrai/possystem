import { describe, expect, it } from 'vitest';
import { priceLine, type MenuItemDef } from '../src/modules/orders/pricing';
import { D } from '../src/utils/money';

const milk = { id: 1, name: 'Milk Type', minSelections: 1, maxSelections: 1, isRequired: true, isActive: true, options: [
  { id: 10, name: 'Whole', additionalPrice: D(0), isAvailable: true },
  { id: 11, name: 'Oat', additionalPrice: D(80), isAvailable: true },
  { id: 12, name: 'Soy', additionalPrice: D(60), isAvailable: false },
] };
const extras = { id: 2, name: 'Extras', minSelections: 0, maxSelections: 2, isRequired: false, isActive: true, options: [
  { id: 20, name: 'Extra shot', additionalPrice: D(70), isAvailable: true },
] };
const cappuccino: MenuItemDef = {
  id: 101, name: 'Cappuccino', basePrice: D(150), isAvailable: true, isActive: true,
  variants: [{ id: 1, name: 'Small', price: D(150), isActive: true }, { id: 2, name: 'Large', price: D(220), isActive: true }],
  modifierGroups: [milk, extras],
};
const brownie: MenuItemDef = { id: 5, name: 'Brownie', basePrice: D(120), isAvailable: true, isActive: true, variants: [], modifierGroups: [] };

describe('priceLine', () => {
  it('prices variant + modifiers server-side', () => {
    const l = priceLine(cappuccino, { menuItemId: 101, variantId: 2, quantity: 2, modifiers: [{ optionId: 11 }, { optionId: 20, quantity: 2 }] });
    expect(l.unitPriceSnapshot.toString()).toBe('440'); // 220 + 80 + 2*70
    expect(l.lineTotal.toString()).toBe('880');
    expect(l.variantNameSnapshot).toBe('Large');
  });
  it('item without variants uses base price', () => {
    expect(priceLine(brownie, { menuItemId: 5, quantity: 3 }).lineTotal.toString()).toBe('360');
  });
  it('requires a variant when the item has variants', () => {
    expect(() => priceLine(cappuccino, { menuItemId: 101, quantity: 1, modifiers: [{ optionId: 10 }] })).toThrow(/size/i);
  });
  it('blocks a required modifier group left empty', () => {
    expect(() => priceLine(cappuccino, { menuItemId: 101, variantId: 1, quantity: 1 })).toThrow(/at least 1/);
  });
  it('enforces max selections', () => {
    expect(() => priceLine(cappuccino, { menuItemId: 101, variantId: 1, quantity: 1, modifiers: [{ optionId: 10 }, { optionId: 11 }] })).toThrow(/at most/);
  });
  it('rejects unavailable options and foreign options', () => {
    expect(() => priceLine(cappuccino, { menuItemId: 101, variantId: 1, quantity: 1, modifiers: [{ optionId: 12 }] })).toThrow(/unavailable/);
    expect(() => priceLine(cappuccino, { menuItemId: 101, variantId: 1, quantity: 1, modifiers: [{ optionId: 10 }, { optionId: 999 }] })).toThrow(/not valid/);
  });
  it('rejects variant on a no-variant item, bad quantity and unavailable items', () => {
    expect(() => priceLine(brownie, { menuItemId: 5, variantId: 1, quantity: 1 })).toThrow();
    expect(() => priceLine(brownie, { menuItemId: 5, quantity: 0 })).toThrow();
    expect(() => priceLine({ ...brownie, isAvailable: false }, { menuItemId: 5, quantity: 1 })).toThrow(/unavailable/);
  });
  it('identical items with different modifiers price independently', () => {
    const a = priceLine(cappuccino, { menuItemId: 101, variantId: 1, quantity: 1, modifiers: [{ optionId: 10 }] });
    const b = priceLine(cappuccino, { menuItemId: 101, variantId: 1, quantity: 1, modifiers: [{ optionId: 11 }] });
    expect(a.unitPriceSnapshot.toString()).toBe('150');
    expect(b.unitPriceSnapshot.toString()).toBe('230');
  });
});
