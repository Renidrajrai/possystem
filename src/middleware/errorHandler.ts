import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors';
import { isProd } from '../config/env';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

/** One consistent error shape: { error: { code, message, details? } }. Never leaks raw DB errors. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'A record with the same unique value already exists', details: { fields: err.meta?.target } },
        });
      case 'P2003':
        return res.status(409).json({ error: { code: 'CONFLICT', message: 'This record is referenced by other records or references a missing one' } });
      case 'P2025':
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
      case 'P2034':
        return res.status(409).json({ error: { code: 'CONFLICT', message: 'The operation conflicted with another request. Please retry.' } });
    }
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server', ...(isProd ? {} : { details: String((err as Error)?.message) }) },
  });
}
