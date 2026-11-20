import { ObjectId, type Filter } from 'mongodb';
import { getTransactionsCollection, getUsersCollection } from '../../db/collections.js';
import type { BetterAuthUser } from '../../auth/auth.types.js';
import { escapeRegex } from '../../utils/regex.js';
import type { Transaction } from '../../types/transaction.types.js';
import type {
  AdminTransaction,
  ListTransactionsQuery,
  ListTransactionsResult,
  TransactionParty,
} from './transaction.types.js';

const TRANSACTION_CONTEXT: Record<'withOrder' | 'withoutOrder', AdminTransaction['context']> = {
  withOrder: 'customer_order',
  withoutOrder: 'vendor_subscription',
};

function toParty(id: string, user: BetterAuthUser | undefined): TransactionParty {
  return {
    id,
    name: typeof user?.name === 'string' && user.name.trim().length > 0 ? user.name : null,
    email: typeof user?.email === 'string' && user.email.trim().length > 0 ? user.email : null,
  };
}

function toAdminTransaction(
  tx: Transaction,
  usersById: Map<string, BetterAuthUser>,
): AdminTransaction {
  const base: AdminTransaction = {
    id: String(tx._id),
    context: tx.orderId ? TRANSACTION_CONTEXT.withOrder : TRANSACTION_CONTEXT.withoutOrder,
    type: tx.type,
    paymentStatus: tx.paymentStatus,
    amount: tx.amount,
    currency: tx.currency,
    customer: toParty(tx.customerId, usersById.get(tx.customerId)),
    vendor: toParty(tx.vendorId, usersById.get(tx.vendorId)),
    stripeSessionId: tx.stripeSessionId,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  };

  if (tx.orderId) base.orderId = String(tx.orderId);
  if (tx.stripePaymentIntentId) base.stripePaymentIntentId = tx.stripePaymentIntentId;
  if (tx.stripeSubscriptionId) base.stripeSubscriptionId = tx.stripeSubscriptionId;
  if (tx.stripeEventId) base.stripeEventId = tx.stripeEventId;
  if (tx.paidAt) base.paidAt = tx.paidAt;
  if (tx.refundedAt) base.refundedAt = tx.refundedAt;
  if (tx.failureReason) base.failureReason = tx.failureReason;

  return base;
}

function buildDateFilter(from?: Date, to?: Date): { $gte?: Date; $lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const filter: { $gte?: Date; $lte?: Date } = {};
  if (from) filter.$gte = from;
  if (to) filter.$lte = to;
  return filter;
}

function buildSearchConditions(search: string): Filter<Transaction>[] {
  const pattern = escapeRegex(search);
  const conditions: Filter<Transaction>[] = [
    { stripeSessionId: { $regex: pattern, $options: 'i' } },
    { stripePaymentIntentId: { $regex: pattern, $options: 'i' } },
    { stripeSubscriptionId: { $regex: pattern, $options: 'i' } },
    { stripeEventId: { $regex: pattern, $options: 'i' } },
    { customerId: { $regex: pattern, $options: 'i' } },
    { vendorId: { $regex: pattern, $options: 'i' } },
  ];

  if (ObjectId.isValid(search)) {
    conditions.push({ _id: new ObjectId(search) });
    conditions.push({ orderId: new ObjectId(search) });
  }

  return conditions;
}

async function findMatchingUserIds(search: string): Promise<string[]> {
  const pattern = escapeRegex(search);
  const users = await getUsersCollection()
    .find(
      {
        $or: [
          { name: { $regex: pattern, $options: 'i' } },
          { email: { $regex: pattern, $options: 'i' } },
        ],
      },
      { projection: { _id: 1 } },
    )
    .limit(200)
    .toArray();

  return users.map((user) => String(user._id));
}

async function loadUsersByIds(ids: string[]): Promise<Map<string, BetterAuthUser>> {
  const unique = Array.from(new Set(ids.filter((id) => id.length > 0)));
  if (unique.length === 0) {
    return new Map();
  }

  const stringIds = unique;
  const objectIds = unique.filter((id) => /^[0-9a-f]{24}$/i.test(id)).map((id) => new ObjectId(id));

  const orFilter =
    objectIds.length > 0
      ? [{ _id: { $in: stringIds } }, { _id: { $in: objectIds } }]
      : [{ _id: { $in: stringIds } }];

  const users = await getUsersCollection()
    .find({ $or: orFilter } as Filter<BetterAuthUser>)
    .toArray();

  return new Map(users.map((user) => [String(user._id), user]));
}

export const transactionService = {
  async listTransactions(query: ListTransactionsQuery): Promise<ListTransactionsResult> {
    const filter: Filter<Transaction> = {};

    if (query.status) {
      filter.paymentStatus = query.status;
    }
    if (query.type) {
      filter.type = query.type;
    }

    const createdAt = buildDateFilter(query.from, query.to);
    if (createdAt) {
      filter.createdAt = createdAt;
    }

    if (query.search) {
      const userIds = await findMatchingUserIds(query.search);
      const orConditions = buildSearchConditions(query.search);
      if (userIds.length > 0) {
        orConditions.push({ customerId: { $in: userIds } });
        orConditions.push({ vendorId: { $in: userIds } });
      }
      filter.$or = orConditions;
    }

    const sort: Record<string, 1 | -1> = {
      [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1,
    };
    if (query.sortBy !== 'createdAt') {
      sort.createdAt = -1;
    }
    sort._id = 1;

    const collection = getTransactionsCollection();
    const total = await collection.countDocuments(filter);
    const docs = await collection
      .find(filter)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .toArray();

    const relatedUserIds = docs.flatMap((tx) => [tx.customerId, tx.vendorId]);
    const usersById = await loadUsersByIds(relatedUserIds);

    return {
      transactions: docs.map((tx) => toAdminTransaction(tx, usersById)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  },
};
