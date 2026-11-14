import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validate and replace req.body / req.query / req.params with the parsed (typed, coerced) values.
 * ZodErrors are turned into a 400 by the error handler.
 */
export const validate = (schemas: Schemas) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
    if (schemas.query) Object.defineProperty(req, 'query', { value: schemas.query.parse(req.query), writable: true });
    if (schemas.body) req.body = schemas.body.parse(req.body);
    next();
  } catch (err) {
    next(err);
  }
};
