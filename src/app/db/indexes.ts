import type { Db, IndexOptions, IndexSpecification } from 'mongodb';
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
    description:
      'Idempotency guarantee: one Stripe Checkout session (or, for recurring Premium renewals, one Stripe Invoice) maps to EXACTLY one transaction. Duplicate webhook deliveries or retried writes are rejected by the unique index instead of creating duplicate financial records.',
  },
  {
    collection: COLLECTIONS.transactions,
    keys: { stripeEventId: 1 },
    options: { name: 'uniq_stripeEventId', unique: true, sparse: true },
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

  // ─────────────── transactionsEvents (Stripe webhook lifecycle) ───────────────
  {
    collection: WEBHOOK_EVENTS_COLLECTION,
    keys: { stripeEventId: 1 },
    options: { name: 'uniq_stripeEventId', unique: true },
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
   * When true (default), collections that do not exist yet are skipped.
   * `createIndex` would implicitly CREATE an empty collection, so skipping
   * keeps startup from materializing business collections before any real
   * data is written. Use `npm run db:indexes` to force-create everything.
   */
  skipMissingCollections?: boolean;
}

async function collectionExists(db: Db, name: string): Promise<boolean> {
  return db.listCollections({ name }, { nameOnly: true }).hasNext();
}

/**
 * Creates/verifies all defined indexes safely and repeatably.
 *
 * - Never throws: each index failure is reported and the run continues.
 * - Idempotent: identical definitions are no-ops on repeated runs.
 * - Optionally skips missing collections (see EnsureIndexesOptions).
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
    if (skipMissing && !(await collectionExists(db, collectionName))) {
      console.log(`⏭️  [${collectionName}] indexes skipped — collection not created yet`);
      for (const definition of definitions) {
        results.push({
          collection: collectionName,
          index: definition.options.name ?? '<unnamed>',
          status: 'skipped',
        });
      }
      continue;
    }

    const collection = db.collection(collectionName);

    for (const definition of definitions) {
      const indexName = definition.options.name ?? '<unnamed>';
      try {
        // Modern (non-deprecated) 3-arg overload: index options and command
        // options are separate; we only use index options here.
        await collection.createIndex(definition.keys, definition.options, undefined);
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
