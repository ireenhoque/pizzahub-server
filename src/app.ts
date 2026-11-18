import type { Express } from 'express';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { requireAuth } from './app/auth/require-auth.js';
import { env } from './app/config/env.js';
import { globalErrorHandler } from './app/error/globalErrorHandler.js';
import { notFoundHandler } from './app/error/notFoundHandler.js';
import { createApiRouter } from './app/routes/index.js';
import type { UploadImageFn } from './app/modules/menuItems/menu-item.types.js';

export interface AppOptions {
  /**
   * Injectable auth middleware — defaults to the env-wired `requireAuth`.
   * Tests inject an instance pointed at a local JWKS endpoint.
   */
  requireAuthMiddleware?: typeof requireAuth;
  /** Injectable image uploader — defaults to ImgBB. Tests inject fakes. */
  uploadImage?: UploadImageFn;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // --- Global middlewares ---
  app.use(
    cors({
      origin: '*',
    }),
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // --- Request logging ---
  app.use(morgan(env.isDevelopment ? 'dev' : 'combined'));

  // --- API routes ---
  app.use(
    '/api',
    createApiRouter({
      requireAuth: options.requireAuthMiddleware ?? requireAuth,
      uploadImage: options.uploadImage,
    }),
  );

  // --- 404 handler (must come after all routes) ---
  app.all('/{*splat}', notFoundHandler);

  // --- Centralized error handler (must come last) ---
  app.use(globalErrorHandler);

  return app;
}

export default createApp();
