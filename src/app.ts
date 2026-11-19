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
import type { StripeBillingGateway } from './app/modules/subscriptions/stripe.client.js';

export interface AppOptions {
  /**
   * Injectable auth middleware — defaults to the env-wired `requireAuth`.
   * Tests inject an instance pointed at a local JWKS endpoint.
   */
  requireAuthMiddleware?: typeof requireAuth;
  /** Injectable image uploader — defaults to ImgBB. Tests inject fakes. */
  uploadImage?: UploadImageFn;
  /** Injectable Stripe gateway — defaults to the real Stripe SDK. Tests inject fakes. */
  stripeGateway?: StripeBillingGateway;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // --- Global middlewares ---
  app.use(
    cors({
      origin: '*',
    }),
  );
  // Stripe webhooks are verified against the RAW request bytes (Stripe-
  // Signature HMAC). This path-level raw parser MUST be registered before
  // express.json(): once a body parser has consumed the stream and set
  // req.body to a parsed object, the original bytes are gone and signature
  // verification can no longer be done correctly.
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
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
      stripeGateway: options.stripeGateway,
    }),
  );

  // --- 404 handler (must come after all routes) ---
  app.all('/{*splat}', notFoundHandler);

  // --- Centralized error handler (must come last) ---
  app.use(globalErrorHandler);

  return app;
}

export default createApp();
