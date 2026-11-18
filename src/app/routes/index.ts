import { Router } from 'express';
import { env } from '../config/env.js';

const router = Router();

// GET /api/health
router.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'PizzaHub API is healthy',
    data: {
      environment: env.nodeEnv,
      uptime: `${process.uptime().toFixed(2)}s`,
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
