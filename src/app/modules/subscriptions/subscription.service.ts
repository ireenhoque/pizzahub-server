import { ApiError } from '../../error/ApiError.js';
import { findBetterAuthUserById, getUsersCollection } from '../../db/collections.js';
import { normalizeRoles } from '../../auth/require-auth.js';
import {
  getStripeCancelUrl,
  getStripePremiumPriceId,
  getStripeSuccessUrl,
} from '../../config/env.js';
import { hasActivePremiumSubscription } from '../users/user.service.js';
import type { AuthenticatedUser, BetterAuthUser } from '../../auth/auth.types.js';
import { stripeConfigOr503, type StripeBillingGateway } from './stripe.client.js';

/**
 * Vendor Premium subscription management (Stripe Checkout is used EXCLUSIVELY
 * for vendor subscriptions — customer orders never touch Stripe).
 *
 * Security invariants:
 *  - identity always comes from the DB-verified `auth` (never request input);
 *  - the Price id and success/cancel URLs come from server configuration;
 *  - the request body is validated by a strict empty schema, so no client
 *    price/amount/vendor field can influence what Stripe is asked to charge;
 *  - every external Stripe call happens before (and outside of) any
 *    MongoDB write, and the writes themselves are single-document or
 *    transactional (see webhook.service.ts for multi-document updates).
 */

export interface CheckoutSessionResult {
  sessionId: string;
  checkoutUrl: string;
}

export interface SubscriptionStatus {
  plan: string;
  isActive: boolean;
  expiresAt: Date | string | null;
  stripeSubscriptionId: string | null;
}

/** Resolves the caller as an existing vendor from MongoDB (roles are DB-derived). */
async function requireVendorUser(auth: AuthenticatedUser): Promise<BetterAuthUser> {
  if (!auth.roles.includes('vendor')) {
    throw new ApiError(403, 'Only vendors can manage a Premium subscription');
  }
  const vendor = await findBetterAuthUserById(auth.userId);
  if (!vendor) {
    throw new ApiError(404, 'Vendor not found');
  }
  if (!normalizeRoles(vendor).includes('vendor')) {
    throw new ApiError(403, 'Only vendors can manage a Premium subscription');
  }
  return vendor;
}

function toStatus(vendor: BetterAuthUser): SubscriptionStatus {
  return {
    plan: vendor.subscriptionPlan ?? 'free',
    isActive: hasActivePremiumSubscription(vendor),
    expiresAt: vendor.subscriptionExpiresAt ?? null,
    stripeSubscriptionId: vendor.stripeSubscriptionId ?? null,
  };
}

export function createSubscriptionService(gateway: StripeBillingGateway) {
  return {
    /** Creates (or reuses) the vendor's Premium Checkout session. */
    async createCheckoutSession(auth: AuthenticatedUser): Promise<CheckoutSessionResult> {
      const vendor = await requireVendorUser(auth);

      // Prevent unnecessary duplicate subscriptions: an active Premium
      // vendor never gets a second checkout session.
      if (hasActivePremiumSubscription(vendor)) {
        throw new ApiError(409, 'This vendor already has an active Premium subscription');
      }

      // Server-controlled Stripe configuration (client input is not consulted).
      const priceId = stripeConfigOr503(getStripePremiumPriceId, 'STRIPE_PREMIUM_PRICE_ID');
      const successUrl = stripeConfigOr503(getStripeSuccessUrl, 'STRIPE_SUCCESS_URL');
      const cancelUrl = stripeConfigOr503(getStripeCancelUrl, 'STRIPE_CANCEL_URL');

      // Reuse an already-open Checkout session instead of minting another one
      // (double-clicks / parallel tabs must not produce two subscriptions).
      const pending = vendor.stripePendingCheckout;
      if (pending) {
        const snapshot = await gateway
          .retrieveCheckoutSession(pending.sessionId)
          .catch((error: unknown) => {
            if (error instanceof ApiError) throw error;
            throw new ApiError(502, 'Stripe could not be reached to verify the pending checkout');
          });
        if (snapshot?.status === 'open') {
          return { sessionId: pending.sessionId, checkoutUrl: pending.url };
        }
        if (snapshot?.status === 'complete') {
          // Completed but the webhook has not arrived yet — creating another
          // session now could charge the vendor twice.
          throw new ApiError(
            409,
            'A Premium checkout was already completed for this vendor — awaiting payment confirmation',
          );
        }
        // 'expired' or unknown → fall through and create a fresh session.
      }

      const created = await gateway
        .createPremiumCheckoutSession({
          vendorId: String(vendor._id),
          vendorEmail: vendor.email,
          priceId,
          successUrl,
          cancelUrl,
          existingStripeCustomerId: vendor.stripeCustomerId,
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError) throw error;
          throw new ApiError(502, 'Stripe Checkout could not be created — please retry');
        });

      if (!created.sessionId || !created.checkoutUrl) {
        throw new ApiError(502, 'Stripe returned an unusable Checkout session');
      }

      // Persist bookkeeping: the pending session (duplicate prevention) and
      // the Stripe customer id (stable vendor↔Stripe association for the
      // webhook). Single-document write → no transaction needed.
      const now = new Date();
      const set: Record<string, unknown> = {
        stripePendingCheckout: {
          sessionId: created.sessionId,
          url: created.checkoutUrl,
          createdAt: now,
        },
        updatedAt: now,
      };
      if (created.stripeCustomerId) {
        set.stripeCustomerId = created.stripeCustomerId;
      }
      await getUsersCollection().updateOne({ _id: vendor._id }, { $set: set });

      return { sessionId: created.sessionId, checkoutUrl: created.checkoutUrl };
    },

    /** Vendor-facing subscription status, computed from the fresh user document. */
    async getSubscriptionStatus(auth: AuthenticatedUser): Promise<SubscriptionStatus> {
      const vendor = await requireVendorUser(auth);
      return toStatus(vendor);
    },

    /**
     * Cancels the vendor's Stripe subscription. Stripe is called FIRST
     * (outside any transaction); only after Stripe accepts is the single
     * user document downgraded. The later `customer.subscription.deleted`
     * webhook is an idempotent no-op against the already-downgraded user.
     */
    async cancelSubscription(auth: AuthenticatedUser): Promise<SubscriptionStatus> {
      const vendor = await requireVendorUser(auth);
      if (!vendor.stripeSubscriptionId) {
        throw new ApiError(409, 'No Stripe subscription is attached to this vendor');
      }
      if (!hasActivePremiumSubscription(vendor)) {
        throw new ApiError(409, 'No active Premium subscription to cancel');
      }

      await gateway.cancelSubscription(vendor.stripeSubscriptionId).catch((error: unknown) => {
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'Stripe rejected the cancellation — please retry');
      });

      await getUsersCollection().updateOne(
        { _id: vendor._id },
        { $set: { subscriptionPlan: 'free', subscriptionExpiresAt: null, updatedAt: new Date() } },
      );

      const updated = await findBetterAuthUserById(auth.userId);
      if (!updated) {
        throw new ApiError(404, 'Vendor not found');
      }
      return toStatus(updated);
    },
  };
}
