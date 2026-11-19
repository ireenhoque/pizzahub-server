import { connectDatabase } from '../app/config/db.js';
import { randomUUID } from 'crypto';

async function main() {
  const db = await connectDatabase();
  const hello = await db.admin().command({ hello: 1 });
  console.log('--- hello ---');
  console.log('maxWireVersion:', hello.maxWireVersion);
  console.log('setName:', hello.setName ?? 'null');
  console.log('msg:', hello.msg ?? 'null');
  console.log('logicalSessionTimeoutMinutes:', hello.logicalSessionTimeoutMinutes ?? 'null');

  const collName = `temp_tx_probe_${randomUUID().replace(/-/g, '')}`;
  const collection = db.collection(collName);

  const session = db.client.startSession();
  try {
    await session.withTransaction(
      async () => {
        await collection.insertOne({ test: true }, { session });
        await collection.deleteOne({ test: true }, { session });
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    console.log('Transaction test: SUCCESS');
  } catch (e) {
    console.error('Transaction test: FAILURE', e);
  } finally {
    await session.endSession();
    // Cleanup collection (in case it still exists)
    try {
      await collection.drop();
    } catch {
      // Best-effort cleanup — the probe collection may already be gone.
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error', err);
  process.exit(1);
});
