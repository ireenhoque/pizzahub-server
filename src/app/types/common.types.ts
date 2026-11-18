import type { ObjectId } from 'mongodb';

/**
 * Shared vocabulary and base document shape for PizzaHub data models.
 */

/**
 * Application roles.
 *
 * IMPORTANT: user documents live ONLY in Better Auth's `users` collection.
 * We never create, mirror, or duplicate user data — this vocabulary is used
 * purely for authorization logic (guards, role checks) and for referencing
 * users by id from our own collections.
 */
export const USER_ROLES = ['customer', 'vendor', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Vendor subscription plans (monetization tiers).
 * Like roles, this is vocabulary only — plan assignment is stored where the
 * vendor profile lives, never as a copy of Better Auth user fields.
 */
export const SUBSCRIPTION_PLANS = ['free', 'basic', 'pro', 'premium'] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'canceled', 'past_due'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Shared payment lifecycle vocabulary (used by transactions). */
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Common fields for every PizzaHub document. */
export interface BaseDocument {
  _id: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Reference to a Better Auth user.
 *
 * Better Auth generates its own `_id` values (strings), so all references to
 * users are typed as `string` to match. The referenced document is NEVER
 * copied into our collections.
 */
export type UserReference = string;
