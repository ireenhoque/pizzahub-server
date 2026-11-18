import cors from 'cors';
import express, { type Application } from 'express';
import morgan from 'morgan';
import { env } from './app/config/env.js';
import { globalErrorHandler } from './app/error/globalErrorHandler.js';
import { notFoundHandler } from './app/error/notFoundHandler.js';
import router from './app/routes/index.js';

const app: Application = express();

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
app.use('/api', router);

// --- 404 handler (must come after all routes) ---
app.all('/{*splat}', notFoundHandler);

// --- Centralized error handler (must come last) ---
app.use(globalErrorHandler);

export default app;
