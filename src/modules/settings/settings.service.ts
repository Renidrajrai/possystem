import { prisma, type Tx } from '../../config/prisma';
import { D, type Money } from '../../utils/money';

/** The single business_settings row (id = 1). Created with safe defaults if the seed was skipped. */
export async function getSettings(tx: Tx | typeof prisma = prisma) {
  return tx.businessSettings.upsert({
    where: { id: 1 },
    create: { id: 1, businessName: 'My Café' },
    update: {},
  });
}

export interface PricingConfig {
  taxRatePercent: Money;
  taxProfileName: string | null;
  pricesIncludeTax: boolean;
  serviceChargePct: Money;
  maxCashierDiscountPercent: Money;
}

/** Tax comes from the configured default profile's rate in effect right now. No profile => 0%. */
export async function getPricingConfig(tx: Tx | typeof prisma = prisma, at = new Date()): Promise<PricingConfig> {
  const s = await getSettings(tx);
  let taxRatePercent = D(0);
  let taxProfileName: string | null = null;
  if (s.defaultTaxProfileId) {
    const rate = await tx.taxRate.findFirst({
      where: {
        taxProfileId: s.defaultTaxProfileId,
        taxProfile: { isActive: true },
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { taxProfile: true },
    });
    if (rate) {
      taxRatePercent = rate.ratePercent;
      taxProfileName = rate.taxProfile.name;
    }
  }
  return {
    taxRatePercent,
    taxProfileName,
    pricesIncludeTax: s.pricesIncludeTax,
    serviceChargePct: s.serviceChargePct,
    maxCashierDiscountPercent: s.maxCashierDiscountPercent,
  };
}
