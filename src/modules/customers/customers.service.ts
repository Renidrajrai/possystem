import { randomUUID } from 'crypto';
import { prisma, type Tx } from '../../config/prisma';
import { conflict, notFound } from '../../utils/errors';
import { formatMembershipNumber, normalizePhone } from '../../utils/phone';

/**
 * Create a member. Phone is the unique identity (normalised E.164).
 * The membership number is derived from the DB-assigned sequence inside the same
 * transaction, so numbers are unique and never reused.
 */
export async function createCustomer(
  tx: Tx,
  data: { phone: string; name?: string | null; email?: string | null; notes?: string | null },
) {
  const phone = normalizePhone(data.phone);
  const created = await tx.customer.create({
    data: { phone, name: data.name ?? null, email: data.email ?? null, notes: data.notes ?? null, membershipNumber: `PENDING-${randomUUID()}` },
  });
  return tx.customer.update({
    where: { id: created.id },
    data: { membershipNumber: formatMembershipNumber(created.membershipSeq) },
  });
}

/** Find the member by phone or register them on the spot (race-safe via an atomic upsert). */
export async function findOrCreateByPhone(tx: Tx, phoneInput: string, name?: string | null) {
  const phone = normalizePhone(phoneInput);
  const customer = await tx.customer.upsert({
    where: { phone },
    create: { phone, name: name ?? null, membershipNumber: `PENDING-${randomUUID()}` },
    update: {},
  });
  // Only a row created by this transaction is still PENDING; finalise its membership number.
  if (customer.membershipNumber.startsWith('PENDING-')) {
    return tx.customer.update({
      where: { id: customer.id },
      data: { membershipNumber: formatMembershipNumber(customer.membershipSeq) },
    });
  }
  if (!customer.isActive) throw conflict('This membership is deactivated');
  if (name && !customer.name) return tx.customer.update({ where: { id: customer.id }, data: { name } });
  return customer;
}

export async function lookupByPhone(phoneInput: string) {
  const phone = normalizePhone(phoneInput);
  const customer = await prisma.customer.findUnique({ where: { phone } });
  if (!customer) throw notFound('Customer');
  return customer;
}
