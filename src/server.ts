import type { Server } from 'http';
import app from './app.js';
import { connectDatabase, disconnectDatabase } from './app/config/db.js';
import { env } from './app/config/env.js';

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
  .then(() => {
    startServer();
  })
  .catch(() => {
    console.error('❌ Failed to start PizzaHub server because the database is unreachable');
    process.exit(1);
  });
