import type { Collection, Db, IndexOptions, IndexSpecification } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { WEBHOOK_EVENTS_COLLECTION } from './webhookEvents.collection.js';

/**
 * All business indexes in one place, each with a comment explaining WHY it
 * exists. Index creation is idempotent — calling `createIndex` with an
 * identical definition is a safe no-op — so this runs on every startup and
 * can be re-run at any time with `npm run db:indexes`.
 */
export interface IndexDefinition {
  collection: string;
  keys: IndexSpecification;
  options: IndexOptions;
  description: string;
  /**
   * Startup-critical indexes. These are created even when their collection
   * does not exist yet and verified before the HTTP server starts, because
   * missing them would weaken Stripe webhook/financial idempotency.
   */
  required?: boolean;
}

export const INDEX_DEFINITIONS: IndexDefinition[] = [
  // ───────────────────────────── menuItems ─────────────────────────────
  {
    collection: COLLECTIONS.menuItems,
    keys: { vendorId: 1, status: 1, category: 1 },
    options: { name: 'idx_vendorId_status_category' },
    description:
      'Vendor menu management and storefront browsing. All three fields are equality filters (ESR rule), so one index serves: vendor menu listings, active-item queries, and per-category browsing — in any combination of prefixes.',
  },
  {
    collection: COLLECTIONS.menuItems,
    keys: { status: 1, category: 1, createdAt: -1 },
    options: { name: 'idx_status_category_createdAt_desc' },
    description:
      'Public storefront listing: only `active` items are returned, optionally filtered by category and sorted newest-first. Status-first placement keeps pending/rejected documents out of the scan.',
  },
  {
    collection: COLLECTIONS.menuItems,
    keys: { name: 'text', description: 'text', tags: 'text' },
    options: {
      name: 'search_text',
      weights: { name: 10, tags: 5, description: 1 },
      defaultLanguage: 'english',
    },
    description:
      'Full-text menu search. MongoDB allows only ONE text index per collection, so every searchable field must be combined into this single index. Weights rank name matches highest, then tags, then description.',
  },

  // ───────────────────────────── orders ─────────────────────────────
  {
    collection: COLLECTIONS.orders,
    keys: { customerId: 1, createdAt: -1 },
    options: { name: 'idx_customerId_createdAt_desc' },
    description:
      'Customer order history, newest first ("my orders"). Orders are archived, never deleted, so createdAt ordering is stable.',
  },
  {
    collection: COLLECTIONS.orders,
    keys: { vendorId: 1, status: 1, createdAt: -1 },
    options: { name: 'idx_vendorId_status_createdAt_desc' },
    description:
      'Vendor dashboard queues (kitchen / delivery / history) filtered by status and sorted newest-first.',
  },
  {
    collection: COLLECTIONS.orders,
    keys: { customerId: 1, vendorId: 1 },
    options: {
      name: 'uniq_customer_vendor_open_cart',
      unique: true,
      // Enforced ONLY while the order is an open cart. Once placed,
      // preparing, delivered or cancelled, the partial filter no longer
      // matches, so customers keep unlimited historical orders per vendor.
      partialFilterExpression: { status: 'cart' },
    },
    description:
      'Business constraint: at most ONE open cart per (customer, vendor) pair. Prevents duplicate active orders from double clicks or parallel tabs without limiting real order history.',
  },

  // ─────────────────────────── transactions ───────────────────────────
  {
    collection: COLLECTIONS.transactions,
    keys: { stripeSessionId: 1 },
    options: { name: 'uniq_stripeSessionId', unique: true },
    required: true,
    description:
      'Idempotency guarantee: one Stripe Checkout session (or, for recurring Premium renewals, one Stripe Invoice) maps to EXACTLY one transaction. Duplicate webhook deliveries or retried writes are rejected by the unique index instead of creating duplicate financial records.',
  },
  {
    collection: COLLECTIONS.transactions,
    keys: { stripeEventId: 1 },
    options: { name: 'uniq_stripeEventId', unique: true, sparse: true },
    required: true,
    description:
      'Second idempotency layer: one Stripe Event can create at most ONE financial record. Sparse, so documents without a Stripe event id are unaffected.',
  },
  {
    collection: COLLECTIONS.transactions,
    keys: { vendorId: 1, createdAt: -1 },
    options: { name: 'idx_vendorId_createdAt_desc' },
    description: 'Vendor earnings, payouts and sales reports, newest first.',
  },
  {
    collection: COLLECTIONS.transactions,
    keys: { orderId: 1 },
    options: { name: 'idx_orderId' },
    description: 'Resolve the full payment lifecycle of an order (its payment plus any refunds).',
  },
  {
    collection: COLLECTIONS.transactions,
    keys: { createdAt: -1, _id: 1 },
    options: { name: 'idx_createdAt_desc' },
    description:
      'Admin transaction listing: supports newest-first pagination, date-range filtering on createdAt, and stable ordering as a tiebreaker.',
  },

  // ─────────────── transactionsEvents (Stripe webhook lifecycle) ───────────────
  {
    collection: WEBHOOK_EVENTS_COLLECTION,
    keys: { stripeEventId: 1 },
    options: { name: 'uniq_stripeEventId', unique: true },
    required: true,
    description:
      'Webhook idempotency: each Stripe Event ID exists at most once, so concurrent or retried deliveries of the same event cannot process it twice. The document is inserted with status "processing" as the claim.',
  },
];

