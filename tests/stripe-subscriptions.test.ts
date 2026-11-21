import { createServer, type AddressInfo, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { Express } from 'express';
import Stripe from 'stripe';
import { connectDatabase, disconnectDatabase, getDatabase } from '../src/app/config/db.js';
import { ensureIndexes } from '../src/app/db/indexes.js';
import { getTransactionsCollection, getUsersCollection } from '../src/app/db/collections.js';
import { getWebhookEventsCollection } from '../src/app/db/webhookEvents.collection.js';
import { createRequireAuth } from '../src/app/auth/require-auth.js';
import { createApp } from '../src/app.js';
import type {
  CheckoutSessionSnapshot,
  PremiumCheckoutInput,
  StripeBillingGateway,
  SubscriptionSnapshot,
} from '../src/app/modules/subscriptions/stripe.client.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/**
 * One-shot switch that makes the NEXT `insertOne` on the transactions
 * collection reject. Used by the MongoDB transaction rollback test to force
 * a failure on the second write of the activation transaction (after the
 * user document was already updated inside the transaction), proving that
 * nothing is persisted partially.
 */
const failureControl = vi.hoisted(() => ({ failNextTransactionInsert: false }));

vi.mock('../src/app/db/collections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/db/collections.js')>();
  return {
    ...actual,
    getTransactionsCollection: () => {
      const real = actual.getTransactionsCollection();
      if (!failureControl.failNextTransactionInsert) {
        return real;
      }
      return new Proxy(real, {
        get(target, property) {
          if (property === 'insertOne') {
            return () => {
              failureControl.failNextTransactionInsert = false;
              return Promise.reject(new Error('forced insertOne failure'));
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

/**
 * Regression coverage for the Stripe vendor-Premium subscription system:
 * - Checkout: vendor-only, strict empty body (client prices/vendor ids rejected),
 *   server-controlled price/URLs, duplicate-session and duplicate-subscription
 *   prevention, Stripe identifiers persisted.
 * - Webhook: raw body + HMAC signature verification (valid/invalid/tampered),
 *   event-id idempotency, duplicate transaction prevention, verified-payment
 *   activation, renewal invoices, seven-day grace on payment failure,
 *   cancellation downgrade, status synchronization.
 * - Reliability: MongoDB transaction rollback on partial failure + safe
 *   reprocessing of a failed event on Stripe's retry.
 * Stripe network calls are faked through the injected gateway; signature
 * verification uses the real Stripe SDK in offline test mode.
 */
describe('Stripe vendor Premium subscriptions', () => {
  let jwksServer: Server;
  let app: Express;
  let keyPair: GeneratedKeyPair;

  const runId = randomUUID().slice(0, 8);
  const signedIn = new Map<string, string>();

  const day = 86_400_000;
  const ids = {
    cust1: `uitest-${runId}-sub-cust`,
    checkout: `uitest-${runId}-sub-checkout`,
    premium: `uitest-${runId}-sub-premium`,
    pending: `uitest-${runId}-sub-pending`,
    webhook: `uitest-${runId}-sub-webhook`,
    inv: `uitest-${runId}-sub-inv`,
    sync: `uitest-${runId}-sub-sync`,
    noverify: `uitest-${runId}-sub-noverify`,
    rollback: `uitest-${runId}-sub-rollback`,
    nosub: `uitest-${runId}-sub-nosub`,
    cancel: `uitest-${runId}-sub-cancel`,
    cancelFail: `uitest-${runId}-sub-cancelfail`,
    freeFail: `uitest-${runId}-sub-freefail`,
    expireme: `uitest-${runId}-sub-expire`,
  };

  const stripeIds = {
    ws: `cus_${runId}_ws`,
    wsSub: `sub_${runId}_ws`,
    inv: `cus_${runId}_inv`,
    invSub: `sub_${runId}_inv`,
    sync: `cus_${runId}_sync`,
    syncSub: `sub_${runId}_sync`,
    free: `cus_${runId}_free`,
    rbSub: `sub_${runId}_rb`,
    nvSub: `sub_${runId}_nv`,
  };

  const wsSessionId = `cs_test_${runId}_ws1`;
  const openSessionId = `cs_test_${runId}_open`;
  const expiredSessionId = `cs_test_${runId}_exp`;

  let webhookSecret = '';
  let checkoutEnd: Date;
  const signer = new Stripe('sk_test_signer_dummy');

  // ── Fake Stripe gateway (network seam) ─────────────────────────────────
  interface FakeGateway extends StripeBillingGateway {
    checkoutCalls: PremiumCheckoutInput[];
    cancelledSubscriptions: string[];
    checkoutSessions: Map<string, CheckoutSessionSnapshot>;
    subscriptions: Map<string, SubscriptionSnapshot>;
    failCancel: boolean;
  }

  function createFakeGateway(): FakeGateway {
    return {
      checkoutCalls: [],
      cancelledSubscriptions: [],
      checkoutSessions: new Map(),
      subscriptions: new Map(),
      failCancel: false,
      async createPremiumCheckoutSession(input) {
        this.checkoutCalls.push(input);
        const sequence = this.checkoutCalls.length;
        return {
          sessionId: `cs_test_${runId}_${sequence}`,
          checkoutUrl: `https://checkout.stripe.com/c/pay/cs_test_${runId}_${sequence}`,
          stripeCustomerId: input.existingStripeCustomerId ?? `cus_${runId}_created`,
        };
      },
      async retrieveCheckoutSession(sessionId) {
        return this.checkoutSessions.get(sessionId) ?? null;
      },
      async retrieveSubscription(subscriptionId) {
        return this.subscriptions.get(subscriptionId) ?? null;
      },
      async cancelSubscription(subscriptionId) {
        if (this.failCancel) throw new Error('stripe unavailable (fake)');
        this.cancelledSubscriptions.push(subscriptionId);
      },
    };
  }

  let fake: FakeGateway;

  // ── Helpers ────────────────────────────────────────────────────────────
  async function tokenFor(userId: string): Promise<string> {
    let token = signedIn.get(userId);
    if (!token) {
      token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'subs-test-key' })
        .setSubject(userId)
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .sign(keyPair.privateKey);
      signedIn.set(userId, token);
    }
    return token;
  }

  async function authedPost(path: string, userId: string, body: object = {}) {
    return request(app)
      .post(path)
      .set('Authorization', `Bearer ${await tokenFor(userId)}`)
      .send(body);
  }

  function eventPayload(type: string, object: Record<string, unknown>, eventId?: string) {
    return {
      id: eventId ?? `evt_${runId}-${randomUUID().slice(0, 8)}`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type,
      data: { object },
    };
  }

  /** Posts a raw payload string, signing it (or reusing a supplied header). */
  function postWebhook(payloadString: string, options: { secret?: string; header?: string } = {}) {
    const header =
      options.header ??
      signer.webhooks.generateTestHeaderString({
        payload: payloadString,
        secret: options.secret ?? webhookSecret,
      });
    return request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payloadString);
  }

  function checkoutSessionObject(vendorId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: wsSessionId,
      object: 'checkout.session',
      mode: 'subscription',
      client_reference_id: vendorId,
      metadata: { vendorId, kind: 'vendor_premium' },
      customer: stripeIds.ws,
      subscription: stripeIds.wsSub,
      payment_intent: `pi_${runId}_ws`,
      payment_status: 'paid',
      amount_total: 6000,
      currency: 'usd',
      ...overrides,
    };
  }

  beforeAll(async () => {
    // ── Stripe env (names are config, never secret values) ──────────────
    process.env.STRIPE_SECRET_KEY ??= 'sk_test_pizzahub_dummy_key';
    process.env.STRIPE_PREMIUM_PRICE_ID = 'price_test_premium_monthly';
    process.env.STRIPE_SUCCESS_URL = 'https://app.pizzahub.test/billing/success';
    process.env.STRIPE_CANCEL_URL = 'https://app.pizzahub.test/billing/cancel';
    webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? `whsec_${runId}_fallback`;

    await connectDatabase();

    // Real idempotent index definitions (unique session/event slots power
    // duplicate-transaction prevention in the webhook tests below).
    await ensureIndexes(getDatabase(), { skipMissingCollections: false });

    keyPair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'subs-test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    const server = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    jwksServer = server;
    const { port } = server.address() as AddressInfo;

    const requireAuth = createRequireAuth({
      jwksUrl: `http://127.0.0.1:${port}/jwks`,
      issuer: ISSUER,
      audience: AUDIENCE,
      cooldownDuration: 0,
    });

    fake = createFakeGateway();
    app = createApp({ requireAuthMiddleware: requireAuth, stripeGateway: fake });

    // ── Seed users in the states the flows start from ───────────────────
    const now = new Date();
    function baseUser(id: string, role: string) {
      return {
        _id: id,
        name: `UITEST-${runId} ${role}`,
        email: `${id}@example.com`,
        emailVerified: true,
        role,
        isBlocked: false,
        banned: false,
        createdAt: now,
        updatedAt: now,
      };
    }

    await getUsersCollection().insertMany([
      baseUser(ids.cust1, 'customer'),
      baseUser(ids.checkout, 'vendor'),
      {
        ...baseUser(ids.premium, 'vendor'),
        subscriptionPlan: 'premium',
        subscriptionExpiresAt: new Date(Date.now() + 30 * day),
      },
      {
        ...baseUser(ids.pending, 'vendor'),
        stripeCustomerId: `cus_${runId}_pending`,
        stripePendingCheckout: {
          sessionId: openSessionId,
          url: 'https://checkout.stripe.com/test/open',
          createdAt: now,
        },
      },
      {
        ...baseUser(ids.webhook, 'vendor'),
        stripeCustomerId: stripeIds.ws,
        stripePendingCheckout: {
          sessionId: wsSessionId,
          url: 'https://checkout.stripe.com/test/ws1',
          createdAt: now,
        },
      },
      { ...baseUser(ids.inv, 'vendor'), stripeCustomerId: stripeIds.inv },
      {
        ...baseUser(ids.sync, 'vendor'),
        subscriptionPlan: 'premium',
        subscriptionExpiresAt: new Date(Date.now() + 5 * day),
        stripeSubscriptionId: stripeIds.syncSub,
        stripeCustomerId: stripeIds.sync,
      },
      baseUser(ids.noverify, 'vendor'),
      baseUser(ids.rollback, 'vendor'),
      baseUser(ids.nosub, 'vendor'),
      {
        ...baseUser(ids.cancel, 'vendor'),
        subscriptionPlan: 'premium',
        subscriptionExpiresAt: new Date(Date.now() + 30 * day),
        stripeSubscriptionId: `sub_${runId}_cancel`,
      },
      {
        ...baseUser(ids.cancelFail, 'vendor'),
        subscriptionPlan: 'premium',
        subscriptionExpiresAt: new Date(Date.now() + 30 * day),
        stripeSubscriptionId: `sub_${runId}_cancelfail`,
      },
      { ...baseUser(ids.freeFail, 'vendor'), stripeCustomerId: stripeIds.free },
      {
        ...baseUser(ids.expireme, 'vendor'),
        stripePendingCheckout: {
          sessionId: expiredSessionId,
          url: 'https://checkout.stripe.com/test/exp',
          createdAt: now,
        },
      },
    ]);

    // ── Fake Stripe state (subscriptions the gateway can look up) ───────
    checkoutEnd = new Date(Math.floor((Date.now() + 30 * day) / 1000) * 1000);
    fake.subscriptions.set(stripeIds.wsSub, {
      id: stripeIds.wsSub,
      status: 'active',
      currentPeriodEnd: checkoutEnd,
    });
    fake.subscriptions.set(stripeIds.rbSub, {
      id: stripeIds.rbSub,
      status: 'active',
      currentPeriodEnd: checkoutEnd,
    });
    fake.checkoutSessions.set(openSessionId, { status: 'open' });
  });

  afterAll(async () => {
    await getUsersCollection().deleteMany({ _id: { $in: Object.values(ids) } });
    await getTransactionsCollection().deleteMany({ vendorId: { $in: Object.values(ids) } });
    await getWebhookEventsCollection().deleteMany({
      stripeEventId: { $regex: `^evt_${runId}-` },
    });
    await getWebhookEventsCollection().deleteMany({
      stripeEventId: `cs_test_${runId}_compat_new`,
    });
    await disconnectDatabase();
    if (jwksServer) await new Promise((resolve) => jwksServer.close(resolve));
  });

  // ═══════════════════════ Checkout ═══════════════════════════════════
  describe('Premium Checkout', () => {
    it('rejects unauthenticated checkout requests (401)', async () => {
      const res = await request(app).post('/api/subscriptions/checkout').send({});
      expect(res.status).toBe(401);
    });

    it('rejects customers attempting to create vendor subscriptions (403)', async () => {
      const res = await authedPost('/api/subscriptions/checkout', ids.cust1);
      expect(res.status).toBe(403);
      expect(fake.checkoutCalls).toHaveLength(0);
    });

    it('rejects client-supplied prices, amounts and vendor ids (400)', async () => {
      const before = fake.checkoutCalls.length;
      const res = await authedPost('/api/subscriptions/checkout', ids.checkout, {
        priceId: 'price_evil',
        amount: 1,
        vendorId: 'someone-else',
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Validation failed');
      expect(fake.checkoutCalls).toHaveLength(before);
    });

    it('creates a session with the server-configured price, URLs and vendor metadata (201)', async () => {
      const res = await authedPost('/api/subscriptions/checkout', ids.checkout);
      expect(res.status).toBe(201);
      expect(res.body.data.sessionId).toMatch(/^cs_test_/);
      expect(res.body.data.checkoutUrl).toContain('https://checkout.stripe.com/');

      expect(fake.checkoutCalls).toHaveLength(1);
      const input = fake.checkoutCalls[0]!;
      // Server-controlled pricing: the environment price, never client input.
      expect(input.priceId).toBe('price_test_premium_monthly');
      expect(input.successUrl).toBe('https://app.pizzahub.test/billing/success');
      expect(input.cancelUrl).toBe('https://app.pizzahub.test/billing/cancel');
      // Vendor identity comes from the verified JWT, not the request body.
      expect(input.vendorId).toBe(ids.checkout);
      expect(input.vendorEmail).toBe(`${ids.checkout}@example.com`);
      expect(input.existingStripeCustomerId).toBeUndefined();

      const user = await getUsersCollection().findOne({ _id: ids.checkout });
      expect(user?.stripePendingCheckout?.sessionId).toBe(res.body.data.sessionId);
      expect(user?.stripeCustomerId).toBe(`cus_${runId}_created`);
    });

    it('answers 503 (naming the variable) when the Premium price is not configured', async () => {
      const saved = process.env.STRIPE_PREMIUM_PRICE_ID;
      delete process.env.STRIPE_PREMIUM_PRICE_ID;
      try {
        const before = fake.checkoutCalls.length;
        const res = await authedPost('/api/subscriptions/checkout', ids.checkout);
        expect(res.status).toBe(503);
        expect(res.body.message).toContain('STRIPE_PREMIUM_PRICE_ID');
        expect(res.body.message).not.toContain('sk_');
        expect(fake.checkoutCalls).toHaveLength(before);
      } finally {
        if (saved !== undefined) process.env.STRIPE_PREMIUM_PRICE_ID = saved;
      }
    });

    it('prevents duplicate subscriptions for an active Premium vendor (409)', async () => {
      const before = fake.checkoutCalls.length;
      const res = await authedPost('/api/subscriptions/checkout', ids.premium);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('active Premium');
      expect(fake.checkoutCalls).toHaveLength(before);
    });

    it('reuses an open checkout session instead of creating a second one (201)', async () => {
      const before = fake.checkoutCalls.length;
      const res = await authedPost('/api/subscriptions/checkout', ids.pending);
      expect(res.status).toBe(201);
      expect(res.body.data.sessionId).toBe(openSessionId);
      expect(res.body.data.checkoutUrl).toBe('https://checkout.stripe.com/test/open');
      expect(fake.checkoutCalls).toHaveLength(before);
    });

    it('refuses a new session while a completed one awaits webhook confirmation (409)', async () => {
      fake.checkoutSessions.set(openSessionId, { status: 'complete' });
      const before = fake.checkoutCalls.length;
      const res = await authedPost('/api/subscriptions/checkout', ids.pending);
      expect(res.status).toBe(409);
      expect(fake.checkoutCalls).toHaveLength(before);
    });

    it('creates a fresh session after the previous one expired (201)', async () => {
      fake.checkoutSessions.set(openSessionId, { status: 'expired' });
      const before = fake.checkoutCalls.length;
      const res = await authedPost('/api/subscriptions/checkout', ids.pending);
      expect(res.status).toBe(201);
      expect(res.body.data.sessionId).not.toBe(openSessionId);
      expect(fake.checkoutCalls).toHaveLength(before + 1);
    });
  });

  // ═══════════════════════ Webhook signatures ═════════════════════════
  describe('Webhook signature verification', () => {
    it('rejects events without a stripe-signature header (400)', async () => {
      const payload = JSON.stringify(eventPayload('invoice.paid', { id: 'in_x' }));
      const res = await request(app)
        .post('/api/stripe/webhook')
        .set('Content-Type', 'application/json')
        .send(payload);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('stripe-signature');
    });

    it('rejects events signed with the wrong secret (400)', async () => {
      const payload = JSON.stringify(eventPayload('invoice.paid', { id: 'in_wrongsecret' }));
      const res = await postWebhook(payload, { secret: 'whsec_definitely_wrong' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Webhook signature verification failed');
    });

    it('rejects events whose payload was tampered with after signing (400)', async () => {
      const original = JSON.stringify(eventPayload('invoice.paid', { id: 'in_original' }));
      const header = signer.webhooks.generateTestHeaderString({
        payload: original,
        secret: webhookSecret,
      });
      const tampered = JSON.stringify(
        eventPayload('invoice.paid', { id: 'in_forged', amount_paid: 999_999_999 }),
      );
      const res = await postWebhook(tampered, { header });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Webhook signature verification failed');
    });

    it('acknowledges validly signed but irrelevant events without processing (200)', async () => {
      const payload = eventPayload('payment_intent.succeeded', { id: `pi_${runId}_irrelevant` });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.duplicate).toBe(false);
      expect(res.body.data.handled).toBe(false);
      const doc = await getWebhookEventsCollection().findOne({ stripeEventId: payload.id });
      expect(doc?.status).toBe('processed');
      expect(doc?.eventType).toBe('payment_intent.succeeded');
    });
  });

  // ═════════════════ Subscription lifecycle via webhook ════════════════
  describe('Webhook subscription lifecycle', () => {
    it('activates Premium and records the payment after a verified checkout (200)', async () => {
      const payload = eventPayload(
        'checkout.session.completed',
        checkoutSessionObject(ids.webhook),
      );
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.duplicate).toBe(false);
      expect(res.body.data.handled).toBe(true);
      // Event id stays distinct from the Checkout Session id in the response.
      expect(res.body.data.stripeEventId).toBe(payload.id);

      const user = await getUsersCollection().findOne({ _id: ids.webhook });
      expect(user?.subscriptionPlan).toBe('premium');
      expect(user?.subscriptionExpiresAt).toEqual(checkoutEnd);
      expect(user?.stripeSubscriptionId).toBe(stripeIds.wsSub);
      expect(user?.stripeCustomerId).toBe(stripeIds.ws);
      expect(user?.stripePendingCheckout).toBeUndefined();

      const txns = await getTransactionsCollection().find({ vendorId: ids.webhook }).toArray();
      expect(txns).toHaveLength(1);
      expect(txns[0]).toMatchObject({
        type: 'payment',
        paymentStatus: 'paid',
        amount: 6000,
        currency: 'usd',
        stripeSessionId: wsSessionId,
        stripeEventId: payload.id,
        stripeSubscriptionId: stripeIds.wsSub,
        customerId: ids.webhook,
        vendorId: ids.webhook,
      });
      expect(txns[0]!.orderId).toBeUndefined();

      const status = await request(app)
        .get('/api/subscriptions')
        .set('Authorization', `Bearer ${await tokenFor(ids.webhook)}`);
      expect(status.status).toBe(200);
      expect(status.body.data.subscription.isActive).toBe(true);
    });

    it('ignores duplicate delivery of the same event id (200, no reprocessing)', async () => {
      const payload = eventPayload(
        'checkout.session.completed',
        checkoutSessionObject(ids.webhook),
        `evt_${runId}-dup-fixed`,
      );
      const first = await postWebhook(JSON.stringify(payload));
      expect(first.status).toBe(200);
      expect(first.body.data.duplicate).toBe(false);

      const second = await postWebhook(JSON.stringify(payload));
      expect(second.status).toBe(200);
      expect(second.body.data.duplicate).toBe(true);

      const txns = await getTransactionsCollection().countDocuments({ vendorId: ids.webhook });
      expect(txns).toBe(1);
    });

    it('does not create a second transaction when the session is resent under a new event id', async () => {
      const payload = eventPayload(
        'checkout.session.completed',
        checkoutSessionObject(ids.webhook),
      );
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);

      // Unique stripeSessionId keeps the charge single even with a new event id.
      const txns = await getTransactionsCollection().countDocuments({ vendorId: ids.webhook });
      expect(txns).toBe(1);
      const user = await getUsersCollection().findOne({ _id: ids.webhook });
      expect(user?.subscriptionPlan).toBe('premium');
    });

    it('records renewal payments and extends Premium on invoice.paid (cycle)', async () => {
      const renewalEnd = new Date(Math.floor((Date.now() + 60 * day) / 1000) * 1000);
      const payload = eventPayload('invoice.paid', {
        id: `in_${runId}_cycle1`,
        object: 'invoice',
        billing_reason: 'subscription_cycle',
        customer: stripeIds.ws,
        subscription: stripeIds.wsSub,
        amount_paid: 6000,
        currency: 'usd',
        period_start: Math.floor(checkoutEnd.getTime() / 1000),
        period_end: Math.floor(renewalEnd.getTime() / 1000),
        payment_intent: `pi_${runId}_cycle1`,
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.handled).toBe(true);

      const user = await getUsersCollection().findOne({ _id: ids.webhook });
      expect(user?.subscriptionPlan).toBe('premium');
      expect(user?.subscriptionExpiresAt).toEqual(renewalEnd);

      const count = await getTransactionsCollection().countDocuments({ vendorId: ids.webhook });
      expect(count).toBe(2);
      const renewal = await getTransactionsCollection().findOne({
        vendorId: ids.webhook,
        stripeSessionId: `in_${runId}_cycle1`,
      });
      expect(renewal).toMatchObject({
        type: 'payment',
        paymentStatus: 'paid',
        amount: 6000,
        stripeEventId: payload.id,
      });
      expect(renewal?.orderId).toBeUndefined();
    });

    it('does not duplicate renewal transactions when the invoice event is resent', async () => {
      const payload = eventPayload('invoice.paid', {
        id: `in_${runId}_cycle1`,
        object: 'invoice',
        billing_reason: 'subscription_cycle',
        customer: stripeIds.ws,
        subscription: stripeIds.wsSub,
        amount_paid: 6000,
        currency: 'usd',
        period_start: Math.floor(checkoutEnd.getTime() / 1000),
        period_end: Math.floor((Date.now() + 60 * day) / 1000),
        payment_intent: `pi_${runId}_cycle1`,
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);

      const txns = await getTransactionsCollection().countDocuments({ vendorId: ids.webhook });
      expect(txns).toBe(2);
    });

    it('activates Premium from invoice.paid when checkout.session.completed arrives later (race)', async () => {
      const invEnd = new Date(Math.floor((Date.now() + 30 * day) / 1000) * 1000);
      const payload = eventPayload('invoice.paid', {
        id: `in_${runId}_create1`,
        object: 'invoice',
        billing_reason: 'subscription_create',
        customer: stripeIds.inv,
        subscription: stripeIds.invSub,
        amount_paid: 6000,
        currency: 'usd',
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(invEnd.getTime() / 1000),
        payment_intent: `pi_${runId}_inv`,
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);

      const user = await getUsersCollection().findOne({ _id: ids.inv });
      expect(user?.subscriptionPlan).toBe('premium');
      expect(user?.subscriptionExpiresAt).toEqual(invEnd);
      expect(user?.stripeSubscriptionId).toBe(stripeIds.invSub);

      // The first charge's transaction is session-anchored — never recorded twice.
      const txns = await getTransactionsCollection().countDocuments({ vendorId: ids.inv });
      expect(txns).toBe(0);
    });

    it('stores identifiers and records the charge without activating when the subscription is not yet verified active', async () => {
      const payload = eventPayload(
        'checkout.session.completed',
        checkoutSessionObject(ids.noverify, {
          id: `cs_test_${runId}_nv`,
          customer: `cus_${runId}_nv`,
          subscription: stripeIds.nvSub, // not registered in the fake → lookup returns null
          payment_intent: `pi_${runId}_nv`,
        }),
      );
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.handled).toBe(true);

      const user = await getUsersCollection().findOne({ _id: ids.noverify });
      expect(user?.subscriptionPlan).toBeUndefined(); // no activation without verified payment
      expect(user?.stripeSubscriptionId).toBe(stripeIds.nvSub);

      const txns = await getTransactionsCollection().find({ vendorId: ids.noverify }).toArray();
      expect(txns).toHaveLength(1); // money moved → recorded, but Premium stays off
    });

    it('fails the event when the checkout session has no matching vendor', async () => {
      const payload = eventPayload(
        'checkout.session.completed',
        checkoutSessionObject(`uitest-${runId}-ghost-vendor`),
      );
      const res = await postWebhook(JSON.stringify(payload));
      // ApiError propagates its status (non-2xx → Stripe retries); the event
      // is marked failed either way.
      expect(res.status).toBe(404);
      const doc = await getWebhookEventsCollection().findOne({ stripeEventId: payload.id });
      expect(doc?.status).toBe('failed');
    });

    it('grants the seven-day grace period instead of downgrading on invoice.payment_failed', async () => {
      // Simulate a renewal that just failed with the current period about to lapse.
      await getUsersCollection().updateOne(
        { _id: ids.webhook },
        { $set: { subscriptionExpiresAt: new Date(Date.now() + 3_600_000) } },
      );

      const payload = eventPayload('invoice.payment_failed', {
        id: `in_${runId}_failed1`,
        object: 'invoice',
        billing_reason: 'subscription_cycle',
        customer: stripeIds.ws,
        subscription: stripeIds.wsSub,
        amount_paid: 0,
        currency: 'usd',
        payment_failure_message: 'Your card was declined.',
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.handled).toBe(true);

      const user = await getUsersCollection().findOne({ _id: ids.webhook });
      // NOT downgraded immediately — premium is retained for the grace period.
      expect(user?.subscriptionPlan).toBe('premium');
      const graceExpiry = new Date(user?.subscriptionExpiresAt ?? 0).getTime();
      expect(graceExpiry).toBeGreaterThanOrEqual(Date.now() + 6.9 * day);
    });

    it('ignores payment failures from vendors without active Premium', async () => {
      const payload = eventPayload('invoice.payment_failed', {
        id: `in_${runId}_failed_free`,
        object: 'invoice',
        billing_reason: 'subscription_cycle',
        customer: stripeIds.free,
        subscription: `sub_${runId}_free`,
        amount_paid: 0,
        currency: 'usd',
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.handled).toBe(false);

      const user = await getUsersCollection().findOne({ _id: ids.freeFail });
      expect(user?.subscriptionPlan).not.toBe('premium');
    });

    it('synchronizes subscription identifiers and expiry from customer.subscription.updated', async () => {
      const syncEnd = new Date(Math.floor((Date.now() + 40 * day) / 1000) * 1000);
      const payload = eventPayload('customer.subscription.updated', {
        id: stripeIds.syncSub,
        object: 'subscription',
        customer: stripeIds.sync,
        metadata: { vendorId: ids.sync, kind: 'vendor_premium' },
        status: 'active',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(syncEnd.getTime() / 1000),
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.handled).toBe(true);

      const user = await getUsersCollection().findOne({ _id: ids.sync });
      expect(user?.subscriptionPlan).toBe('premium');
      expect(user?.subscriptionExpiresAt).toEqual(syncEnd); // advanced from +5d to +40d
      expect(user?.stripeSubscriptionId).toBe(stripeIds.syncSub);
    });

    it('does not shorten a longer Premium period on a mid-period payment failure', async () => {
      const before = await getUsersCollection().findOne({ _id: ids.sync });
      const payload = eventPayload('invoice.payment_failed', {
        id: `in_${runId}_failed_sync`,
        object: 'invoice',
        billing_reason: 'subscription_cycle',
        customer: stripeIds.sync,
        subscription: stripeIds.syncSub,
        amount_paid: 0,
        currency: 'usd',
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);

      const after = await getUsersCollection().findOne({ _id: ids.sync });
      expect(after?.subscriptionPlan).toBe('premium');
      expect(after?.subscriptionExpiresAt).toEqual(before?.subscriptionExpiresAt);
    });

    it('clears pending checkout bookkeeping on checkout.session.expired', async () => {
      const payload = eventPayload('checkout.session.expired', {
        id: expiredSessionId,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: ids.expireme,
        metadata: { vendorId: ids.expireme, kind: 'vendor_premium' },
        payment_status: 'unpaid',
        amount_total: 6000,
        currency: 'usd',
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.handled).toBe(true);

      const user = await getUsersCollection().findOne({ _id: ids.expireme });
      expect(user?.stripePendingCheckout).toBeUndefined();
    });

    it('downgrades the vendor on customer.subscription.deleted (idempotent)', async () => {
      const payload = eventPayload('customer.subscription.deleted', {
        id: stripeIds.wsSub,
        object: 'subscription',
        customer: stripeIds.ws,
        metadata: { vendorId: ids.webhook, kind: 'vendor_premium' },
        status: 'canceled',
        current_period_end: Math.floor(Date.now() / 1000),
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.handled).toBe(true);

      const user = await getUsersCollection().findOne({ _id: ids.webhook });
      expect(user?.subscriptionPlan).toBe('free');
      expect(user?.subscriptionExpiresAt).toBeNull();

      // A second delivery of the same end-state is a no-op.
      const again = await postWebhook(JSON.stringify(payload));
      expect(again.status).toBe(200);
      const after = await getUsersCollection().findOne({ _id: ids.webhook });
      expect(after?.subscriptionPlan).toBe('free');
    });
  });

  describe('Webhook event ledger compatibility', () => {
    it('stores eventType for new processed events', async () => {
      const payload = eventPayload('checkout.session.expired', {
        id: `cs_test_${runId}_compat_new`,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: ids.nosub,
        metadata: { vendorId: ids.nosub, kind: 'vendor_premium' },
        payment_status: 'unpaid',
        amount_total: 6000,
        currency: 'usd',
      });
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      const doc = await getWebhookEventsCollection().findOne({ stripeEventId: payload.id });
      expect(doc?.status).toBe('processed');
      expect(doc?.eventType).toBe('checkout.session.expired');
    });

    it('treats a legacy processed event without eventType as a duplicate (compat)', async () => {
      const eventId = `evt_${runId}-legacy-processed`;
      await getWebhookEventsCollection().insertOne({
        stripeEventId: eventId,
        status: 'processed',
        receivedAt: new Date(),
        processedAt: new Date(),
      } as never);
      const payload = eventPayload(
        'payment_intent.succeeded',
        { id: `pi_${runId}_legacy` },
        eventId,
      );
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.duplicate).toBe(true);
      const doc = await getWebhookEventsCollection().findOne({ stripeEventId: eventId });
      expect(doc?.status).toBe('processed');
      expect(doc?.eventType).toBeUndefined();
    });

    it('reclaims and processes a legacy failed event without eventType (compat)', async () => {
      const eventId = `evt_${runId}-legacy-failed`;
      await getWebhookEventsCollection().insertOne({
        stripeEventId: eventId,
        status: 'failed',
        receivedAt: new Date(),
        lastError: 'previous failure',
      } as never);
      const payload = eventPayload(
        'customer.subscription.updated',
        {
          id: `sub_${runId}_legacy_unknown`,
          object: 'subscription',
          customer: `cus_${runId}_legacy_unknown`,
          status: 'active',
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor((Date.now() + 30 * day) / 1000),
        },
        eventId,
      );
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(200);
      expect(res.body.data.duplicate).toBe(false);
      const doc = await getWebhookEventsCollection().findOne({ stripeEventId: eventId });
      expect(doc?.status).toBe('processed');
      expect(doc?.eventType).toBe('customer.subscription.updated');
      expect(doc?.processedAt).toBeInstanceOf(Date);
    });
  });

  // ═════════════════ Status & cancellation endpoints ══════════════════
  describe('Subscription status & cancellation', () => {
    it('GET status requires authentication (401)', async () => {
      const res = await request(app).get('/api/subscriptions');
      expect(res.status).toBe(401);
    });

    it('GET status is vendor-only (403 for customers)', async () => {
      const res = await request(app)
        .get('/api/subscriptions')
        .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`);
      expect(res.status).toBe(403);
    });

    it('GET status reports active Premium for a premium vendor', async () => {
      const res = await request(app)
        .get('/api/subscriptions')
        .set('Authorization', `Bearer ${await tokenFor(ids.premium)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.subscription).toMatchObject({ plan: 'premium', isActive: true });
      expect(res.body.data.subscription.stripeSubscriptionId).toBeNull();
    });

    it('GET status reports free for a vendor without a subscription', async () => {
      const res = await request(app)
        .get('/api/subscriptions')
        .set('Authorization', `Bearer ${await tokenFor(ids.nosub)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.subscription).toMatchObject({ plan: 'free', isActive: false });
    });

    it('cancel requires authentication (401)', async () => {
      const res = await request(app).post('/api/subscriptions/cancel').send({});
      expect(res.status).toBe(401);
    });

    it('cancel is vendor-only (403 for customers)', async () => {
      const res = await authedPost('/api/subscriptions/cancel', ids.cust1);
      expect(res.status).toBe(403);
    });

    it('cancel answers 409 when no Stripe subscription is attached', async () => {
      const res = await authedPost('/api/subscriptions/cancel', ids.nosub);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('No Stripe subscription');
    });

    it('cancel downgrades the vendor only after Stripe accepts (200)', async () => {
      const res = await authedPost('/api/subscriptions/cancel', ids.cancel);
      expect(res.status).toBe(200);
      expect(fake.cancelledSubscriptions).toContain(`sub_${runId}_cancel`);

      const user = await getUsersCollection().findOne({ _id: ids.cancel });
      expect(user?.subscriptionPlan).toBe('free');
      expect(user?.subscriptionExpiresAt).toBeNull();

      const status = await request(app)
        .get('/api/subscriptions')
        .set('Authorization', `Bearer ${await tokenFor(ids.cancel)}`);
      expect(status.body.data.subscription.isActive).toBe(false);
    });

    it('cancel answers 502 and keeps Premium when Stripe rejects the call', async () => {
      fake.failCancel = true;
      try {
        const res = await authedPost('/api/subscriptions/cancel', ids.cancelFail);
        expect(res.status).toBe(502);
      } finally {
        fake.failCancel = false;
      }
      const user = await getUsersCollection().findOne({ _id: ids.cancelFail });
      expect(user?.subscriptionPlan).toBe('premium'); // unchanged: Stripe never accepted
      expect(fake.cancelledSubscriptions).not.toContain(`sub_${runId}_cancelfail`);
    });
  });

  // ═══════════ Transaction rollback & safe retry ══════════════════════
  describe('Transaction rollback and failed-event retry', () => {
    it('rolls back the activation and marks the event failed when a write fails', async () => {
      const payload = eventPayload(
        'checkout.session.completed',
        checkoutSessionObject(ids.rollback, {
          id: `cs_test_${runId}_rb`,
          customer: `cus_${runId}_rb`,
          subscription: stripeIds.rbSub,
          payment_intent: `pi_${runId}_rb`,
        }),
        `evt_${runId}-rollback`,
      );

      failureControl.failNextTransactionInsert = true;
      const res = await postWebhook(JSON.stringify(payload));
      expect(res.status).toBe(500);
      expect(res.body.message).toBe('forced insertOne failure');

      // Both documents of the transaction were rolled back: no partial premium.
      const user = await getUsersCollection().findOne({ _id: ids.rollback });
      expect(user?.subscriptionPlan).toBeUndefined();
      expect(user?.stripeSubscriptionId).toBeUndefined();
      const txns = await getTransactionsCollection().countDocuments({ vendorId: ids.rollback });
      expect(txns).toBe(0);

      const doc = await getWebhookEventsCollection().findOne({ stripeEventId: payload.id });
      expect(doc?.status).toBe('failed');
      expect(doc?.lastError).toContain('forced insertOne failure');
    });

    it('re-claims the failed event on Stripe retry and completes it idempotently', async () => {
      // Same event id as the failed attempt above — this is Stripe's redelivery.
      const payload = eventPayload(
        'checkout.session.completed',
        checkoutSessionObject(ids.rollback, {
          id: `cs_test_${runId}_rb`,
          customer: `cus_${runId}_rb`,
          subscription: stripeIds.rbSub,
          payment_intent: `pi_${runId}_rb`,
        }),
        `evt_${runId}-rollback`,
      );

      const first = await postWebhook(JSON.stringify(payload));
      expect(first.status).toBe(200);
      expect(first.body.data.duplicate).toBe(false);

      const user = await getUsersCollection().findOne({ _id: ids.rollback });
      expect(user?.subscriptionPlan).toBe('premium');
      const txns = await getTransactionsCollection().countDocuments({ vendorId: ids.rollback });
      expect(txns).toBe(1);

      const doc = await getWebhookEventsCollection().findOne({ stripeEventId: payload.id });
      expect(doc?.status).toBe('processed');
      expect(doc?.processedAt).toBeInstanceOf(Date);

      // Redelivery after success changes nothing.
      const second = await postWebhook(JSON.stringify(payload));
      expect(second.body.data.duplicate).toBe(true);
      expect(await getTransactionsCollection().countDocuments({ vendorId: ids.rollback })).toBe(1);
    });
  });
});
