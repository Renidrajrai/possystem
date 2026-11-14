import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requireAnyPermission, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { badRequest, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { getSettings } from './settings.service';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const manage = requirePermission(PERMISSIONS.SETTINGS_MANAGE);
const pct = z.number().min(0).max(100);

export const settingsRouter = Router();
settingsRouter.use(authenticate);

// ---------------- Business settings ----------------
settingsRouter.get(
  '/business',
  asyncHandler(async (_req, res) => {
    res.json(await getSettings());
  }),
);

settingsRouter.put(
  '/business',
  manage,
  validate({
    body: z
      .object({
        businessName: z.string().trim().min(1).max(150),
        address: z.string().max(300).nullable(),
        phone: z.string().max(30).nullable(),
        panNumber: z.string().max(30).nullable(),
        vatNumber: z.string().max(30).nullable(),
        currency: z.string().length(3),
        receiptFooter: z.string().max(300).nullable(),
        serviceChargePct: pct,
        defaultTaxProfileId: z.number().int().positive().nullable(),
        pricesIncludeTax: z.boolean(),
        maxCashierDiscountPercent: pct,
      })
      .partial(),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.defaultTaxProfileId) {
      const p = await prisma.taxProfile.findUnique({ where: { id: req.body.defaultTaxProfileId } });
      if (!p || !p.isActive) throw badRequest('Tax profile not found or inactive');
    }
    const before = await getSettings();
    const after = await prisma.businessSettings.update({ where: { id: 1 }, data: req.body });
    await audit({
      userId: me(req).id,
      action: 'SETTINGS_UPDATED',
      entityType: 'BusinessSettings',
      entityId: 1,
      before: { serviceChargePct: before.serviceChargePct.toString(), defaultTaxProfileId: before.defaultTaxProfileId, pricesIncludeTax: before.pricesIncludeTax },
      after: { serviceChargePct: after.serviceChargePct.toString(), defaultTaxProfileId: after.defaultTaxProfileId, pricesIncludeTax: after.pricesIncludeTax },
    });
    res.json(after);
  }),
);

// ---------------- Tax profiles & rates ----------------
settingsRouter.get(
  '/tax-profiles',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.taxProfile.findMany({ include: { rates: { orderBy: { effectiveFrom: 'desc' } } }, orderBy: { id: 'asc' } }));
  }),
);

settingsRouter.post(
  '/tax-profiles',
  manage,
  validate({ body: z.object({ name: z.string().trim().min(1).max(80) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.taxProfile.create({ data: { name: req.body.name } }));
  }),
);

settingsRouter.patch(
  '/tax-profiles/:id',
  manage,
  validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(80), isActive: z.boolean() }).partial() }),
  asyncHandler(async (req, res) => {
    res.json(await prisma.taxProfile.update({ where: { id: Number(req.params.id) }, data: req.body }));
  }),
);

settingsRouter.post(
  '/tax-profiles/:id/rates',
  manage,
  validate({
    params: idParam,
    body: z.object({ name: z.string().trim().min(1).max(80), ratePercent: pct, effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().nullable().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const taxProfileId = Number(req.params.id);
    if (!(await prisma.taxProfile.findUnique({ where: { id: taxProfileId } }))) throw notFound('Tax profile');
    if (req.body.effectiveTo && req.body.effectiveTo <= req.body.effectiveFrom) throw badRequest('effectiveTo must be after effectiveFrom');
    // Close the currently open rate so there is no overlap.
    await prisma.taxRate.updateMany({
      where: { taxProfileId, effectiveTo: null, effectiveFrom: { lt: req.body.effectiveFrom } },
      data: { effectiveTo: req.body.effectiveFrom },
    });
    const rate = await prisma.taxRate.create({ data: { ...req.body, taxProfileId } });
    await audit({ userId: me(req).id, action: 'TAX_RATE_CREATED', entityType: 'TaxRate', entityId: rate.id, after: { ratePercent: String(req.body.ratePercent) } });
    res.status(201).json(rate);
  }),
);

// ---------------- Payment methods ----------------
settingsRouter.get(
  '/payment-methods',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.paymentMethod.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }));
  }),
);

settingsRouter.get(
  '/payment-methods/all',
  manage,
  asyncHandler(async (_req, res) => {
    res.json(await prisma.paymentMethod.findMany({ orderBy: { id: 'asc' } }));
  }),
);

settingsRouter.post(
  '/payment-methods',
  manage,
  validate({ body: z.object({ name: z.string().trim().min(1).max(50), requiresReference: z.boolean().default(false), isCash: z.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.paymentMethod.create({ data: req.body }));
  }),
);

settingsRouter.patch(
  '/payment-methods/:id',
  manage,
  validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(50), requiresReference: z.boolean(), isCash: z.boolean(), isActive: z.boolean() }).partial() }),
  asyncHandler(async (req, res) => {
    res.json(await prisma.paymentMethod.update({ where: { id: Number(req.params.id) }, data: req.body }));
  }),
);

// ---------------- Kitchen stations ----------------
settingsRouter.get(
  '/kitchen-stations',
  requireAnyPermission(PERMISSIONS.KITCHEN_VIEW, PERMISSIONS.MENU_VIEW, PERMISSIONS.SETTINGS_MANAGE),
  asyncHandler(async (_req, res) => {
    res.json(await prisma.kitchenStation.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }));
  }),
);

settingsRouter.post(
  '/kitchen-stations',
  manage,
  validate({ body: z.object({ name: z.string().trim().min(1).max(50) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.kitchenStation.create({ data: req.body }));
  }),
);

settingsRouter.patch(
  '/kitchen-stations/:id',
  manage,
  validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(50), isActive: z.boolean() }).partial() }),
  asyncHandler(async (req, res) => {
    res.json(await prisma.kitchenStation.update({ where: { id: Number(req.params.id) }, data: req.body }));
  }),
);