export type IndexStatus = 'ok' | 'skipped' | 'failed';

export interface IndexResult {
  collection: string;
  index: string;
  status: IndexStatus;
  error?: string;
}

export interface EnsureIndexesOptions {
  /**
   * When true (default), optional indexes on collections that do not exist
   * yet are skipped. `createIndex` would implicitly CREATE an empty
   * collection, so this keeps startup from materializing business collections
   * before real data is written. Required integrity indexes are always
   * created, even on a fresh database. Use `npm run db:indexes` to force
   * every defined index to exist.
   */
  skipMissingCollections?: boolean;
}

/** Integrity indexes that must exist before the server accepts requests. */
export const REQUIRED_UNIQUE_INDEXES = INDEX_DEFINITIONS.filter(
  (definition) => definition.required === true && definition.options.unique === true,
);

async function collectionExists(db: Db, name: string): Promise<boolean> {
  return db.listCollections({ name }, { nameOnly: true }).hasNext();
}

async function listExistingIndexes(collection: Collection): Promise<Record<string, unknown>[]> {
  try {
    return (await collection.listIndexes().toArray()) as Record<string, unknown>[];
  } catch (error) {
    // NamespaceNotFound on a fresh database; treat it as "no indexes yet".
    if ((error as { code?: number })?.code === 26) {
      return [];
    }
    throw error;
  }
}

/** Structural comparison used to avoid duplicate/conflicting index creation. */
function matchesIndexDefinition(
  existing: Record<string, unknown>,
  definition: IndexDefinition,
): boolean {
  return (
    JSON.stringify(existing.key ?? {}) === JSON.stringify(definition.keys) &&
    (existing.unique === true) === (definition.options.unique === true) &&
    (existing.sparse === true) === (definition.options.sparse === true) &&
    JSON.stringify(existing.partialFilterExpression ?? null) ===
      JSON.stringify(definition.options.partialFilterExpression ?? null)
  );
}

/**
 * Creates/verifies all defined indexes safely and repeatably.
 *
 * - Never throws: each index failure is reported and the run continues.
 * - Idempotent: an identical existing definition is not created again.
 * - Conflicting same-name definitions are reported as failures; no index is
 *   ever dropped or recreated automatically.
 * - Required integrity indexes are created even when their collection is
 *   missing (MongoDB `createIndex` safely creates the empty collection).
 */
