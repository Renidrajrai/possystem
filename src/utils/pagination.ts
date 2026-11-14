import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const pageArgs = (p: { page: number; pageSize: number }) => ({
  skip: (p.page - 1) * p.pageSize,
  take: p.pageSize,
});

export const pageMeta = (p: { page: number; pageSize: number }, total: number) => ({
  page: p.page,
  pageSize: p.pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
});
