import type { Collection } from 'mongodb';
import { getDatabase } from '../config/db.js';
import { COLLECTIONS } from './collections.js';

/**
 * Single source of truth for the webhook-lifecycle collection name
 * (derived from the transactions collection, NOT a competing collection —
 * it stores only Stripe event processing bookkeeping, no financial data).
 */
export const WEBHOOK_EVENTS_COLLECTION = `${COLLECTIONS['transactions']}Events`;

/** Lifecycle of one Stripe event's processing attempt. */
export type WebhookEventStatus = 'processing' | 'processed' | 'failed';

export interface WebhookEventDocument {
  /** Stripe Event ID (evt_…) — unique; the idempotency key for the endpoint. */
  stripeEventId: string;
  /** Stripe event type (e.g. `invoice.paid`). Absent on legacy records. */
  eventType?: string;
  status: WebhookEventStatus;
  receivedAt: Date;
  /** Set when the event reaches `processed` (audit). */
  processedAt?: Date;
  /** Last processing error message when the event is `failed` (diagnostics). */
  lastError?: string;
}

/**
 * Typed accessor for the `webhookEvents` collection used to track Stripe webhook
 * processing lifecycle. The collection stores a minimal document per Stripe event
 * with a unique `stripeEventId` and a `status` field that can be one of
 * "processing", "processed" or "failed". The `receivedAt` timestamp is for audit
 * purposes only.
 */
export function getWebhookEventsCollection(): Collection<WebhookEventDocument> {
  return getDatabase().collection<WebhookEventDocument>(WEBHOOK_EVENTS_COLLECTION);
}
