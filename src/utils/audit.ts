import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../config/prisma';

export interface AuditInput {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId: string | number;
  reason?: string | null;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

/** Write an audit record. Pass `tx` to make it atomic with the change being audited. */
export async function audit(input: AuditInput, tx?: Tx) {
  const client = tx ?? prisma;
  await client.auditLog.create({
    data: {
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: String(input.entityId),
      reason: input.reason ?? null,
      before: input.before,
      after: input.after,
      ipAddress: input.ipAddress ?? null,
    },
  });
}
