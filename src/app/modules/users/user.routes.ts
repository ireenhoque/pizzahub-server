import { Router, type RequestHandler } from 'express';
import { requireAdmin } from '../../auth/require-auth.js';
import { validate } from '../../middlewares/validate.js';
import * as controllers from './user.controller.js';
import {
  blockUserSchema,
  idParamSchema,
  listUsersQuerySchema,
  updateSelfSchema,
} from './user.validation.js';

/**
 * User & profile routes.
 *
 * There is NO registration endpoint: sign-up is owned by Better Auth, and
 * admin privileges can only ever be assigned server-side — so no public
 * admin registration is possible through this API.
 */
export function createUserRouter(requireAuth: RequestHandler): Router {
  const router = Router();

  // ── Self-service profile ─────────────────────────────────────────────
  // Ownership is inherent: the subject comes from the verified JWT.
  router.get('/me', requireAuth, controllers.getCurrentUser);
  // Strict Zod schema rejects role/isBlocked/subscription* self-updates.
  router.patch(
    '/me',
    requireAuth,
    validate({ body: updateSelfSchema }),
    controllers.updateCurrentUser,
  );

  // ── Admin-only user management ───────────────────────────────────────
  router.get(
    '/',
    requireAuth,
    requireAdmin,
    validate({ query: listUsersQuerySchema }),
    controllers.listUsers,
  );
  router.post(
    '/:id/block',
    requireAuth,
    requireAdmin,
    validate({ params: idParamSchema, body: blockUserSchema }),
    controllers.blockUser,
  );
  router.post(
    '/:id/unblock',
    requireAuth,
    requireAdmin,
    validate({ params: idParamSchema }),
    controllers.unblockUser,
  );

  return router;
}
