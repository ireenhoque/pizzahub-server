import { Router, type RequestHandler } from 'express';
import { requireAdmin } from '../../auth/require-auth.js';
import * as controllers from './admin.controller.js';

export function createAdminRouter(requireAuth: RequestHandler): Router {
  const router = Router();

  router.get('/overview', requireAuth, requireAdmin, controllers.getOverview);

  return router;
}
