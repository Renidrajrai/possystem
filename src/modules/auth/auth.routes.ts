import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, me } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { prisma } from '../../config/prisma';
import * as svc from './auth.service';

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many login attempts. Try again later.' } },
});

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: z.object({ email: z.string().email(), password: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    res.json(await svc.login(req.body.email, req.body.password, req.ip));
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: me(req).id },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    res.json(svc.publicUser(u));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }) }),
  asyncHandler(async (req, res) => {
    await svc.changePassword(me(req).id, req.body.currentPassword, req.body.newPassword);
    res.json({ ok: true });
  }),
);
