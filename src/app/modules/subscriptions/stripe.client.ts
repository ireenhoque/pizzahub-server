import Stripe from 'stripe';
import { getStripeSecretKey, getStripeWebhookSecret } from '../../config/env.js';
import { ApiError } from '../../error/ApiError.js';

/**
 * Server-side Stripe integration surface for vendor Premium subscriptions.
 *
 * Two seam types live here:
 *  1. `getStripeClient()` — the real Stripe SDK (lazily configured, used for
 *     webhook signature verification and by the real gateway below).
 *  2. `StripeBillingGateway` — a narrow interface over the three NETWORK
 *     operations we perform. Tests inject a fake gateway through
 *     `createApp({ stripeGateway })`, exactly like the injected JWKS
 *     `requireAuth` and the `uploadImage` uploader. Signature verification
 *     intentionally does NOT go through the gateway: it is offline HMAC
 *     crypto and must stay real in tests.
 *
 * External Stripe API calls always happen OUTSIDE MongoDB transaction
 * callbacks; MongoDB writes never appear inside a Stripe API call.
 */

/** metadata.kind stamped on every Premium Checkout session/subscription we create. */
export const VENDOR_PREMIUM_METADATA_KIND = 'vendor_premium';

/**
 * Maps missing/invalid Stripe configuration to a 503 that names the
 * variable — the secret values themselves are never echoed anywhere.
 */
export function stripeConfigOr503<T>(read: () => T, key: string): T {
  try {
    return read();
  } catch {
    throw new ApiError(
      503,
      `Stripe subscriptions are not configured (${key} is missing or invalid)`,
    );
  }
}

/** Narrows Stripe's `string | { id } | null` identifier fields to a plain id. */
export function stripeResourceId(
  value: string | { id: string } | null | undefined,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : value.id;
}

let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

/**
 * Real Stripe SDK client. The secret key is read LAZILY on every call, so
 * application startup never requires it and tests can supply a test-mode
 * placeholder before the first billing request.
 */
export function getStripeClient(): Stripe {
  const key = stripeConfigOr503(getStripeSecretKey, 'STRIPE_SECRET_KEY');
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new Stripe(key);
    cachedKey = key;
  }
  return cachedClient;
}

/**
 * Verifies a Stripe-Signature header against the RAW request body using
 * `STRIPE_WEBHOOK_SECRET`. Pure offline HMAC — no network, no fallback:
 * invalid signatures are rejected with 400.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): Stripe.Event {
  const secret = stripeConfigOr503(getStripeWebhookSecret, 'STRIPE_WEBHOOK_SECRET');
  try {
    return getStripeClient().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    // Message deliberately generic: never echo payload/signature details.
    throw new ApiError(400, 'Webhook signature verification failed');
  }
}

/* ─────────────────────────── gateway contract ─────────────────────────── */

export interface PremiumCheckoutInput {
  /** Vendor `_id`, always derived server-side from the verified JWT. */
  vendorId: string;
  vendorEmail?: string;
  /** Server-configured Stripe Price id — never taken from a request body. */
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Reuse the vendor's existing Stripe customer if we already know it. */
  existingStripeCustomerId?: string;
}

export interface PremiumCheckoutResult {
  sessionId: string;
  checkoutUrl: string;
  /** Stripe customer id created/used for this session, when returned. */
  stripeCustomerId?: string;
}

export interface CheckoutSessionSnapshot {
  status: string; // 'open' | 'complete' | 'expired'
}

export interface SubscriptionSnapshot {
  id: string;
  status: string; // 'active' | 'trialing' | 'past_due' | 'canceled' | …
  currentPeriodEnd: Date;
}

/** The only Stripe operations the billing flows perform over the network. */
export interface StripeBillingGateway {
  createPremiumCheckoutSession(input: PremiumCheckoutInput): Promise<PremiumCheckoutResult>;
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionSnapshot | null>;
  retrieveSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

/** True when a Stripe error means "no such object" (as opposed to a network failure). */
function isStripeResourceMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'resource_missing'
  );
}

/** Production gateway backed by the real Stripe SDK (test mode or live, per env). */
export function createStripeBillingGateway(): StripeBillingGateway {
  return {
    async createPremiumCheckoutSession(input: PremiumCheckoutInput) {
      const session = await getStripeClient().checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        // Server-side association of the session with the authenticated vendor:
        // client_reference_id + metadata on BOTH the session and the subscription.
        client_reference_id: input.vendorId,
        metadata: { vendorId: input.vendorId, kind: VENDOR_PREMIUM_METADATA_KIND },
        subscription_data: {
          metadata: { vendorId: input.vendorId, kind: VENDOR_PREMIUM_METADATA_KIND },
        },
        ...(input.existingStripeCustomerId
          ? { customer: input.existingStripeCustomerId }
          : input.vendorEmail
            ? { customer_email: input.vendorEmail }
            : {}),
      });
      return {
        sessionId: session.id,
        checkoutUrl: session.url ?? '',
        stripeCustomerId: stripeResourceId(session.customer),
      };
    },

    async retrieveCheckoutSession(sessionId: string) {
      try {
        const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
        // Null status cannot occur for a real session; an unknown value makes
        // the caller create a fresh session rather than reuse blindly.
        return { status: session.status ?? 'unknown' };
      } catch (error) {
        if (isStripeResourceMissing(error)) {
          return null;
        }
        throw error;
      }
    },

    async retrieveSubscription(subscriptionId: string) {
      try {
        const subscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
        return {
          id: subscription.id,
          status: subscription.status,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        };
      } catch (error) {
        if (isStripeResourceMissing(error)) {
          return null;
        }
        throw error;
      }
    },

    async cancelSubscription(subscriptionId: string) {
      await getStripeClient().subscriptions.cancel(subscriptionId);
    },
  };
}
