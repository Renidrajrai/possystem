import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { PERMISSIONS } from '../../config/permissions';
import { D, ZERO, sum } from '../../utils/money';
import { localDayRange, localRange, localToday } from '../../utils/time';
import { shiftSummary } from '../shifts/shifts.routes';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const rangeQuery = z.object({ from: dateStr.optional(), to: dateStr.optional() });
const PAID_ORDER = ['PAID', 'PARTIALLY_REFUNDED'] as const;

/**
 * Definitions (so numbers can be reconciled):
 *  - Sales      = bills with status PAID, by the date they were fully paid (café-local day).
 *  - Refunds    = refunds by the date they were processed.
 *  - Net sales  = sales total - refunds.
 *  - Revenue is NOT profit: see /gross-margin for recipe-cost based estimates only.
 */
async function salesSummary(start: Date, end: Date) {
  const [bills, refunds, cancelled, byType] = await Promise.all([
    prisma.bill.aggregate({
      where: { status: 'PAID', paidAt: { gte: start, lt: end } },
      _count: true,
      _sum: { subtotal: true, discount: true, serviceCharge: true, tax: true, totalDue: true },
    }),
    prisma.refund.aggregate({ where: { createdAt: { gte: start, lt: end } }, _sum: { amount: true }, _count: true }),
    prisma.order.count({ where: { fulfilmentStatus: 'CANCELLED', createdAt: { gte: start, lt: end } } }),
    prisma.order.groupBy({ by: ['orderType'], where: { paymentStatus: { in: [...PAID_ORDER] }, createdAt: { gte: start, lt: end } }, _count: true, _sum: { totalAmount: true } }),
  ]);
  const gross = bills._sum.totalDue ?? ZERO;
  const refunded = refunds._sum.amount ?? ZERO;
  return {
    paidBills: bills._count,
    subtotal: bills._sum.subtotal ?? ZERO,
    discounts: bills._sum.discount ?? ZERO,
    serviceCharge: bills._sum.serviceCharge ?? ZERO,
    tax: bills._sum.tax ?? ZERO,
    grossSales: gross,
    refunds: refunded,
    refundCount: refunds._count,
    netSales: gross.minus(refunded),
    averageBill: bills._count ? gross.div(bills._count).toDecimalPlaces(2) : ZERO,
    cancelledOrders: cancelled,
    byOrderType: byType.map((t) => ({ orderType: t.orderType, orders: t._count, total: t._sum.totalAmount ?? ZERO })),
  };
}

async function paymentsBreakdown(start: Date, end: Date) {
  const [ok, failed, methods] = await Promise.all([
    prisma.payment.groupBy({ by: ['paymentMethodId'], where: { status: 'SUCCESS', paidAt: { gte: start, lt: end } }, _count: true, _sum: { amount: true } }),
    prisma.payment.groupBy({ by: ['paymentMethodId'], where: { status: { in: ['FAILED', 'CANCELLED'] }, createdAt: { gte: start, lt: end } }, _count: true }),
    prisma.paymentMethod.findMany(),
  ]);
  const name = new Map(methods.map((m) => [m.id, m.name]));
  return methods.map((m) => {
    const s = ok.find((x) => x.paymentMethodId === m.id);
    return { methodId: m.id, method: name.get(m.id)!, payments: s?._count ?? 0, total: s?._sum.amount ?? ZERO, failedOrCancelled: failed.find((x) => x.paymentMethodId === m.id)?._count ?? 0 };
  }).filter((r) => r.payments || r.failedOrCancelled);
}

export const reportsRouter = Router();
reportsRouter.use(authenticate, requirePermission(PERMISSIONS.REPORT_VIEW));

