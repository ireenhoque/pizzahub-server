import type { AuthenticatedUser } from './auth.types.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * Verified authentication context, set exclusively by the
       * `createJwtAuthMiddleware` middleware. Undefined on public routes
       * and on requests that failed authentication.
       */
      auth?: AuthenticatedUser;
    }
  }
}

export {};
