import { connectDatabase, disconnectDatabase } from '../app/config/db.js';
import { ensureIndexes } from '../app/db/indexes.js';

/**
 * Deliberate index initialization for the PizzaHub database.
 *
 * Unlike the startup path (which skips missing collections so no empty
 * business collection is ever created implicitly), this script creates
 * every defined index — including on collections that do not exist yet.
 *
 * Run manually: `npm run db:indexes`
 * Repeatable: identical index definitions are no-ops on re-runs.
 */
const db = await connectDatabase();

const results = await ensureIndexes(db, { skipMissingCollections: false });

const failed = results.filter((result) => result.status === 'failed');
console.log(
  `📊 Index initialization finished: ${results.length - failed.length} ok, ` +
    `${results.filter((result) => result.status === 'skipped').length} skipped, ` +
    `${failed.length} failed`,
);

await disconnectDatabase();

process.exit(failed.length > 0 ? 1 : 0);
