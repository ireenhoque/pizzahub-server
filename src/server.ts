import app from './app.js';
import { env } from './app/config/env.js';

const server = app.listen(env.port, () => {
  console.log(`🚀 PizzaHub server running in ${env.nodeEnv} mode on port ${env.port}`);
});

const exitWithError = (error: unknown, origin: string): void => {
  console.error(`${origin}:`, error);
  process.exit(1);
};

process.on('uncaughtException', (error) => exitWithError(error, 'uncaughtException'));
process.on('unhandledRejection', (reason) => exitWithError(reason, 'unhandledRejection'));

const gracefulShutdown = (): void => {
  server.close(() => {
    console.log('🛑 PizzaHub server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${env.port} is already in use`);
    process.exit(1);
  }

  throw error;
});
