import type { ClientSession } from 'mongodb';
import { getDatabase } from '../config/db.js';

/**
 * Runs multi-document writes atomically with snapshot reads and majority
 * writes. Used by both Stripe webhook processing and free-plan quota updates.
 */
export async function runInTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await getDatabase().client.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}
