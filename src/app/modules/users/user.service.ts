import type { Filter } from 'mongodb';
import { findBetterAuthUserById, getUsersCollection } from '../../db/collections.js';
import { ApiError } from '../../error/ApiError.js';
import type { BetterAuthUser } from '../../auth/auth.types.js';
import { isUserBlocked, normalizeRoles } from '../../auth/require-auth.js';
import { SUBSCRIPTION_PLANS, type SubscriptionPlan } from '../../types/common.types.js';
import { escapeRegex } from '../../utils/regex.js';
import type { ListUsersQuery, ListUsersResult, PublicUser, UpdateSelfInput } from './user.types.js';

/**
 * Whether the vendor currently holds premium privileges. The subscription
 * must be the `premium` plan AND unexpired — an expired premium
 * subscription falls back to free-tier limits. The check runs against the
 * fresh MongoDB user document on every menu creation.
 */
export function hasActivePremiumSubscription(user: BetterAuthUser): boolean {
  if (user.subscriptionPlan !== 'premium') {
    return false;
  }

  // A premium subscription must carry a real, future expiration date.
  if (user.subscriptionExpiresAt === undefined || user.subscriptionExpiresAt === null) {
    return false;
  }

  const expiry =
    typeof user.subscriptionExpiresAt === 'string'
      ? Date.parse(user.subscriptionExpiresAt)
      : user.subscriptionExpiresAt.getTime();

  return !Number.isNaN(expiry) && expiry > Date.now();
}

/**
 * User & profile business logic.
 *
 * IMPORTANT: this service reads and writes ONLY the Better Auth-managed
 * `users` collection (profile fields, block flags). Registration is owned by
 * Better Auth — no API here ever creates users, and no endpoint accepts a
 * role, isBlocked, subscriptionPlan or subscriptionExpiresAt value from the
 * client. Privileged changes go exclusively through the admin endpoints.
 */

/** Whitelist serializer — the ONLY way user documents leave the service. */
export function toPublicUser(user: BetterAuthUser): PublicUser {
  const roles = normalizeRoles(user);

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image ?? null,
    role: roles[0]!,
    roles,
    isBlocked: isUserBlocked(user),
    subscriptionPlan: SUBSCRIPTION_PLANS.includes(user.subscriptionPlan as SubscriptionPlan)
      ? (user.subscriptionPlan as SubscriptionPlan)
      : undefined,
    subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
    blockedReason: user.blockedReason ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export const userService = {
  /** Current user's own profile. */
  async getUserById(userId: string): Promise<PublicUser | null> {
    const user = await findBetterAuthUserById(userId);
    return user ? toPublicUser(user) : null;
  },

  /**
   * Self-service profile update. `updates` only ever contains whitelisted
   * fields (name/image) — the Zod schema is strict and this method builds
   * the Mongo update explicitly, so protected fields are unreachable.
   */
  async updateCurrentUser(userId: string, updates: UpdateSelfInput): Promise<PublicUser | null> {
    const existing = await findBetterAuthUserById(userId);
    if (!existing) {
      throw new ApiError(404, 'User not found');
    }

    const set: Record<string, unknown> = { updatedAt: new Date() };
    const unset: Record<string, ''> = {};

    if (updates.name !== undefined) {
      set.name = updates.name;
    }
    if (updates.image !== undefined) {
      if (updates.image === null) {
        unset.image = '';
      } else {
        set.image = updates.image;
      }
    }

    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(unset).length > 0) {
      update.$unset = unset;
    }

    await getUsersCollection().updateOne({ _id: existing._id }, update);

    const updated = await findBetterAuthUserById(userId);
    return updated ? toPublicUser(updated) : null;
  },

  /** Admin listing with search (name/email), role filter and pagination. */
  async listUsers(query: ListUsersQuery): Promise<ListUsersResult> {
    const users = getUsersCollection();

    const filter: Filter<BetterAuthUser> = {};
    if (query.role) {
      // Matches string roles and array roles containing the value.
      filter.role = query.role;
    }
    if (query.search) {
      // Escape user input — a raw $regex would allow regex injection.
      const pattern = escapeRegex(query.search);
      filter.$or = [
        { name: { $regex: pattern, $options: 'i' } },
        { email: { $regex: pattern, $options: 'i' } },
      ];
    }

    const total = await users.countDocuments(filter);
    const docs = await users
      .find(filter)
      .sort({ createdAt: -1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .toArray();

    return {
      users: docs.map(toPublicUser),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },

  /**
   * Admin block. Guarded: admins cannot block themselves and cannot block
   * other admin accounts (prevents lockouts by a compromised admin).
   */
  async blockUser(
    targetUserId: string,
    adminUserId: string,
    reason?: string,
  ): Promise<PublicUser | null> {
    if (targetUserId === adminUserId) {
      throw new ApiError(400, 'You cannot block your own account');
    }

    const target = await findBetterAuthUserById(targetUserId);
    if (!target) {
      throw new ApiError(404, 'User not found');
    }
    if (normalizeRoles(target).includes('admin')) {
      throw new ApiError(403, 'Admin accounts cannot be blocked');
    }

    const set: Record<string, unknown> = {
      isBlocked: true,
      blockedAt: new Date(),
      updatedAt: new Date(),
    };
    if (reason) {
      set.blockedReason = reason;
    }

    await getUsersCollection().updateOne({ _id: target._id }, { $set: set });

    const updated = await findBetterAuthUserById(targetUserId);
    return updated ? toPublicUser(updated) : null;
  },

  /** Admin unblock — clears both PizzaHub and Better Auth ban flags. */
  async unblockUser(targetUserId: string, adminUserId: string): Promise<PublicUser | null> {
    if (targetUserId === adminUserId) {
      throw new ApiError(400, 'You cannot unblock your own account');
    }

    const target = await findBetterAuthUserById(targetUserId);
    if (!target) {
      throw new ApiError(404, 'User not found');
    }

    await getUsersCollection().updateOne(
      { _id: target._id },
      {
        $set: { isBlocked: false, banned: false, updatedAt: new Date() },
        $unset: { blockedReason: '', blockedAt: '' },
      },
    );

    const updated = await findBetterAuthUserById(targetUserId);
    return updated ? toPublicUser(updated) : null;
  },
};
