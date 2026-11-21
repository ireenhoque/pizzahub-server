import type { Express } from 'express';
import { createApp, type AppOptions } from './create-app.js';
import { databaseBootstrapMiddleware } from './app/config/bootstrap.js';

/**
 * Vercel entry point: exports the Express application only.
 *
 * Do not call `app.listen()` here. Vercel invokes this app as a Function and
 * manages the HTTP listener. The long-running local server lives in
 * `src/scripts/serve-local.ts`.
 */
export function createVercelApp(options: AppOptions = {}): Express {
  return createApp({
    ...options,
    bootstrapMiddleware: options.bootstrapMiddleware ?? databaseBootstrapMiddleware,
  });
}

const app = createVercelApp();

export default app;
