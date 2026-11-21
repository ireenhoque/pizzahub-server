import type { Server } from 'http';
import app from './app.js';
import { connectDatabase, disconnectDatabase } from './app/config/db.js';
import { env } from './app/config/env.js';
import { ensureRequiredIndexes } from './app/db/indexes.js';
import { enforceExpiredPremiumMenuLimits } from './app/modules/menuItems/free-plan-limit.js';

let server: Server | null = null;

const startServer = (): void => {
  server = app.listen(env.port, () => {
    console.log(`🚀 PizzaHub server running in ${env.nodeEnv} mode on port ${env.port}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${env.port} is already in use`);
      process.exit(1);
    }

    throw error;
  });
};

const shutdown = (exitCode: number, logLine: string): void => {
  console.log(logLine);

  const closeHttpServer = (): Promise<void> =>
    new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

  void Promise.all([closeHttpServer(), disconnectDatabase()]).then(() => process.exit(exitCode));
};

const exitWithError = (error: unknown, origin: string): void => {
  console.error(`${origin}:`, error);
  shutdown(1, '🛑 Shutting down after fatal error');
};

process.on('uncaughtException', (error) => exitWithError(error, 'uncaughtException'));
process.on('unhandledRejection', (reason) => exitWithError(reason, 'unhandledRejection'));
process.on('SIGTERM', () => shutdown(0, '🛑 SIGTERM received, shutting down gracefully'));
process.on('SIGINT', () => shutdown(0, '🛑 SIGINT received, shutting down gracefully'));

connectDatabase()
  .then(async (db) => {
    // Creates and verifies the Stripe idempotency indexes before any request
    // can be accepted. Optional indexes on missing collections stay skipped.
    await ensureRequiredIndexes(db);

    // Expiry is time-based (no scheduler), so reconcile already-lapsed premium
    // vendors at boot as well. No documents are deleted; excess active items
    // are moved to the existing `inactive` state.
    await enforceExpiredPremiumMenuLimits();

    startServer();
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Only surface bootstrap messages we control; a raw Mongo error could
    // contain connection-string credentials.
    const safeMessage = message.startsWith('Required') ? message : 'Database bootstrap failed';
    console.error(`❌ Failed to start PizzaHub server: ${safeMessage}`);
    process.exit(1);
  });