// Dashboard: today at a glance + alerts
reportsRouter.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    const today = localToday();
    const { start, end } = localDayRange(today);
    const [sales, payments, openOrders, unpaidBills, openShifts, inventory] = await Promise.all([
      salesSummary(start, end),
      paymentsBreakdown(start, end),
      prisma.order.count({ where: { fulfilmentStatus: { in: ['OPEN', 'SENT_TO_KITCHEN', 'IN_PROGRESS', 'READY', 'SERVED'] } } }),
      prisma.bill.count({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } } }),
      prisma.shift.count({ where: { status: 'OPEN' } }),
      prisma.inventoryItem.findMany({ where: { isActive: true }, select: { currentQuantity: true, reorderLevel: true } }),
    ]);
    res.json({
      date: today,
      sales,
      payments,
      live: { openOrders, unpaidBills, openShifts },
      alerts: { lowStockItems: inventory.filter((i) => i.currentQuantity.lessThanOrEqualTo(i.reorderLevel)).length },
    });
  }),
);

reportsRouter.get(
  '/daily',
  validate({ query: z.object({ date: dateStr.optional() }) }),
  asyncHandler(async (req, res) => {
    const date = (req.query as any).date ?? localToday();
    const { start, end } = localDayRange(date);
    const [sales, payments] = await Promise.all([salesSummary(start, end), paymentsBreakdown(start, end)]);
    res.json({ date, sales, payments });
  }),
);

// Revenue trend (grouped in café-local time)
reportsRouter.get(
  '/sales',
  validate({ query: rangeQuery.extend({ groupBy: z.enum(['day', 'month']).default('day') }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { start, end } = localRange(q.from, q.to);
    const rows = await prisma.$queryRaw<{ period: string; bills: number; subtotal: unknown; discounts: unknown; tax: unknown; total: unknown }[]>`
      SELECT to_char(date_trunc(${q.groupBy}::text, "paidAt" + (${env.TZ_OFFSET_MINUTES}::int * interval '1 minute')), 'YYYY-MM-DD') AS period,
             COUNT(*)::int AS bills, SUM(subtotal) AS subtotal, SUM(discount) AS discounts, SUM(tax) AS tax, SUM("totalDue") AS total
      FROM "bills"
      WHERE status = 'PAID' AND "paidAt" >= ${start} AND "paidAt" < ${end}
      GROUP BY 1 ORDER BY 1`;
    res.json({ groupBy: q.groupBy, from: start, to: end, rows });
  }),
);

reportsRouter.get(
  '/top-items',
  validate({ query: rangeQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(10) }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { start, end } = localRange(q.from, q.to);
    const rows = await prisma.$queryRaw<{ menuItemId: number; name: string; quantity: number; revenue: unknown }[]>`
      SELECT oi."menuItemId", oi."itemNameSnapshot" AS name, SUM(oi.quantity)::int AS quantity, SUM(oi."lineTotal") AS revenue
      FROM "order_items" oi JOIN "orders" o ON o.id = oi."orderId"
      WHERE oi."itemStatus" <> 'CANCELLED' AND o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')
        AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
      GROUP BY oi."menuItemId", oi."itemNameSnapshot"
      ORDER BY quantity DESC, revenue DESC LIMIT ${q.limit}`;
    res.json(rows);
  }),
);

reportsRouter.get(
  '/category-sales',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { start, end } = localRange(q.from, q.to);
    const rows = await prisma.$queryRaw<{ categoryId: number; category: string; quantity: number; revenue: unknown }[]>`
      SELECT c.id AS "categoryId", c.name AS category, SUM(oi.quantity)::int AS quantity, SUM(oi."lineTotal") AS revenue
      FROM "order_items" oi
      JOIN "orders" o ON o.id = oi."orderId"
      JOIN "menu_items" mi ON mi.id = oi."menuItemId"
      JOIN "categories" c ON c.id = mi."categoryId"
      WHERE oi."itemStatus" <> 'CANCELLED' AND o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')
        AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
      GROUP BY c.id, c.name ORDER BY revenue DESC`;
    res.json(rows);
  }),
);

reportsRouter.get(
  '/payments',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { start, end } = localRange(q.from, q.to);
    res.json({ from: start, to: end, methods: await paymentsBreakdown(start, end) });
  }),
);

