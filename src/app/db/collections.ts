import { ObjectId, type ClientSession, type Collection } from 'mongodb';
import { getDatabase } from '../config/db.js';
import type { BetterAuthUser } from '../auth/auth.types.js';
import type { MenuItem } from '../types/menuItem.types.js';
import type { Order } from '../types/order.types.js';
import type { Transaction } from '../types/transaction.types.js';

/**
 * Collection names — single source of truth.
 *
 * `users` is OWNED AND MANAGED BY BETTER AUTH. It is listed here only so
 * nothing accidentally creates a competing user collection; we never write
 * to it, never mirror its data, and never index it ourselves. Better Auth
 * maintains its own indexes on it.
 */
export const COLLECTIONS = {
  menuItems: 'menuItems',
  orders: 'orders',
  transactions: 'transactions',
  users: 'users', // Better Auth managed — read-only for PizzaHub
  /** Serialization primitive for free-plan active-item checks; no business data. */
  menuQuotaLocks: 'menuQuotaLocks',
} as const;

/**
 * Centralized, typed collection accessors.
 *
 * They call `getDatabase()` lazily on every call, so they are safe to use
 * from any module after startup and always resolve against the single
 * shared MongoClient (no driver instances are created here).
 */
export function getMenuItemsCollection(): Collection<MenuItem> {
  return getDatabase().collection<MenuItem>(COLLECTIONS.menuItems);
}

export function getOrdersCollection(): Collection<Order> {
  return getDatabase().collection<Order>(COLLECTIONS.orders);
}

export function getTransactionsCollection(): Collection<Transaction> {
  return getDatabase().collection<Transaction>(COLLECTIONS.transactions);
}

export interface MenuQuotaLockDocument {
  /** Better Auth vendor id; the built-in `_id` index is the only lock needed. */
  _id: string;
  createdAt: Date;
  lastTouchedAt: Date;
}

export function getMenuQuotaLocksCollection(): Collection<MenuQuotaLockDocument> {
  return getDatabase().collection<MenuQuotaLockDocument>(COLLECTIONS.menuQuotaLocks);
}

/**
 * Typed accessor for the Better Auth-managed `users` collection.
 *
 * STRICTLY READ-ONLY: Better Auth owns the schema, data and indexes.
 * PizzaHub reads the current user (role + block status) on protected
 * requests and nothing else.
 */
export function getUsersCollection(): Collection<BetterAuthUser> {
  return getDatabase().collection<BetterAuthUser>(COLLECTIONS.users);
}

/**
 * Finds a Better Auth user by id. Better Auth ids are strings by default,
 * but ObjectId-stored ids are tolerated via a fallback lookup.
 */
export async function findBetterAuthUserById(
  userId: string,
  session?: ClientSession,
): Promise<BetterAuthUser | null> {
  const users = getUsersCollection();

  const asString = await users.findOne({ _id: userId }, { session });
  if (asString) {
    return asString;
  }

  if (/^[0-9a-f]{24}$/i.test(userId)) {
    return users.findOne({ _id: new ObjectId(userId) }, { session });
  }

  return null;
}
