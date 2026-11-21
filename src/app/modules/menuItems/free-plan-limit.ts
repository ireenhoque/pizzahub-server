import type { ClientSession } from 'mongodb';
import type { BetterAuthUser } from '../../auth/auth.types.js';
import {
  findBetterAuthUserById,
  getMenuItemsCollection,
  getMenuQuotaLocksCollection,
  getUsersCollection,
} from '../../db/collections.js';
import { runInTransaction } from '../../db/transactions.js';
import { ApiError } from '../../error/ApiError.js';
import { hasActivePremiumSubscription } from '../users/user.service.js';

/** Free-plan vendors may keep at most this many `active` menu items. */
export const FREE_PLAN_MAX_ACTIVE_MENU_ITEMS = 3;

export interface FreePlanLimitResult {
  vendorId: string;
  activeCountBefore: number;
  activeCountAfter: number;
  pausedItemIds: string[];
  skipped: boolean;
}

export function freePlanLimitMessage(): string {
  return (
    `Your current plan allows at most ${FREE_PLAN_MAX_ACTIVE_MENU_ITEMS} active menu items. ` +
    'Upgrade to a premium subscription for unlimited items.'
  );
}

/**
 * Marks the per-vendor lock inside an existing transaction. Concurrent
 * quota-sensitive operations for the same vendor write the same document, so
 * MongoDB aborts one transaction and `withTransaction` retries it after the
 * winner commits. This is a transaction conflict, not a held flag: there is
 * no timeout and no lock document to clean up on failure.
 */
export async function touchMenuQuotaLock(vendorId: string, session: ClientSession): Promise<void> {
  const now = new Date();
  await getMenuQuotaLocksCollection().updateOne(
    { _id: vendorId },
    { $setOnInsert: { createdAt: now }, $set: { lastTouchedAt: now } },
    { upsert: true, session },
  );
}

/** Serializes quota-sensitive operations for one vendor in their own transaction. */
export async function withMenuQuotaLock<T>(
  vendorId: string,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return runInTransaction(async (session) => {
    await touchMenuQuotaLock(vendorId, session);
    return work(session);
  });
}

/**
 * Authoritative free-plan check. Must be called inside the vendor quota lock
 * immediately before the operation that increases the active-item count.
 */
export async function assertCanAddActiveMenuItem(
  vendorId: string,
  session: ClientSession,
): Promise<void> {
  const vendor = await findBetterAuthUserById(vendorId, session);
  if (!vendor) {
    throw new ApiError(404, 'Vendor account not found');
  }
  if (hasActivePremiumSubscription(vendor)) {
    return;
  }

  const activeCount = await getMenuItemsCollection().countDocuments(
    { vendorId, status: 'active' },
    { session },
  );
  if (activeCount >= FREE_PLAN_MAX_ACTIVE_MENU_ITEMS) {
    throw new ApiError(403, freePlanLimitMessage());
  }
}

/**
 * Reconciles a vendor that is no longer entitled to premium privileges.
 *
 * Documents are PRESERVED — nothing is deleted. The oldest three active
 * items stay live; only excess newest active items move to the existing
 * non-public `inactive` state with `isAvailable: false`. The change is
 * reversible by an admin status change if premium is restored.
 *
 * This must be called inside the caller's transaction (after downgrading the
 * user document) so the plan change and item reconciliation commit together.
 */
export async function enforceFreePlanActiveLimitInSession(
  vendorId: string,
  session: ClientSession,
): Promise<FreePlanLimitResult> {
  await touchMenuQuotaLock(vendorId, session);

  const vendor = await findBetterAuthUserById(vendorId, session);
  if (!vendor) {
    return {
      vendorId,
      activeCountBefore: 0,
      activeCountAfter: 0,
      pausedItemIds: [],
      skipped: true,
    };
  }
  if (hasActivePremiumSubscription(vendor)) {
    const activeCount = await getMenuItemsCollection().countDocuments(
      { vendorId, status: 'active' },
      { session },
    );
    return {
      vendorId,
      activeCountBefore: activeCount,
      activeCountAfter: activeCount,
      pausedItemIds: [],
      skipped: true,
    };
  }

  const menuItems = getMenuItemsCollection();
  const activeItems = await menuItems
    .find({ vendorId, status: 'active' }, { session, sort: { createdAt: 1, _id: 1 } })
    .toArray();
  const excess = activeItems.slice(FREE_PLAN_MAX_ACTIVE_MENU_ITEMS);
  const pausedItemIds = excess.map((item) => String(item._id));

  if (pausedItemIds.length > 0) {
    await menuItems.updateMany(
      { _id: { $in: excess.map((item) => item._id) }, status: 'active' },
      { $set: { status: 'inactive', isAvailable: false, updatedAt: new Date() } },
      { session },
    );
  }

  return {
    vendorId,
    activeCountBefore: activeItems.length,
    activeCountAfter: activeItems.length - pausedItemIds.length,
    pausedItemIds,
    skipped: false,
  };
}

/** Standalone reconciliation for callers that do not already own a session. */
export async function enforceFreePlanActiveLimit(vendorId: string): Promise<FreePlanLimitResult> {
  return runInTransaction((session) => enforceFreePlanActiveLimitInSession(vendorId, session));
}

/**
 * Lazy reconciliation for time-based expiry: no scheduler is required, so
 * startup and a periodic sweep pause excess active items for vendors whose
 * stored premium plan has already expired.
 */
export async function enforceExpiredPremiumMenuLimits(): Promise<{
  checked: number;
  reconciled: number;
}> {
  const users = getUsersCollection();
  const premiumUsers = await users
    .find(
      { subscriptionPlan: 'premium' },
      { projection: { _id: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 } },
    )
    .toArray();

  let reconciled = 0;
  for (const user of premiumUsers as BetterAuthUser[]) {
    if (hasActivePremiumSubscription(user)) {
      continue;
    }
    const result = await enforceFreePlanActiveLimit(String(user._id));
    if (result.pausedItemIds.length > 0) {
      reconciled += 1;
    }
  }
  return { checked: premiumUsers.length, reconciled };
}
