import type { ObjectId } from 'mongodb';
import type { BaseDocument, PaymentStatus, UserReference } from './common.types.js';

/**
 * `payment` records a completed charge; `refund` records money returned
 * against a previous payment. Each transaction is anchored to exactly one
 * Stripe object: a Checkout session for the first subscription charge, or
 * (for recurring Premium renewals, which never pass through Checkout) the
 * Stripe Invoice id in the same unique slot.
 *
 * Subscription payments never set `orderId` — customer orders and vendor
 * Premium billing are deliberately kept apart. For a subscription payment
 * the vendor is the payer, so `customerId === vendorId`.
 */
export const TRANSACTION_TYPES = ['payment', 'refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export interface Transaction extends BaseDocument {
  // Optional reference to an order, if the transaction is linked to a purchase.
  orderId?: ObjectId;

  /** Better Auth `_id` references — user data is NOT duplicated here. */
  customerId: UserReference;
  vendorId: UserReference;

  /** Stripe event identifier for idempotent processing. */
  stripeEventId?: string;

  type: TransactionType;
  paymentStatus: PaymentStatus;

  amount: number;
  currency: string;

  /**
   * Unique Stripe anchor — Checkout session id for the first charge,
   * Stripe Invoice id for recurring subscription renewals. Unique across
   * the collection (idempotency).
   */
  stripeSessionId: string;
  stripePaymentIntentId?: string;
  /** Stripe subscription this payment belongs to (vendor Premium payments). */
  stripeSubscriptionId?: string;

  paidAt?: Date;
  refundedAt?: Date;
  failureReason?: string;
}
