import type { ObjectId } from 'mongodb';
import type { UserRole } from '../types/common.types.js';

/**
 * Shape of the documents in the Better Auth-managed `users` collection.
 *
 * READ ONLY: Better Auth owns this schema and its data. PizzaHub never
 * creates, updates, deletes or mirrors these documents — it only reads the
 * fields below on every protected request (fresh role + block status).
 */
export interface BetterAuthUser {
  /** Better Auth `_id` (string ids by default; ObjectId storage tolerated). */
  _id: string | ObjectId;
  name?: string;
  email?: string;
  emailVerified?: boolean;
  /** Better Auth admin plugin role(s). Only values from USER_ROLES are recognized. */
  role?: string | string[];
  /** Better Auth admin plugin ban flag (optionally temporary via banExpires). */
  banned?: boolean;
  banReason?: string;
  banExpires?: number | Date;
  /** PizzaHub block flag (per product requirements). */
  isBlocked?: boolean;

  /* ── Additional fields (Better Auth `additionalFields`) + bookkeeping ── */
  image?: string | null;
  /**
   * Vendor subscription tier. Written ONLY by trusted server-side code paths
   * (admin endpoints and the verified Stripe webhook) — never accepted from
   * any client request.
   */
  subscriptionPlan?: string;
  subscriptionExpiresAt?: Date | string | null;
  /** Stripe customer id (cus_…) saved server-side by the Premium checkout flow. */
  stripeCustomerId?: string;
  /** Stripe subscription id (sub_…) for Premium — written by verified webhooks only. */
  stripeSubscriptionId?: string;
  /**
   * The Premium Checkout session the vendor currently has open. Reusing it
   * prevents duplicate sessions (and therefore duplicate subscriptions).
   */
  stripePendingCheckout?: { sessionId: string; url: string; createdAt: Date };
  blockedReason?: string | null;
  blockedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Information derived from a JWT that passed signature/issuer/audience/
 * expiration verification. Identity claims come ONLY from the verified
 * token — never from the request body, query string or custom headers.
 */
export interface VerifiedJwtContext {
  /** Verified JWT `sub` claim — the Better Auth user `_id`. */
  userId: string;
  email?: string;
  emailVerified?: boolean;
  issuer: string;
  audience: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Full, DB-backed authentication context attached to `req.auth` by the
 * `requireAuth` middleware. `role`/`roles` are resolved from the Better
 * Auth users collection in MongoDB on EVERY protected request — they are
 * never taken from the token, request body or client headers.
 */
export interface AuthenticatedUser extends VerifiedJwtContext {
  /** Primary (first) role resolved from MongoDB. */
  role: UserRole;
  /** All recognized roles resolved from MongoDB. */
  roles: UserRole[];
}
