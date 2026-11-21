import { ObjectId, type ClientSession } from 'mongodb';
import type Stripe from 'stripe';
import {
  findBetterAuthUserById,
  getTransactionsCollection,
  getUsersCollection,
} from '../../db/collections.js';
import { getWebhookEventsCollection } from '../../db/webhookEvents.collection.js';
import { runInTransaction } from '../../db/transactions.js';
import { enforceFreePlanActiveLimitInSession } from '../menuItems/free-plan-limit.js';
import { normalizeRoles } from '../../auth/require-auth.js';
import { ApiError } from '../../error/ApiError.js';
import type { BetterAuthUser } from '../../auth/auth.types.js';
import type { Transaction } from '../../types/transaction.types.js';
import { hasActivePremiumSubscription } from '../users/user.service.js';
import {
  VENDOR_PREMIUM_METADATA_KIND,
  stripeResourceId,
  type StripeBillingGateway,
} from './stripe.client.js';

/**
 * Stripe webhook processing for vendor Premium subscriptions.
 *
 * Reliability model:
 *  - the endpoint receives the RAW body (registered before express.json()
 *    in app.ts) and rejects bad signatures before touching the database;
 *  - each Stripe Event ID is claimed once in the `webhookEvents` collection
 *    (unique index) → duplicate/retried deliveries return 200 without
 *    reprocessing, failed attempts are re-claimed on Stripe's next retry;
 *  - handlers that write two documents (user + transaction) run inside a
 *    MongoDB transaction with NO non-transactional fallback: a failure
 *    aborts the whole unit of work, marks the event `failed`, and the
 *    endpoint answers 5xx so Stripe redelivers;
 *  - external Stripe calls (subscription lookup for verified activation)
 *    happen BEFORE the transaction, never inside it;
 *  - `invoice.payment_failed` never downgrades an actively-premium vendor:
 *    it extends `subscriptionExpiresAt` to at least now + 7 days, and
 *    `hasActivePremiumSubscription` enforces the deadline without a scheduler.
 */

/** Seven-day grace period for eligible (still-active Premium) payment failures. */
export const SUBSCRIPTION_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a `processing` claim may exist before another delivery of the
 * same event may assume the original attempt crashed and reclaim it.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;