// Cashier / shift report: sales and cash reconciliation per shift
reportsRouter.get(
  '/shifts',
  validate({ query: rangeQuery.extend({ userId: z.coerce.number().int().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { start, end } = localRange(q.from, q.to);
    const shifts = await prisma.shift.findMany({ where: { openedAt: { gte: start, lt: end }, userId: q.userId }, orderBy: { openedAt: 'desc' } });
    const out = [];
    for (const s of shifts) {
      const sm = await shiftSummary(prisma, s.id);
      out.push({
        id: s.id,
        cashier: sm.shift.user,
        status: s.status,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        orders: sm.orders,
        paymentsByMethod: sm.paymentsByMethod,
        cash: sm.cash,
        actualClosingCash: s.actualClosingCash,
        cashDifference: s.cashDifference,
      });
    }
    res.json(out);
  }),
);

reportsRouter.get(
  '/inventory',
  asyncHandler(async (_req, res) => {
    const items = await prisma.inventoryItem.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    const rows = items.map((i) => ({
      ...i,
      stockValue: i.currentQuantity.times(i.costPerUnit).toDecimalPlaces(2),
      status: i.currentQuantity.lessThan(0) ? 'NEGATIVE' : i.currentQuantity.lessThanOrEqualTo(i.reorderLevel) ? 'LOW' : 'OK',
    }));
    res.json({ totalStockValue: sum(rows.map((r) => r.stockValue)), lowOrNegative: rows.filter((r) => r.status !== 'OK'), items: rows });
  }),
);

reportsRouter.get(
  '/wastage',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { start, end } = localRange(q.from, q.to);
    const moves = await prisma.stockMovement.findMany({
      where: { movementType: 'WASTAGE', createdAt: { gte: start, lt: end } },
      include: { inventoryItem: { select: { name: true, unit: true } }, createdBy: { select: { name: true } } },
      orderBy: { id: 'desc' },
    });
    const rows = moves.map((m) => ({ id: m.id, item: m.inventoryItem.name, unit: m.inventoryItem.unit, quantity: m.quantityDelta.abs(), estimatedCost: m.quantityDelta.abs().times(m.unitCost ?? 0).toDecimalPlaces(2), reason: m.note, by: m.createdBy?.name ?? null, at: m.createdAt }));
    res.json({ totalEstimatedCost: sum(rows.map((r) => r.estimatedCost)), rows });
  }),
);

// Estimated gross margin = selling price less recipe cost. NOT business profit (rent, wages, etc. excluded).
reportsRouter.get(
  '/gross-margin',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { start, end } = localRange(q.from, q.to);
    const sold = await prisma.orderItem.groupBy({
      by: ['menuItemId', 'variantId'],
      where: { itemStatus: { not: 'CANCELLED' }, order: { paymentStatus: { in: [...PAID_ORDER] }, createdAt: { gte: start, lt: end } } },
      _sum: { quantity: true, lineTotal: true },
    });
    const recipes = await prisma.recipe.findMany({ where: { isActive: true }, include: { items: { include: { inventoryItem: true } } } });
    const names = new Map((await prisma.menuItem.findMany({ select: { id: true, name: true } })).map((m) => [m.id, m.name]));
    const rows = sold.map((s) => {
      const r = recipes.find((x) => x.menuItemId === s.menuItemId && x.variantId === s.variantId) ?? recipes.find((x) => x.menuItemId === s.menuItemId && x.variantId === null);
      const units = s._sum.quantity ?? 0;
      const revenue = s._sum.lineTotal ?? ZERO;
      const unitCost = r ? sum(r.items.map((i) => i.quantityRequired.times(i.inventoryItem.costPerUnit))).div(r.yieldQuantity || 1) : null;
      const cost = unitCost ? unitCost.times(units).toDecimalPlaces(2) : null;
      return {
        menuItemId: s.menuItemId,
        variantId: s.variantId,
        name: names.get(s.menuItemId) ?? `#${s.menuItemId}`,
        unitsSold: units,
        revenue,
        estimatedCost: cost,
        estimatedMargin: cost ? revenue.minus(cost) : null,
        marginPercent: cost && !revenue.isZero() ? revenue.minus(cost).div(revenue).times(100).toDecimalPlaces(1) : null,
        hasRecipe: Boolean(r),
      };
    });
    res.json({ note: 'Revenue minus ingredient cost only. Excludes rent, wages, utilities, fees and taxes.', rows: rows.sort((a, b) => D(b.revenue).comparedTo(a.revenue)) });
  }),
);
