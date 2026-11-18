import type { SubscriptionPlan, UserRole } from '../../types/common.types.js';

/**
 * Whitelisted, safe-to-expose user representation. Built explicitly by
 * `toPublicUser` — internal/unknown document fields can never leak.
 */
export interface PublicUser {
  id: string;
  name?: string;
  email?: string;
  emailVerified?: boolean;
  image?: string | null;
  /** Primary role, normalized to the PizzaHub vocabulary. */
  role: UserRole;
  /** All recognized roles (multi-role users supported). */
  roles: UserRole[];
  /** Normalized from `isBlocked` + Better Auth's `banned` flag. */
  isBlocked: boolean;
  /** Vendor subscription tier — read-only, managed by admins only. */
  subscriptionPlan?: SubscriptionPlan;
  subscriptionExpiresAt?: Date | string | null;
  blockedReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ListUsersQuery {
  page: number;
  limit: number;
  search?: string;
  role?: UserRole;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ListUsersResult {
  users: PublicUser[];
  pagination: PaginationMeta;
}

/** Only these fields are self-updatable via PATCH /api/users/me. */
export interface UpdateSelfInput {
  name?: string;
  image?: string | null;
}
