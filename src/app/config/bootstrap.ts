import type { RequestHandler } from 'express';
import type { Db } from 'mongodb';
import { ApiError } from '../error/ApiError.js';
import { ensureRequiredIndexes } from '../db/indexes.js';
import { enforceExpiredPremiumMenuLimits } from '../modules/menuItems/free-plan-limit.js';
import { connectDatabase } from './db.js';

export interface DatabaseBootstrapDependencies {
  connect: () => Promise<Db>;
  ensureIndexes: (db: Db) => Promise<unknown>;
  enforceExpiredPremiumLimits: () => Promise<unknown>;
}

const defaultDependencies: DatabaseBootstrapDependencies = {
  connect: connectDatabase,
  ensureIndexes: ensureRequiredIndexes,
  enforceExpiredPremiumLimits: enforceExpiredPremiumMenuLimits,
};

export interface DatabaseReady {
  /** Resolves once MongoDB, indexes, and Premium expiry reconciliation are ready. */
  ready: () => Promise<void>;
  /** Clears the memoized promise. Intended for tests and explicit reconnects. */
  reset: () => void;
  /** Express middleware that waits for readiness before any route runs. */
  middleware: RequestHandler;
}

/**
 * Creates a per-process, memoized bootstrap.
 *
 * Vercel reuses a function instance across warm invocations, so connect/index
 * work must happen once, not once per request. Concurrent cold requests share
 * the same promise. Failures clear the cache so the next request can retry.
 */
export function createDatabaseReady(
  dependencies: DatabaseBootstrapDependencies = defaultDependencies,
): DatabaseReady {
  let readyPromise: Promise<void> | undefined;

  const ready = (): Promise<void> => {
    if (!readyPromise) {
      readyPromise = (async () => {
        const db = await dependencies.connect();
        await dependencies.ensureIndexes(db);
        await dependencies.enforceExpiredPremiumLimits();
      })().catch(() => {
        // Never propagate raw Mongo/Stripe errors: they can contain credentials.
        readyPromise = undefined;
        throw new ApiError(503, 'Database is not ready');
      });
    }

    return readyPromise;
  };

  const reset = (): void => {
    readyPromise = undefined;
  };

  const middleware: RequestHandler = (_req, _res, next) => {
    ready().then(() => next(), next);
  };

  return { ready, reset, middleware };
}

export const databaseReady = createDatabaseReady();

export const ensureDatabaseReady = databaseReady.ready;
export const resetDatabaseReady = databaseReady.reset;
export const databaseBootstrapMiddleware = databaseReady.middleware;