export interface WebhookOutcome {
  /** True when this event id was already claimed/processed — nothing re-ran. */
  duplicate: boolean;
  /** True when a handler actually processed the event (false = irrelevant). */
  handled: boolean;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function expiryMilliseconds(value: Date | string | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const milliseconds = typeof value === 'string' ? Date.parse(value) : value.getTime();
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

/** Stripe event times are epoch seconds; fall back to processing time if absent. */
function eventCreatedSeconds(event: Stripe.Event): number {
  return typeof event.created === 'number' && Number.isFinite(event.created)
    ? Math.floor(event.created)
    : Math.floor(Date.now() / 1000);
}

function isTerminalSubscriptionStatus(status: string): boolean {
  return status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired';
}

function lifecycleFor(
  subscriptionId: string,
  status: string,
  event: Stripe.Event,
  periodEndSeconds?: number,
): NonNullable<BetterAuthUser['subscriptionLifecycle']> {
  return {
    stripeSubscriptionId: subscriptionId,
    status,
    eventCreated: eventCreatedSeconds(event),
    ...(periodEndSeconds !== undefined ? { periodEnd: periodEndSeconds } : {}),
    sourceEventId: event.id,
  };
}

/**
 * Guards payment/activation events against older deliveries. A terminal
 * watermark wins ties, and a period end that does not advance the stored one
 * cannot reactivate or extend a canceled subscription.
 */
function isStalePaymentEvent(
  vendor: BetterAuthUser,
  event: Stripe.Event,
  subscriptionId?: string | null,
  periodEndSeconds?: number,
): boolean {
  const lifecycle = vendor.subscriptionLifecycle;
  const created = eventCreatedSeconds(event);
  if (!lifecycle) {
    // Legacy users have no watermark. Still reject an event belonging to a
    // different stored subscription unless it genuinely starts a later
    // period; otherwise an old invoice could attach itself to a new plan.
    if (
      !subscriptionId ||
      !vendor.stripeSubscriptionId ||
      subscriptionId === vendor.stripeSubscriptionId
    ) {
      return false;
    }
    if (periodEndSeconds === undefined) {
      return true;
    }
    const storedExpiry = expiryMilliseconds(vendor.subscriptionExpiresAt);
    return storedExpiry === null || periodEndSeconds <= Math.floor(storedExpiry / 1000);
  }

  if (created < lifecycle.eventCreated) {
    return true;
  }

  const differentSubscription =
    !!subscriptionId &&
    !!lifecycle.stripeSubscriptionId &&
    subscriptionId !== lifecycle.stripeSubscriptionId;

  if (differentSubscription) {
    if (isTerminalSubscriptionStatus(lifecycle.status)) {
      const periodIsOld =
        periodEndSeconds !== undefined &&
        lifecycle.periodEnd !== undefined &&
        periodEndSeconds <= lifecycle.periodEnd;
      return created <= lifecycle.eventCreated || periodIsOld;
    }
    // A non-terminal watermark means this vendor is already attached to a
    // different live subscription. Only accept a genuinely newer period.
    return (
      periodEndSeconds === undefined ||
      lifecycle.periodEnd === undefined ||
      periodEndSeconds <= lifecycle.periodEnd
    );
  }

  if (isTerminalSubscriptionStatus(lifecycle.status)) {
    if (created <= lifecycle.eventCreated) {
      return true;
    }
    return (
      periodEndSeconds !== undefined &&
      lifecycle.periodEnd !== undefined &&
      periodEndSeconds <= lifecycle.periodEnd
    );
  }

  return false;
}

/** Guards canceled/deleted events so an old subscription cannot downgrade a new one. */
function isStaleTerminalEvent(
  vendor: BetterAuthUser,
  event: Stripe.Event,
  subscriptionId?: string | null,
): boolean {
  const lifecycle = vendor.subscriptionLifecycle;
  if (!lifecycle) {
    // Same legacy protection as payment events: an old subscription must
    // never cancel a newer one just because the user predates watermarks.
    return (
      !!subscriptionId &&
      !!vendor.stripeSubscriptionId &&
      subscriptionId !== vendor.stripeSubscriptionId
    );
  }
  if (
    subscriptionId &&
    lifecycle.stripeSubscriptionId &&
    subscriptionId !== lifecycle.stripeSubscriptionId
  ) {
    return true;
  }
  return eventCreatedSeconds(event) < lifecycle.eventCreated;
}

function invoiceFailureReason(invoice: Stripe.Invoice): string | undefined {
  const withFailure = invoice as Stripe.Invoice & {
    payment_failure_message?: string;
    last_payment_error?: { message?: string } | null;
  };
  return (
    withFailure.last_payment_error?.message ??
    withFailure.payment_failure_message ??
    'Stripe invoice payment failed'
  );
}

/**
 * Re-reads the vendor INSIDE the transaction snapshot. Without the session,
 * a concurrent webhook could read old state, then both writes would commit
 * and the later (possibly stale) event would win.
 */
async function freshVendorForWrite(
  vendor: BetterAuthUser,
  session: ClientSession,
): Promise<BetterAuthUser> {
  return (await findBetterAuthUserById(String(vendor._id), session)) ?? vendor;
}

export function createWebhookService(gateway: StripeBillingGateway) {
  /**
   * Claims processing rights for one Stripe Event ID.
   * Returns false when the event is already processed or currently being
   * processed by a live concurrent delivery (→ acknowledge with 200).
   * FAILED claims are re-claimed for Stripe's retry, and a claim left
   * `processing` by a crashed process becomes reclaimable after
   * STALE_CLAIM_MS so an event can never get permanently stuck.
   */
  async function claimEvent(
    stripeEventId: string,
    eventType: string,
    eventCreated: number,
  ): Promise<boolean> {
    const events = getWebhookEventsCollection();
    try {
      const result = await events.updateOne(
        { stripeEventId },
        {
          $setOnInsert: {
            stripeEventId,
            eventType,
            eventCreated,
            status: 'processing',
            receivedAt: new Date(),
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount === 1) {
        return true; // we inserted the claim
      }
      if (result.matchedCount === 1) {
        return reclaimEvent(stripeEventId, eventType, eventCreated);
      }
      return false;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      // A concurrent delivery inserted the same event id first.
      return reclaimEvent(stripeEventId, eventType, eventCreated);
    }
  }

  async function reclaimEvent(
    stripeEventId: string,
    eventType: string,
    eventCreated: number,
  ): Promise<boolean> {
    const events = getWebhookEventsCollection();
    const existing = await events.findOne({ stripeEventId });
    if (!existing || existing.status === 'processed') {
      return false;
    }
    if (existing.status === 'failed') {
      // Stripe is retrying an event whose previous attempt failed.
      const reclaimed = await events.updateOne(
        { stripeEventId, status: 'failed' },
        { $set: { status: 'processing', eventType, eventCreated } },
      );
      return reclaimed.modifiedCount === 1;
    }
    // status === 'processing': another delivery may be live. Only reclaim
    // when the claim is stale (crashed process), using a compare-and-swap
    // on the original receivedAt so exactly one retry wins.
    const receivedAtMs =
      existing.receivedAt instanceof Date
        ? existing.receivedAt.getTime()
        : Date.parse(String(existing.receivedAt ?? ''));
    if (Number.isFinite(receivedAtMs) && receivedAtMs + STALE_CLAIM_MS < Date.now()) {
      const reclaimed = await events.updateOne(
        { stripeEventId, status: 'processing', receivedAt: existing.receivedAt },
        { $set: { status: 'processing', receivedAt: new Date(), eventType, eventCreated } },
      );
      return reclaimed.modifiedCount === 1;
    }
    return false;
  }

  /**
   * Finds the vendor behind a subscription invoice. The Stripe customer id
   * is stored at CHECKOUT CREATION time and the subscription id by verified
   * webhooks, so either lookup works regardless of Stripe's event ordering.
   * A genuinely unknown invoice throws (→ event marked failed → Stripe
   * retries), never a silent skip of a real payment.
   */
  async function resolveVendorForInvoice(invoice: Stripe.Invoice): Promise<BetterAuthUser> {
    const subscriptionId = stripeResourceId(invoice.subscription);
    const customerId = stripeResourceId(invoice.customer);
    const users = getUsersCollection();
    let vendor = subscriptionId
      ? await users.findOne({ stripeSubscriptionId: subscriptionId })
      : null;
    if (!vendor && customerId) {
      vendor = await users.findOne({ stripeCustomerId: customerId });
    }
    if (!vendor) {
      throw new ApiError(
        404,
        'No vendor matches this subscription invoice — event marked for retry',
      );
    }
    return vendor;
  }

  /**
   * checkout.session.completed (subscription mode):
   * stores the Stripe identifiers, records the payment transaction, and —
   * once the subscription is verified active via a Stripe lookup made
   * OUTSIDE the transaction — activates Premium with the real period end.
   */
  async function handleCheckoutCompleted(event: Stripe.Event): Promise<boolean> {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== 'subscription') {
      return false; // Stripe is vendor-subscription only in PizzaHub
    }
    if (
      session.metadata?.kind !== undefined &&
      session.metadata.kind !== VENDOR_PREMIUM_METADATA_KIND
    ) {
      return false; // some other integration's session on the same account
    }
    const vendorId = session.client_reference_id ?? session.metadata?.vendorId;
    if (!vendorId) {
      return false; // not associated with a PizzaHub vendor (server always sets it)
    }

    const vendor = await findBetterAuthUserById(vendorId);
    if (!vendor || !normalizeRoles(vendor).includes('vendor')) {
      throw new ApiError(404, 'Vendor for this checkout session does not exist');
    }

    const subscriptionId = stripeResourceId(session.subscription);
    const customerId = stripeResourceId(session.customer);
    const paymentIntentId = stripeResourceId(session.payment_intent);

    // External Stripe API call — deliberately OUTSIDE the transaction below.
    const subscription = subscriptionId ? await gateway.retrieveSubscription(subscriptionId) : null;
    const verifiedPayment =
      subscription !== null &&
      (subscription.status === 'active' || subscription.status === 'trialing');

    const amount = session.amount_total ?? 0;
    const currency = session.currency;
    const recordPayment = amount > 0 && session.payment_status !== 'unpaid';
    let processed = false;

    await runInTransaction(async (dbSession) => {
      // Re-read inside the transaction so the ordering check sees the winner
      // of any concurrent webhook delivery.
      const current = await freshVendorForWrite(vendor, dbSession);
      const periodEndSeconds = subscription
        ? Math.floor(subscription.currentPeriodEnd.getTime() / 1000)
        : undefined;
      if (isStalePaymentEvent(current, event, subscriptionId, periodEndSeconds)) {
        return; // older checkout must not shorten expiry or reactivate a cancel
      }
      processed = true;

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (customerId) set.stripeCustomerId = customerId;
      if (subscriptionId) set.stripeSubscriptionId = subscriptionId;
      if (verifiedPayment && subscription && subscriptionId) {
        // Premium activation after VERIFIED payment (Stripe says the
        // subscription is active/trialing, i.e. the first invoice was paid).
        set.subscriptionPlan = 'premium';
        set.subscriptionLifecycle = lifecycleFor(
          subscriptionId,
          subscription.status,
          event,
          periodEndSeconds,
        );
      }
      const update: Record<string, unknown> = { $set: set };
      if (verifiedPayment && subscription) {
        // $max keeps a later renewal/period from being shortened by a delayed
        // checkout event whose Stripe lookup snapshot is older.
        update.$max = { subscriptionExpiresAt: subscription.currentPeriodEnd };
      }
      if (current.stripePendingCheckout?.sessionId === session.id) {
        update.$unset = { stripePendingCheckout: '' };
      }
      await getUsersCollection().updateOne({ _id: current._id }, update, { session: dbSession });

      if (recordPayment) {
        if (currency === null || currency === '') {
          // Unreachable for subscription sessions; fail loudly (and roll the
          // transaction back) rather than record a charge with no currency.
          throw new ApiError(500, 'Stripe checkout session has no currency');
        }
        const now = new Date();
        const transaction: Transaction = {
          _id: new ObjectId(),
          // Subscription payment: the vendor is the payer; never an orderId.
          customerId: String(current._id),
          vendorId: String(current._id),
          stripeEventId: event.id,
          type: 'payment',
          paymentStatus: 'paid',
          amount,
          currency,
          stripeSessionId: session.id,
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
          paidAt: now,
          createdAt: now,
          updatedAt: now,
        };
        // Existence check inside the SAME transaction: a resent event (or a
        // concurrent delivery of the same charge) skips instead of hitting
        // the unique index — a duplicate-key error would abort the whole
        // transaction. The catch below only covers the tiny race window
        // between this check and the insert.
        const existing = await getTransactionsCollection().findOne(
          { stripeSessionId: session.id },
          { session: dbSession },
        );
        if (!existing) {
          try {
            await getTransactionsCollection().insertOne(transaction, { session: dbSession });
          } catch (error) {
            // The charge is already recorded — keep processing idempotently.
            if (!isDuplicateKeyError(error)) throw error;
          }
        }
      }
    });
    return processed;
  }

  /** checkout.session.expired — clears the matching pending session bookkeeping. */
  async function handleCheckoutExpired(event: Stripe.Event): Promise<boolean> {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== 'subscription') return false;
    const vendorId = session.client_reference_id ?? session.metadata?.vendorId;
    if (!vendorId) return false;
    const vendor = await findBetterAuthUserById(vendorId);
    if (!vendor || vendor.stripePendingCheckout?.sessionId !== session.id) {
      return false;
    }
    await getUsersCollection().updateOne(
      { _id: vendor._id },
      { $set: { updatedAt: new Date() }, $unset: { stripePendingCheckout: '' } },
    );
    return true;
  }

  /**
   * invoice.paid:
   *  - `subscription_create` → first verified payment: activate Premium with
   *    the invoice period end (the session-anchored transaction for this
   *    charge is recorded by checkout.session.completed — never twice);
   *  - `subscription_cycle` → renewal: extend Premium (via $max, never
   *    shortening) and record the invoice-anchored payment transaction.
   */
  async function handleInvoicePaid(event: Stripe.Event): Promise<boolean> {
    const invoice = event.data.object as Stripe.Invoice;
    const reason = invoice.billing_reason;
    if (reason !== 'subscription_create' && reason !== 'subscription_cycle') {
      return false; // prorations/manual invoices are out of scope
    }

    const vendor = await resolveVendorForInvoice(invoice);
    const subscriptionId = stripeResourceId(invoice.subscription);
    const customerId = stripeResourceId(invoice.customer);
    const paymentIntentId = stripeResourceId(invoice.payment_intent);
    const periodEnd = new Date(invoice.period_end * 1000);
    const recordPayment = reason === 'subscription_cycle' && invoice.amount_paid > 0;
    let processed = false;

    await runInTransaction(async (dbSession) => {
      const current = await freshVendorForWrite(vendor, dbSession);
      const periodEndSeconds = Math.floor(periodEnd.getTime() / 1000);
      if (isStalePaymentEvent(current, event, subscriptionId, periodEndSeconds)) {
        return; // a canceled/older subscription must not be reactivated
      }
      processed = true;

      const set: Record<string, unknown> = {
        subscriptionPlan: 'premium',
        updatedAt: new Date(),
      };
      if (subscriptionId) set.stripeSubscriptionId = subscriptionId;
      if (customerId) set.stripeCustomerId = customerId;
      if (subscriptionId) {
        set.subscriptionLifecycle = lifecycleFor(subscriptionId, 'active', event, periodEndSeconds);
      }

      const update: Record<string, unknown> = {
        $set: set,
        // $max guarantees the expiry only ever moves forward.
        $max: { subscriptionExpiresAt: periodEnd },
      };
      await getUsersCollection().updateOne({ _id: current._id }, update, { session: dbSession });

      if (recordPayment) {
        const now = new Date();
        // Recurring charges never pass through Checkout, so the unique
        // idempotency slot carries the Stripe Invoice id instead.
        const transaction: Transaction = {
          _id: new ObjectId(),
          customerId: String(current._id),
          vendorId: String(current._id),
          stripeEventId: event.id,
          type: 'payment',
          paymentStatus: 'paid',
          amount: invoice.amount_paid,
          currency: invoice.currency,
          stripeSessionId: invoice.id,
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
          paidAt: now,
          createdAt: now,
          updatedAt: now,
        };
        // Same in-transaction existence check as the checkout handler: a
        // resent invoice event skips instead of aborting on the unique index.
        const existing = await getTransactionsCollection().findOne(
          { stripeSessionId: invoice.id },
          { session: dbSession },
        );
        if (!existing) {
          try {
            await getTransactionsCollection().insertOne(transaction, { session: dbSession });
          } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
          }
        } else if (existing.paymentStatus === 'failed') {
          // A previously failed invoice for this same charge has now paid.
          // Update that record instead of creating a second one.
          await getTransactionsCollection().updateOne(
            { _id: existing._id, paymentStatus: 'failed' },
            {
              $set: {
                paymentStatus: 'paid',
                paidAt: now,
                updatedAt: now,
                stripeEventId: event.id,
                amount: invoice.amount_paid,
                ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
              },
              $unset: { failureReason: '' },
            },
            { session: dbSession },
          );
        }
      }
    });
    return processed;
  }

  /**
   * invoice.payment_failed — payment failure handling with the seven-day
   * grace period. A vendor who STILL holds active Premium right now is
   * never downgraded here: `subscriptionExpiresAt` is pushed forward to at
   * least now + 7 days (never shortened), and premium then lapses on its
   * own if no successful payment arrives — no scheduler required.
   * Vendors without active Premium are not eligible and are left untouched.
   */
  async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<boolean> {
    const invoice = event.data.object as Stripe.Invoice;
    const vendor = await resolveVendorForInvoice(invoice);

    // Eligibility is re-checked from the transaction snapshot below; the
    // pre-transaction read may be stale and must not suppress a real payment
    // failure record.
    const subscriptionId = stripeResourceId(invoice.subscription);
    const periodEndSeconds =
      typeof invoice.period_end === 'number' ? Math.floor(invoice.period_end) : undefined;
    const created = eventCreatedSeconds(event);
    let processed = false;

    await runInTransaction(async (dbSession) => {
      const current = await freshVendorForWrite(vendor, dbSession);
      if (isStalePaymentEvent(current, event, subscriptionId, periodEndSeconds)) {
        return; // an older failure must not extend grace or be recorded
      }
      // Re-check eligibility from the transaction snapshot. Preserve the
      // existing contract: a failure from a vendor without active Premium is
      // acknowledged but neither changes state nor creates a ledger record.
      if (!hasActivePremiumSubscription(current)) {
        return;
      }
      processed = true;

      const now = new Date();
      const currentExpiry = expiryMilliseconds(current.subscriptionExpiresAt) ?? now.getTime();
      const graceExpiry = Math.max(currentExpiry, now.getTime() + SUBSCRIPTION_GRACE_PERIOD_MS);

      // The watermark filter makes repeated/delayed failures idempotent:
      // only the newest event can move the grace expiry.
      await getUsersCollection().updateOne(
        {
          _id: current._id,
          $or: [
            { subscriptionLifecycle: { $exists: false } },
            { 'subscriptionLifecycle.eventCreated': { $lt: created } },
          ],
        },
        {
          $set: {
            subscriptionExpiresAt: new Date(graceExpiry),
            updatedAt: now,
            ...(subscriptionId
              ? {
                  subscriptionLifecycle: lifecycleFor(
                    subscriptionId,
                    'past_due',
                    event,
                    periodEndSeconds,
                  ),
                }
              : {}),
          },
        },
        { session: dbSession },
      );

      // Failure is a financial event in its own right. It uses the invoice id
      // as the same unique anchor as a successful renewal, so a later
      // invoice.paid flips this document instead of creating a duplicate.
      const existing = await getTransactionsCollection().findOne(
        { stripeSessionId: invoice.id },
        { session: dbSession },
      );
      const failureReason = invoiceFailureReason(invoice);
      if (!existing) {
        const transaction: Transaction = {
          _id: new ObjectId(),
          customerId: String(current._id),
          vendorId: String(current._id),
          stripeEventId: event.id,
          type: 'payment',
          paymentStatus: 'failed',
          amount: invoice.amount_due ?? 0,
          currency: invoice.currency || 'usd',
          stripeSessionId: invoice.id,
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          failureReason,
          createdAt: now,
          updatedAt: now,
        };
        try {
          await getTransactionsCollection().insertOne(transaction, { session: dbSession });
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
        }
      } else if (existing.paymentStatus === 'paid') {
        await getTransactionsCollection().updateOne(
          { _id: existing._id, paymentStatus: 'paid' },
          {
            $set: { paymentStatus: 'failed', failureReason, updatedAt: now },
            $unset: { paidAt: '' },
          },
          { session: dbSession },
        );
      } else {
        await getTransactionsCollection().updateOne(
          { _id: existing._id, paymentStatus: 'failed' },
          { $set: { failureReason, updatedAt: now, stripeEventId: event.id } },
          { session: dbSession },
        );
      }
    });

    return processed;
  }

  /** Resolves the vendor for subscription events (metadata first, ids as fallback). */
  async function resolveSubscriptionVendor(
    subscription: Stripe.Subscription,
  ): Promise<BetterAuthUser | null> {
    const metadataVendorId = subscription.metadata?.vendorId;
    let vendor = metadataVendorId ? await findBetterAuthUserById(metadataVendorId) : null;
    if (!vendor) {
      vendor = await getUsersCollection().findOne({ stripeSubscriptionId: subscription.id });
    }
    const customerId = stripeResourceId(subscription.customer);
    if (!vendor && customerId) {
      vendor = await getUsersCollection().findOne({ stripeCustomerId: customerId });
    }
    // null → a foreign subscription on the shared Stripe account: ignore
    // (acknowledge) rather than retry forever.
    return vendor;
  }

  /**
   * customer.subscription.created / .updated — status synchronization only:
   * stores identifiers, downgrades on canceled/unpaid, and keeps the expiry
   * in sync for an already-premium vendor ($max — never shortens).
   * Activation itself only ever happens on VERIFIED PAYMENT events
   * (checkout.session.completed / invoice.paid).
   */
  async function handleSubscriptionSync(event: Stripe.Event): Promise<boolean> {
    const subscription = event.data.object as Stripe.Subscription;
    const vendor = await resolveSubscriptionVendor(subscription);
    if (!vendor) return false;

    const customerId = stripeResourceId(subscription.customer);
    const periodEnd = new Date(subscription.current_period_end * 1000);
    const periodEndSeconds = Math.floor(subscription.current_period_end);
    const isTerminal = subscription.status === 'canceled' || subscription.status === 'unpaid';
    let processed = false;

    await runInTransaction(async (dbSession) => {
      const current = await freshVendorForWrite(vendor, dbSession);
      if (
        isTerminal
          ? isStaleTerminalEvent(current, event, subscription.id)
          : isStalePaymentEvent(current, event, subscription.id, periodEndSeconds)
      ) {
        return;
      }
      processed = true;

      const now = new Date();
      const set: Record<string, unknown> = {
        stripeSubscriptionId: subscription.id,
        updatedAt: now,
        subscriptionLifecycle: lifecycleFor(
          subscription.id,
          subscription.status,
          event,
          periodEndSeconds,
        ),
      };
      if (customerId) set.stripeCustomerId = customerId;

      const update: Record<string, unknown> = { $set: set };
      if (isTerminal && current.subscriptionPlan === 'premium') {
        set.subscriptionPlan = 'free';
        set.subscriptionExpiresAt = null;
      } else if (
        (subscription.status === 'active' || subscription.status === 'trialing') &&
        current.subscriptionPlan === 'premium'
      ) {
        update.$max = { subscriptionExpiresAt: periodEnd };
      }

      await getUsersCollection().updateOne({ _id: current._id }, update, { session: dbSession });
      if (isTerminal) {
        // Documents are preserved; only excess active items are paused.
        await enforceFreePlanActiveLimitInSession(String(current._id), dbSession);
      }
    });

    return processed;
  }

  /** customer.subscription.deleted — downgrade once (idempotent). */
  async function handleSubscriptionDeleted(event: Stripe.Event): Promise<boolean> {
    const subscription = event.data.object as Stripe.Subscription;
    const vendor = await resolveSubscriptionVendor(subscription);
    if (!vendor) return false;

    let processed = false;
    await runInTransaction(async (dbSession) => {
      const current = await freshVendorForWrite(vendor, dbSession);
      if (isStaleTerminalEvent(current, event, subscription.id)) {
        return; // an old subscription must never downgrade a newer one
      }
      processed = true;

      const now = new Date();
      const set: Record<string, unknown> = {
        updatedAt: now,
        subscriptionLifecycle: lifecycleFor(
          subscription.id,
          'canceled',
          event,
          Math.floor(subscription.current_period_end * 1000),
        ),
      };
      if (current.subscriptionPlan === 'premium') {
        set.subscriptionPlan = 'free';
        set.subscriptionExpiresAt = null;
      }
      await getUsersCollection().updateOne(
        { _id: current._id },
        { $set: set },
        { session: dbSession },
      );
      await enforceFreePlanActiveLimitInSession(String(current._id), dbSession);
    });

    return processed;
  }

  async function dispatch(event: Stripe.Event): Promise<boolean> {
    switch (event.type) {
      case 'checkout.session.completed':
        return handleCheckoutCompleted(event);
      case 'checkout.session.expired':
        return handleCheckoutExpired(event);
      case 'invoice.paid':
        return handleInvoicePaid(event);
      case 'invoice.payment_failed':
        return handleInvoicePaymentFailed(event);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return handleSubscriptionSync(event);
      case 'customer.subscription.deleted':
        return handleSubscriptionDeleted(event);
      default:
        return false; // irrelevant event → acknowledge without processing
    }
  }

  /**
   * Idempotent entry point (signature already verified by the route).
   * Returns the outcome for the HTTP 200 response; any processing failure
   * marks the event `failed` and rethrows so the endpoint answers 5xx and
   * Stripe's retry can re-claim the same event safely.
   */
  async function processVerifiedEvent(event: Stripe.Event): Promise<WebhookOutcome> {
    const claimed = await claimEvent(event.id, event.type, eventCreatedSeconds(event));
    if (!claimed) {
      return { duplicate: true, handled: false };
    }

    const events = getWebhookEventsCollection();
    try {
      const handled = await dispatch(event);
      await events.updateOne(
        { stripeEventId: event.id },
        { $set: { status: 'processed', processedAt: new Date() } },
      );
      return { duplicate: false, handled };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await events.updateOne(
        { stripeEventId: event.id },
        { $set: { status: 'failed', lastError: message.slice(0, 500) } },
      );
      throw error;
    }
  }

  return { processVerifiedEvent };
}
