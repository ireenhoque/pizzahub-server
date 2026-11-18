import { MongoClient, type Db } from 'mongodb';
import { env } from './env.js';

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;

/**
 * Strips credentials from any error output so they are never printed.
 * Matches "scheme://user:password@" and redacts the user/password part.
 */
function redactCredentials(text: string): string {
  return text.replace(/\/\/[^:/@]+:[^@]+@/g, '//<redacted>@');
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactCredentials(message);
}

/**
 * Returns the shared MongoClient, creating it only once.
 * Reuses the in-flight connect promise if concurrent calls arrive.
 */
export async function connectDatabase(): Promise<Db> {
  if (client) {
    return client.db(env.dbName);
  }

  if (!connectPromise) {
    client = new MongoClient(env.mongoUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10_000,
    });
    connectPromise = client.connect();
  }

  try {
    await connectPromise;
  } catch (error) {
    // Reset so a later call can retry with a fresh client.
    client = null;
    connectPromise = null;
    console.error(`❌ MongoDB connection failed: ${describeError(error)}`);
    throw error;
  }

  if (!client) {
    throw new Error('MongoDB client is unexpectedly unavailable after connecting');
  }

  console.log('✅ MongoDB connected');
  return client.db(env.dbName);
}

/** Returns the connected application database. Throws if not connected yet. */
export function getDatabase(): Db {
  if (!client) {
    throw new Error('Database not connected. Call connectDatabase() first.');
  }
  return client.db(env.dbName);
}

/** Closes the shared client. Safe to call multiple times. */
export async function disconnectDatabase(): Promise<void> {
  if (!client) {
    return;
  }

  const closingClient = client;
  client = null;
  connectPromise = null;

  try {
    await closingClient.close();
    console.log('✅ MongoDB connection closed');
  } catch (error) {
    console.error(`⚠️ Error while closing MongoDB connection: ${describeError(error)}`);
  }
}

export type DatabaseHealth = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

/**
 * Safe, non-invasive health check: pings the database without creating
 * any collection or document. Never throws; never prints credentials.
 */
export async function checkDatabaseHealth(timeoutMs = 3_000): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  const latencyMs = () => Date.now() - startedAt;

  try {
    const db = getDatabase();

    await Promise.race([
      db.command({ ping: 1 }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Database ping timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);

    return { ok: true, latencyMs: latencyMs() };
  } catch (error) {
    return { ok: false, latencyMs: latencyMs(), error: describeError(error) };
  }
}
