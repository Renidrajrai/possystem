import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { corsOrigins, env, isProd } from './config/env';
import { prisma } from './config/prisma';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { asyncHandler } from './utils/asyncHandler';

import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { customersRouter } from './modules/customers/customers.routes';
import { settingsRouter } from './modules/settings/settings.routes';
import { categoriesRouter } from './modules/menu/categories.routes';
import { menuRouter } from './modules/menu/menu.routes';
import { modifiersRouter } from './modules/menu/modifiers.routes';
import { tablesRouter } from './modules/tables/tables.routes';
import { ordersRouter } from './modules/orders/orders.routes';
import { kitchenRouter } from './modules/kitchen/kitchen.routes';
import { billingRouter } from './modules/billing/billing.routes';
import { shiftsRouter } from './modules/shifts/shifts.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { inventoryRouter } from './modules/inventory/inventory.routes';

// Money (Decimal) already serialises as a string. BigInt ids (audit log, stock ledger) need a shim.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (isProd) app.set('trust proxy', 1); // running behind a reverse proxy / HTTPS terminator

  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true, exposedHeaders: ['Idempotency-Key'] }));
  app.use(express.json({ limit: '200kb' }));
  app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

  if (!isProd && env.NODE_ENV !== 'test') {
    app.use((req, res, next) => {
      const t = Date.now();
      res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t}ms`));
      next();
    });
  }

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', time: new Date().toISOString() });
    }),
  );

  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/staff', usersRouter); // /staff/users, /staff/roles
  api.use('/audit-logs', auditRouter);
  api.use('/customers', customersRouter);
  api.use('/settings', settingsRouter);
  api.use('/categories', categoriesRouter);
  api.use('/menu', menuRouter);
  api.use('/modifiers', modifiersRouter);
  api.use('/tables', tablesRouter);
  api.use('/orders', ordersRouter);
  api.use('/kitchen', kitchenRouter);
  api.use('/shifts', shiftsRouter);
  api.use('/reports', reportsRouter);
  api.use('/inventory', inventoryRouter);
  api.use(billingRouter); // /orders/:id/checkout, /bills/*, /payments/:id/refunds (per-route auth)
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
