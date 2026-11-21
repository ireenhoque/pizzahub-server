import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureIndexes,
  ensureRequiredIndexes,
  REQUIRED_UNIQUE_INDEXES,
  verifyRequiredIndexes,
} from '../src/app/db/indexes.js';

interface FakeIndex {
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

type Call = {
  kind: 'createIndex' | 'dropIndex' | 'dropIndexes' | 'deleteMany' | 'drop' | 'dropDatabase';
  collection?: string;
  name?: string;
};

/** In-memory Db double: no MongoDB connection and no env values are read. */
function fakeDb(initial: Record<string, FakeIndex[]> = {}) {
  const indexes = new Map<string, FakeIndex[]>(
    Object.entries(initial).map(([name, list]) => [name, [...list]]),
  );
  const calls: Call[] = [];

  const db = {
    listCollections: vi.fn((filter: { name: string }) => ({
      hasNext: vi.fn(async () => (indexes.get(filter.name)?.length ?? 0) > 0),
    })),
    collection: vi.fn((name: string) => ({
      listIndexes: () => ({
        toArray: async () => indexes.get(name) ?? [],
      }),
      createIndex: vi.fn(async (key: FakeIndex['key'], options: { name: string }) => {
        calls.push({ kind: 'createIndex', collection: name, name: options.name });
        const list = indexes.get(name) ?? [];
        list.push({
          name: options.name,
          key,
          ...(options as FakeIndex),
        });
        indexes.set(name, list);
        return options.name;
      }),
      dropIndex: vi.fn(async () => {
        calls.push({ kind: 'dropIndex', collection: name });
      }),
      dropIndexes: vi.fn(async () => {
        calls.push({ kind: 'dropIndexes', collection: name });
      }),
      deleteMany: vi.fn(async () => {
        calls.push({ kind: 'deleteMany', collection: name });
      }),
      drop: vi.fn(async () => {
        calls.push({ kind: 'drop', collection: name });
      }),
    })),
    dropDatabase: vi.fn(async () => {
      calls.push({ kind: 'dropDatabase' });
    }),
  } as unknown as Db;

  return { db, calls, indexes };
}

describe('database index bootstrap', () => {
  it('creates the required Stripe uniqueness indexes on a fresh database', async () => {
    const { db, calls } = fakeDb();
    const results = await ensureIndexes(db);

    const created = calls.filter((call) => call.kind === 'createIndex');
    expect(created).toHaveLength(REQUIRED_UNIQUE_INDEXES.length);
    for (const definition of REQUIRED_UNIQUE_INDEXES) {
      expect(created).toContainEqual({
        kind: 'createIndex',
        collection: definition.collection,
        name: definition.options.name,
      });
    }

    // Optional indexes on missing collections are still skipped.
    expect(results.some((result) => result.status === 'skipped')).toBe(true);
    expect(results.filter((result) => result.status === 'failed')).toEqual([]);
    await verifyRequiredIndexes(db);

    expect(calls.some((call) => call.kind !== 'createIndex')).toBe(false);
  });

  it('treats an equivalent existing definition as verified without recreating it', async () => {
    const { db, calls } = fakeDb({
      transactions: [
        {
          name: 'uniq_stripeSessionId',
          key: { stripeSessionId: 1 },
          unique: true,
        },
      ],
    });

    const results = await ensureIndexes(db);
    expect(
      results.find(
        (result) => result.collection === 'transactions' && result.index === 'uniq_stripeSessionId',
      )?.status,
    ).toBe('ok');
    expect(
      calls.some(
        (call) =>
          call.kind === 'createIndex' &&
          call.collection === 'transactions' &&
          call.name === 'uniq_stripeSessionId',
      ),
    ).toBe(false);
  });

  it('refuses to start when a required index name has a conflicting definition', async () => {
    const { db, calls } = fakeDb({
      transactions: [
        {
          name: 'uniq_stripeSessionId',
          key: { stripeSessionId: -1 },
          unique: true,
        },
      ],
      transactionsEvents: [
        {
          name: 'uniq_stripeEventId',
          key: { stripeEventId: 1 },
          unique: true,
        },
      ],
    });

    await expect(ensureRequiredIndexes(db)).rejects.toThrow(
      /Required index setup failed.*transactions\.uniq_stripeSessionId/,
    );

    // Conflicts are reported, never "fixed" by dropping/recreating an index.
    expect(calls.some((call) => call.kind !== 'createIndex')).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.kind === 'createIndex' &&
          call.collection === 'transactions' &&
          call.name === 'uniq_stripeSessionId',
      ),
    ).toBe(false);
  });

  it('verifies required indexes from the database instead of trusting create results', async () => {
    const { db } = fakeDb();
    await expect(verifyRequiredIndexes(db)).rejects.toThrow(/Required unique index .* is missing/);
  });
});
