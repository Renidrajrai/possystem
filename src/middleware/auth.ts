import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import type { PermissionCode } from '../config/permissions';
import { forbidden, unauthorized } from '../utils/errors';
import { asyncHandler } from '../utils/asyncHandler';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  roleId: number;
  role: string;
  permissions: Set<string>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface TokenPayload {
  sub: string;
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: String(userId) } satisfies TokenPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string' || !decoded.sub) throw new Error('bad token');
    return decoded as TokenPayload;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

/** Load the user + permissions fresh from the DB so deactivation / role changes apply immediately. */
export async function loadAuthUser(userId: number): Promise<AuthUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  if (!user || !user.isActive) throw unauthorized('Account is disabled or no longer exists');
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roleId: user.roleId,
    role: user.role.name,
    permissions: new Set(user.role.permissions.map((rp) => rp.permission.code)),
  };
}

export const authenticate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const payload = verifyToken(header.slice(7));
  req.user = await loadAuthUser(Number(payload.sub));
  next();
});

/** User must hold ALL listed permissions. */
export const requirePermission =
  (...codes: PermissionCode[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const missing = codes.filter((c) => !req.user!.permissions.has(c));
    if (missing.length) return next(forbidden());
    next();
  };

/** User must hold AT LEAST ONE of the listed permissions. */
export const requireAnyPermission =
  (...codes: PermissionCode[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!codes.some((c) => req.user!.permissions.has(c))) return next(forbidden());
    next();
  };

export const can = (user: AuthUser, code: PermissionCode) => user.permissions.has(code);
export const me = (req: Request): AuthUser => {
  if (!req.user) throw unauthorized();
  return req.user;
};
