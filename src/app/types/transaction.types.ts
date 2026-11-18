import type { ObjectId } from 'mongodb';
import type { BaseDocument, PaymentStatus, UserReference } from './common.types.js';

/**
 * `payment` records a completed checkout; `refund` records money returned
 * against a previous payment. Each transaction is anchored to exactly one
 * Stripe Checkout session.
 */
export const TRANSACTION_TYPES = ['payment', 'refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export interface Transaction extends BaseDocument {
  orderId: ObjectId;

  /** Better Auth `_id` references — user data is NOT duplicated here. */
  customerId: UserReference;
  vendorId: UserReference;

  type: TransactionType;
  paymentStatus: PaymentStatus;

  amount: number;
  currency: string;

  /** Stripe Checkout session id — unique across the collection (idempotency). */
  stripeSessionId: string;
  stripePaymentIntentId?: string;

  paidAt?: Date;
  refundedAt?: Date;
  failureReason?: string;
}
