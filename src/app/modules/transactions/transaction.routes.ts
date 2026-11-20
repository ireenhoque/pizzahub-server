import { Router, type RequestHandler } from 'express';
import { requireAdmin } from '../../auth/require-auth.js';
import { validate } from '../../middlewares/validate.js';
import * as controllers from './transaction.controller.js';
import { listTransactionsQuerySchema } from './transaction.validation.js';

export function createTransactionRouter(requireAuth: RequestHandler): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireAdmin,
    validate({ query: listTransactionsQuerySchema }),
    controllers.listTransactions,
  );

  return router;
}
