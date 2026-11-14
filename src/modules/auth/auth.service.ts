import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';
import { signToken } from '../../middleware/auth';
import { badRequest, unauthorized } from '../../utils/errors';
import { audit } from '../../utils/audit';

// Used to keep login timing similar whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export async function login(email: string, password: string, ip?: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.isActive) {
    await audit({ userId: user?.id ?? null, action: 'LOGIN_FAILED', entityType: 'User', entityId: user?.id ?? email, ipAddress: ip });
    throw unauthorized('Incorrect email or password');
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return {
    token: signToken(user.id),
    user: publicUser(user),
  };
}

export function publicUser(user: {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  role: { id: number; name: string; permissions?: { permission: { code: string } }[] };
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    isActive: user.isActive,
    role: { id: user.role.id, name: user.role.name },
    ...(user.role.permissions ? { permissions: user.role.permissions.map((p) => p.permission.code).sort() } : {}),
  };
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect');
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS) } });
  await audit({ userId, action: 'PASSWORD_CHANGED', entityType: 'User', entityId: userId });
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, env.BCRYPT_ROUNDS);
