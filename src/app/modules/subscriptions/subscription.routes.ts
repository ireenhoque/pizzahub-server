import { Router, type RequestHandler } from 'express';
import { getAuthenticatedUser, requireVendor } from '../../auth/require-auth.js';
import { ApiError } from '../../error/ApiError.js';
import { validate } from '../../middlewares/validate.js';
import { createCheckoutSchema } from './subscription.validation.js';
import { createSubscriptionService } from './subscription.service.js';
import { createWebhookService } from './webhook.service.js';
import { verifyWebhookSignature, type StripeBillingGateway } from './stripe.client.js';

/**
 * Vendor Premium subscription routes.
 *
 * - `/api/subscriptions/*` requires the DB-verified JWT plus the vendor role.
 * - `/api/stripe/webhook` is intentionally NOT JWT-protected: it is secured
 *   by Stripe's HMAC signature over the RAW request body (express.raw() is
 *   registered for this path in create-app.ts BEFORE express.json()).
 */
export function createSubscriptionRouter(
  requireAuth: RequestHandler,
  gateway: StripeBillingGateway,
): Router {
  const service = createSubscriptionService(gateway);
  const router = Router();

  const createCheckout: RequestHandler = async (req, res, next) => {
    try {
      const auth = getAuthenticatedUser(req); // role also gated by requireVendor
      const result = await service.createCheckoutSession(auth);
      res.status(201).json({
        success: true,
        message: 'Premium checkout session created',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  const getStatus: RequestHandler = async (req, res, next) => {
    try {
      const auth = getAuthenticatedUser(req);
      const subscription = await service.getSubscriptionStatus(auth);
      res.status(200).json({
        success: true,
        message: 'Subscription status retrieved',
        data: { subscription },
      });
    } catch (error) {
      next(error);
    }
  };

  const cancel: RequestHandler = async (req, res, next) => {
    try {
      const auth = getAuthenticatedUser(req);
      const subscription = await service.cancelSubscription(auth);
      res.status(200).json({
        success: true,
        message: 'Subscription cancelled',
        data: { subscription },
      });
    } catch (error) {
      next(error);
    }
  };

  // Strictly empty body: clients cannot submit prices, amounts or vendor ids.
  router.post(
    '/checkout',
    requireAuth,
    requireVendor,
    validate({ body: createCheckoutSchema }),
    createCheckout,
  );
  router.get('/', requireAuth, requireVendor, getStatus);
  router.post('/cancel', requireAuth, requireVendor, cancel);

  return router;
}

/** POST /api/stripe/webhook — signature-verified, idempotent Stripe events. */
export function createStripeWebhookRouter(gateway: StripeBillingGateway): Router {
  const service = createWebhookService(gateway);
  const router = Router();

  const receiveEvent: RequestHandler = async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        // The raw-body middleware in create-app.ts was not applied — refuse rather
        // than verifying a parsed object (signatures would always fail open).
        throw new ApiError(500, 'Stripe webhook requires the raw request body');
      }
      const signature = req.headers['stripe-signature'];
      if (typeof signature !== 'string' || signature.length === 0) {
        throw new ApiError(400, 'Missing stripe-signature header');
      }

      // Offline HMAC verification — invalid signatures are rejected with 400
      // before any database access.
      const event = verifyWebhookSignature(req.body, signature);
      const outcome = await service.processVerifiedEvent(event);

      res.status(200).json({
        success: true,
        message: outcome.duplicate ? 'Event already processed' : 'Event processed',
        data: {
          stripeEventId: event.id, // Stripe Event ID, kept distinct from any Checkout Session id
          duplicate: outcome.duplicate,
          handled: outcome.handled,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  router.post('/', receiveEvent);
  return router;
}
