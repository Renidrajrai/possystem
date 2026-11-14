import { Prisma } from '@prisma/client';

export type Money = Prisma.Decimal;
export const D = (v: Prisma.Decimal.Value): Money => new Prisma.Decimal(v);
export const ZERO = D(0);

/** Round to 2 decimal places, half up (standard for currency). */
export const round2 = (v: Prisma.Decimal.Value): Money => D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export const sum = (values: Prisma.Decimal.Value[]): Money =>
  values.reduce<Money>((acc, v) => acc.plus(v), ZERO);

export const min = (a: Money, b: Money): Money => (a.lessThan(b) ? a : b);