export async function ensureIndexes(
  db: Db,
  options: EnsureIndexesOptions = {},
): Promise<IndexResult[]> {
  const skipMissing = options.skipMissingCollections ?? true;
  const results: IndexResult[] = [];

  const byCollection = new Map<string, IndexDefinition[]>();
  for (const definition of INDEX_DEFINITIONS) {
    const group = byCollection.get(definition.collection) ?? [];
    group.push(definition);
    byCollection.set(definition.collection, group);
  }

  for (const [collectionName, definitions] of byCollection) {
    const exists = await collectionExists(db, collectionName);
    const collection = db.collection(collectionName);
    let existingIndexes: Record<string, unknown>[] = [];

    if (exists) {
      try {
        existingIndexes = await listExistingIndexes(collection);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const definition of definitions) {
          results.push({
            collection: collectionName,
            index: definition.options.name ?? '<unnamed>',
            status: 'failed',
            error: `Could not inspect existing indexes: ${message}`,
          });
        }
        console.error(`⚠️  [${collectionName}] could not inspect indexes: ${message}`);
        continue;
      }
    }

    for (const definition of definitions) {
      const indexName = definition.options.name ?? '<unnamed>';

      if (!exists && skipMissing && !definition.required) {
        results.push({ collection: collectionName, index: indexName, status: 'skipped' });
        console.log(`⏭️  [${collectionName}] ${indexName} skipped — collection not created yet`);
        continue;
      }

      const sameName = existingIndexes.find((index) => index.name === indexName);
      if (sameName) {
        if (matchesIndexDefinition(sameName, definition)) {
          results.push({ collection: collectionName, index: indexName, status: 'ok' });
          continue;
        }
        const message = `Conflicting index definition already exists: ${JSON.stringify(sameName)}`;
        results.push({
          collection: collectionName,
          index: indexName,
          status: 'failed',
          error: message,
        });
        console.error(`⚠️  [${collectionName}] index "${indexName}" failed: ${message}`);
        continue;
      }

      // An equivalent index under a different name is fine for optional
      // indexes. Required names are explicit contracts, so report a missing
      // index instead of silently accepting an alias.
      const equivalent = existingIndexes.find((index) => matchesIndexDefinition(index, definition));
      if (equivalent && !definition.required) {
        results.push({ collection: collectionName, index: indexName, status: 'ok' });
        continue;
      }

      try {
        // Modern (non-deprecated) 3-arg overload: index options and command
        // options are separate; we only use index options here.
        await collection.createIndex(definition.keys, definition.options, undefined);
        existingIndexes.push({
          name: indexName,
          key: definition.keys,
          unique: definition.options.unique === true,
          sparse: definition.options.sparse === true,
          partialFilterExpression: definition.options.partialFilterExpression,
        });
        results.push({ collection: collectionName, index: indexName, status: 'ok' });
        console.log(`✅ [${collectionName}] ${indexName} — ${definition.description}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          collection: collectionName,
          index: indexName,
          status: 'failed',
          error: message,
        });
        console.error(`⚠️  [${collectionName}] index "${indexName}" failed: ${message}`);
      }
    }
  }

  return results;
}

/**
 * Read-only verification of all startup-critical unique indexes. Throws when
 * any required index is absent or has a conflicting definition.
 */
export async function verifyRequiredIndexes(db: Db): Promise<void> {
  for (const definition of REQUIRED_UNIQUE_INDEXES) {
    const collection = db.collection(definition.collection);
    const indexes = await listExistingIndexes(collection);
    const indexName = String(definition.options.name);
    const found = indexes.some(
      (index) => index.name === indexName && matchesIndexDefinition(index, definition),
    );
    if (!found) {
      const actual = JSON.stringify(
        indexes.filter((index) => index.name === indexName || index.unique === true),
      );
      throw new Error(
        `Required unique index ${definition.collection}.${indexName} is missing or invalid. ` +
          `Existing matching indexes: ${actual}`,
      );
    }
  }
}

/**
 * Startup bootstrap: create idempotency indexes before traffic is accepted,
 * then verify them from the database rather than trusting create results.
 */
export async function ensureRequiredIndexes(db: Db): Promise<IndexResult[]> {
  const results = await ensureIndexes(db);
  const requiredFailures = results.filter(
    (result) =>
      result.status === 'failed' &&
      REQUIRED_UNIQUE_INDEXES.some(
        (definition) =>
          definition.collection === result.collection && definition.options.name === result.index,
      ),
  );
  if (requiredFailures.length > 0) {
    throw new Error(
      `Required index setup failed: ${requiredFailures
        .map((result) => `${result.collection}.${result.index}: ${result.error ?? 'unknown error'}`)
        .join('; ')}`,
    );
  }
  await verifyRequiredIndexes(db);
  return results;
}
