import { Router } from 'express';
import { checkDatabaseHealth } from '../config/db.js';
import { env } from '../config/env.js';

const router = Router();

// GET /api/health
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

export default router;
