import type { AuthenticatedUser, VerifiedJwtContext } from './auth.types.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * Full, DB-backed authentication context, set exclusively by the
       * `requireAuth` middleware (role and block status verified against
       * MongoDB on every request). Undefined on public routes and on
       * requests that failed authentication.
       */
      auth?: AuthenticatedUser;
      /**
       * Token-only verified JWT context, set by the lower-level
       * `createJwtAuthMiddleware`. Contains no DB-verified role.
       */
      jwt?: VerifiedJwtContext;
    }
  }
}

export {};
