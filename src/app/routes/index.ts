import { Router, type RequestHandler } from 'express';
import { checkDatabaseHealth } from '../config/db.js';
import { env } from '../config/env.js';
import { createAdminRouter } from '../modules/admin/admin.routes.js';
import { createUserRouter } from '../modules/users/user.routes.js';
import { createOrderRouter } from '../modules/orders/order.routes.js';
import { createMenuRouter } from '../modules/menuItems/menu.routes.js';
import { createTransactionRouter } from '../modules/transactions/transaction.routes.js';
import {
  createStripeWebhookRouter,
  createSubscriptionRouter,
} from '../modules/subscriptions/subscription.routes.js';
import {
  createStripeBillingGateway,
  type StripeBillingGateway,
} from '../modules/subscriptions/stripe.client.js';

import type { UploadImageFn } from '../modules/menuItems/menu-item.types.js';

export interface ApiRouterOptions {
  /** Injectable auth middleware (tests supply a local-JWKS instance). */
  requireAuth: RequestHandler;
  /** Injectable image uploader (tests supply fakes). */
  uploadImage?: UploadImageFn;
  /** Injectable Stripe gateway (tests supply fakes; default is the real SDK). */
  stripeGateway?: StripeBillingGateway;
}

export function createApiRouter(options: ApiRouterOptions): Router {
  const router = Router();

  const stripeGateway = options.stripeGateway ?? createStripeBillingGateway();

  // GET /api/health (public)
  router.get('/health', async (_req, res) => {
    const database = await checkDatabaseHealth();

    const response = {
      success: true,
      message: 'PizzaHub API is healthy',
      data: {
        server: 'ok',
        environment: env.nodeEnv,
        uptime: `${process.uptime().toFixed(2)}s`,
        timestamp: new Date().toISOString(),
        database: database.ok
          ? ({ status: 'connected', latencyMs: database.latencyMs } as const)
          : ({ status: 'unreachable', error: database.error ?? 'unknown' } as const),
      },
    };

    res.status(database.ok ? 200 : 503).json(response);
  });

  // /api/users 窶・user & profile APIs
  router.use('/users', createUserRouter(options.requireAuth));

  // /api/orders 窶・order APIs
  router.use('/orders', createOrderRouter(options.requireAuth));

  router.use(
    '/menu-items',
    createMenuRouter(options.requireAuth, { uploadImage: options.uploadImage }),
  );

  // /api/admin - admin-only overview statistics
  router.use('/admin', createAdminRouter(options.requireAuth));

  // /api/transactions - admin-only transaction history
  router.use('/transactions', createTransactionRouter(options.requireAuth));
  // /api/subscriptions 窶・vendor Premium subscription management
  router.use('/subscriptions', createSubscriptionRouter(options.requireAuth, stripeGateway));

  // /api/stripe/webhook 窶・Stripe events (HMAC-secured; raw body registered
  // in create-app.ts before express.json()).
  router.use('/stripe/webhook', createStripeWebhookRouter(stripeGateway));

  return router;
}
