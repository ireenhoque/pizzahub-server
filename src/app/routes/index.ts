import { Router, type RequestHandler } from 'express';
import { checkDatabaseHealth } from '../config/db.js';
import { env } from '../config/env.js';
import { createUserRouter } from '../modules/users/user.routes.js';
import { createMenuRouter } from '../modules/menuItems/menu.routes.js';
import type { UploadImageFn } from '../modules/menuItems/menu-item.types.js';

export interface ApiRouterOptions {
  /** Injectable auth middleware (tests supply a local-JWKS instance). */
  requireAuth: RequestHandler;
  /** Injectable image uploader (tests supply fakes). */
  uploadImage?: UploadImageFn;
}

export function createApiRouter(options: ApiRouterOptions): Router {
  const router = Router();

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

  // /api/users — user & profile APIs
  router.use('/users', createUserRouter(options.requireAuth));

  // /api/menu-items — vendor menu APIs
  router.use(
    '/menu-items',
    createMenuRouter(options.requireAuth, { uploadImage: options.uploadImage }),
  );

  return router;
}
