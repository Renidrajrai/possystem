/**
 * Idempotent seed: safe to run repeatedly.
 *   npm run db:seed
 * Creates roles/permissions, payment methods, kitchen stations, settings, numbering and the owner account.
 * With SEED_DEMO=true it also adds demo staff, a floor with tables and a small sample menu.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_PERMISSIONS } from '../src/config/permissions';

const prisma = new PrismaClient();
const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
const isProd = process.env.NODE_ENV === 'production';

async function seedAccess() {
  for (const code of Object.values(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { code }, create: { code, description: PERMISSION_DESCRIPTIONS[code] }, update: { description: PERMISSION_DESCRIPTIONS[code] } });
  }
  const perms = await prisma.permission.findMany();
  const byCode = new Map(perms.map((p) => [p.code, p.id]));
  for (const [name, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({ where: { name }, create: { name, description: ROLE_DESCRIPTIONS[name] }, update: { description: ROLE_DESCRIPTIONS[name] } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: codes.map((c) => ({ roleId: role.id, permissionId: byCode.get(c)! })) });
  }
}

async function seedReference() {
  for (const m of [
    { name: 'Cash', isCash: true, requiresReference: false },
    { name: 'QR', isCash: false, requiresReference: true },
    { name: 'Card', isCash: false, requiresReference: true },
    { name: 'eSewa', isCash: false, requiresReference: true },
    { name: 'Bank Transfer', isCash: false, requiresReference: true },
  ]) {
    await prisma.paymentMethod.upsert({ where: { name: m.name }, create: m, update: { isCash: m.isCash } });
  }
  for (const name of ['Coffee Bar', 'Kitchen', 'Bakery']) {
    await prisma.kitchenStation.upsert({ where: { name }, create: { name }, update: {} });
  }
  // Numbering. NOTE has no fixed prefix: credit notes use CN-, debit notes DN-.
  for (const s of [
    { key: 'ORDER', prefix: 'ORD-' },
    { key: 'BILL', prefix: 'INV-' },
    { key: 'KOT', prefix: 'KOT-' },
    { key: 'NOTE', prefix: '' },
  ]) {
    await prisma.invoiceSequence.upsert({ where: { key: s.key }, create: s, update: {} });
  }
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: { id: 1, businessName: 'My Café' }, update: {} });

  // Tax profiles are DATA. None is set as the default: the owner decides after confirming
  // VAT/registration with IRD or an accountant (Settings > business > defaultTaxProfileId).
  const none = await prisma.taxProfile.upsert({ where: { name: 'No tax' }, create: { name: 'No tax' }, update: {} });
  if (!(await prisma.taxRate.count({ where: { taxProfileId: none.id } }))) {
    await prisma.taxRate.create({ data: { taxProfileId: none.id, name: 'No tax', ratePercent: 0, effectiveFrom: new Date('2000-01-01') } });
  }
  const vat = await prisma.taxProfile.upsert({ where: { name: 'VAT (standard rate)' }, create: { name: 'VAT (standard rate)' }, update: {} });
  if (!(await prisma.taxRate.count({ where: { taxProfileId: vat.id } }))) {
    await prisma.taxRate.create({ data: { taxProfileId: vat.id, name: 'VAT', ratePercent: 13, effectiveFrom: new Date('2000-01-01') } });
  }
}

async function upsertUser(name: string, email: string, password: string, roleName: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return exists;
  return prisma.user.create({ data: { name, email, passwordHash: await bcrypt.hash(password, rounds), roleId: role.id } });
}

async function seedOwner() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? '').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  if (!email || password.length < 10) {
    if (isProd) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (10+ chars) to create the owner account.');
    console.warn('! SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD missing or too short; skipping owner creation.');
    return;
  }
  const u = await upsertUser(process.env.SEED_ADMIN_NAME ?? 'Owner', email, password, 'OWNER');
  console.log(`✓ Owner account: ${u.email}`);
}

async function seedDemo() {
  const pw = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Pass-12345';
  await upsertUser('Demo Manager', 'manager@cafe.local', pw, 'MANAGER');
  await upsertUser('Demo Cashier', 'cashier@cafe.local', pw, 'CASHIER');
  await upsertUser('Demo Kitchen', 'kitchen@cafe.local', pw, 'KITCHEN');

  const floor = await prisma.floor.upsert({ where: { name: 'Ground Floor' }, create: { name: 'Ground Floor' }, update: {} });
  for (const name of ['T1', 'T2', 'T3', 'T4', 'T5']) {
    await prisma.diningTable.upsert({ where: { floorId_name: { floorId: floor.id, name } }, create: { floorId: floor.id, name, capacity: 4 }, update: {} });
  }
  if (await prisma.category.count()) return console.log('• Menu already exists, skipping demo menu');

  const stations = Object.fromEntries((await prisma.kitchenStation.findMany()).map((s) => [s.name, s.id]));
  const drinks = await prisma.category.create({ data: { name: 'Drinks', sortOrder: 1 } });
  const coffee = await prisma.category.create({ data: { name: 'Coffee', parentId: drinks.id, sortOrder: 1 } });
  const food = await prisma.category.create({ data: { name: 'Food', sortOrder: 2 } });
  const bakery = await prisma.category.create({ data: { name: 'Bakery', sortOrder: 3 } });

  const milk = await prisma.modifierGroup.create({
    data: { name: 'Milk Type', isRequired: true, minSelections: 1, maxSelections: 1, options: { create: [{ name: 'Whole milk', additionalPrice: 0 }, { name: 'Oat milk', additionalPrice: 80 }] } },
  });
  const extras = await prisma.modifierGroup.create({
    data: { name: 'Extras', minSelections: 0, maxSelections: 3, options: { create: [{ name: 'Extra shot', additionalPrice: 70 }, { name: 'Vanilla syrup', additionalPrice: 40 }] } },
  });

  const cappuccino = await prisma.menuItem.create({
    data: {
      categoryId: coffee.id, kitchenStationId: stations['Coffee Bar'], name: 'Cappuccino', basePrice: 150, preparationTimeMinutes: 4,
      variants: { create: [{ name: 'Small', price: 150, sortOrder: 1 }, { name: 'Medium', price: 180, sortOrder: 2 }, { name: 'Large', price: 220, sortOrder: 3 }] },
      modifierGroups: { create: [{ modifierGroupId: milk.id, sortOrder: 0 }, { modifierGroupId: extras.id, sortOrder: 1 }] },
    },
  });
  await prisma.menuItem.create({ data: { categoryId: food.id, kitchenStationId: stations['Kitchen'], name: 'Club Sandwich', basePrice: 350, preparationTimeMinutes: 10 } });
  await prisma.menuItem.create({ data: { categoryId: bakery.id, kitchenStationId: stations['Bakery'], name: 'Brownie', basePrice: 120 } });

  const beans = await prisma.inventoryItem.create({ data: { name: 'Coffee beans', unit: 'g', currentQuantity: 5000, reorderLevel: 1000, costPerUnit: 1.8 } });
  const milkInv = await prisma.inventoryItem.create({ data: { name: 'Milk', unit: 'ml', currentQuantity: 20000, reorderLevel: 4000, costPerUnit: 0.12 } });
  await prisma.stockMovement.createMany({
    data: [
      { inventoryItemId: beans.id, movementType: 'COUNT_ADJUSTMENT', quantityDelta: 5000, unitCost: 1.8, note: 'Opening stock' },
      { inventoryItemId: milkInv.id, movementType: 'COUNT_ADJUSTMENT', quantityDelta: 20000, unitCost: 0.12, note: 'Opening stock' },
    ],
  });
  await prisma.recipe.create({
    data: {
      menuItemId: cappuccino.id, name: 'Cappuccino', yieldQuantity: 1,
      items: { create: [{ inventoryItemId: beans.id, quantityRequired: 18, unit: 'g' }, { inventoryItemId: milkInv.id, quantityRequired: 150, unit: 'ml' }] },
    },
  });
  console.log('✓ Demo staff (manager/cashier/kitchen @cafe.local), floor + tables, sample menu and stock');
}

async function main() {
  await seedAccess();
  await seedReference();
  await seedOwner();
  if (process.env.SEED_DEMO === 'true') await seedDemo();
  console.log('✓ Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
