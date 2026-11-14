import { Router } from 'express';
import { z } from 'zod';
import { authenticate, me, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import { PERMISSIONS } from '../../config/permissions';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { hashPassword, publicUser } from '../auth/auth.service';
import { passwordSchema } from '../auth/auth.routes';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const include = { role: true } as const;

export const usersRouter = Router();
usersRouter.use(authenticate);

// ---- Roles & permissions (read-only; managed by seed) ----
usersRouter.get(
  '/roles',
  requirePermission(PERMISSIONS.ROLE_VIEW),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { id: 'asc' } });
    res.json(roles.map((r) => ({ id: r.id, name: r.name, description: r.description, permissions: r.permissions.map((p) => p.permission.code).sort() })));
  }),
);

// ---- Staff accounts ----
usersRouter.get(
  '/users',
  requirePermission(PERMISSIONS.USER_MANAGE),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ include, orderBy: { name: 'asc' } });
    res.json(users.map(publicUser));
  }),
);

usersRouter.post(
  '/users',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(100),
      email: z.string().email(),
      phone: z.string().trim().max(30).optional(),
      password: passwordSchema,
      roleId: z.number().int().positive(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!(await prisma.role.findUnique({ where: { id: b.roleId } }))) throw badRequest('Unknown role');
    const email = b.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) throw conflict('A user with this email already exists');
    const user = await prisma.user.create({
      data: { name: b.name, email, phone: b.phone, roleId: b.roleId, passwordHash: await hashPassword(b.password) },
      include,
    });
    await audit({ userId: me(req).id, action: 'USER_CREATED', entityType: 'User', entityId: user.id, after: { email, roleId: b.roleId } });
    res.status(201).json(publicUser(user));
  }),
);

usersRouter.patch(
  '/users/:id',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({
    params: idParam,
    body: z
      .object({
        name: z.string().trim().min(1).max(100),
        phone: z.string().trim().max(30).nullable(),
        roleId: z.number().int().positive(),
        isActive: z.boolean(),
      })
      .partial(),
  }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const actor = me(req);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw notFound('User');
    if (id === actor.id && (req.body.isActive === false || (req.body.roleId && req.body.roleId !== existing.roleId))) {
      throw badRequest('You cannot deactivate yourself or change your own role');
    }
    if (req.body.roleId && !(await prisma.role.findUnique({ where: { id: req.body.roleId } }))) throw badRequest('Unknown role');
    const user = await prisma.user.update({ where: { id }, data: req.body, include });
    await audit({
      userId: actor.id,
      action: 'USER_UPDATED',
      entityType: 'User',
      entityId: id,
      before: { roleId: existing.roleId, isActive: existing.isActive },
      after: { roleId: user.roleId, isActive: user.isActive },
    });
    res.json(publicUser(user));
  }),
);

usersRouter.post(
  '/users/:id/reset-password',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({ params: idParam, body: z.object({ newPassword: passwordSchema }) }),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.user.findUnique({ where: { id } }))) throw notFound('User');
    await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(req.body.newPassword) } });
    await audit({ userId: me(req).id, action: 'PASSWORD_RESET', entityType: 'User', entityId: id });
    res.json({ ok: true });
  }),
);
