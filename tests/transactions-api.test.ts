import { createServer, type AddressInfo, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { Express } from 'express';
import { ObjectId } from 'mongodb';
import { connectDatabase, disconnectDatabase } from '../src/app/config/db.js';
import { getTransactionsCollection, getUsersCollection } from '../src/app/db/collections.js';
import { createRequireAuth } from '../src/app/auth/require-auth.js';
import { createApp } from '../src/create-app.js';
import type { BetterAuthUser } from '../src/app/auth/auth.types.js';
import type { Transaction } from '../src/app/types/transaction.types.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

describe('Admin Transactions API', () => {
  let jwksServer: Server;
  let app: Express;
  let keyPair: GeneratedKeyPair;

  const runId = randomUUID().slice(0, 8);
  const tokens = new Map<string, string>();

  const ids = {
    admin: `uitest-${runId}-tx-admin`,
    customer: `uitest-${runId}-tx-customer`,
    vendor: `uitest-${runId}-tx-vendor`,
  };

  const orderId = new ObjectId();
  const txIds = {
    orderPayment: new ObjectId(),
    subscriptionPayment: new ObjectId(),
    failedOrderPayment: new ObjectId(),
  };

  async function tokenFor(userId: string): Promise<string> {
    let token = tokens.get(userId);
    if (!token) {
      token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'transactions-api-test-key' })
        .setSubject(userId)
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .sign(keyPair.privateKey);
      tokens.set(userId, token);
    }
    return token;
  }

  beforeAll(async () => {
    await connectDatabase();

    keyPair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'transactions-api-test-key';
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
    app = createApp({ requireAuthMiddleware: requireAuth });

    const users: BetterAuthUser[] = [
      {
        _id: ids.admin,
        name: `UITEST-${runId} Tx Admin`,
        email: `uitest-${runId}.tx-admin@example.com`,
        emailVerified: true,
        role: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: ids.customer,
        name: `UITEST-${runId} Tx Customer`,
        email: `uitest-${runId}.tx-customer@example.com`,
        emailVerified: true,
        role: 'customer',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: ids.vendor,
        name: `UITEST-${runId} Tx Vendor`,
        email: `uitest-${runId}.tx-vendor@example.com`,
        emailVerified: true,
        role: 'vendor',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    await getUsersCollection().insertMany(users);

    const now = Date.now();
    const txDocs: Transaction[] = [
      {
        _id: txIds.orderPayment,
        orderId,
        customerId: ids.customer,
        vendorId: ids.vendor,
        type: 'payment',
        paymentStatus: 'paid',
        amount: 1500,
        currency: 'bdt',
        stripeSessionId: `uitest-tx-${runId}-cs-order`,
        stripePaymentIntentId: `uitest-tx-${runId}-pi-order`,
        paidAt: new Date(now - 60_000),
        createdAt: new Date(now - 60_000),
        updatedAt: new Date(now - 60_000),
      },
      {
        _id: txIds.subscriptionPayment,
        customerId: ids.vendor,
        vendorId: ids.vendor,
        type: 'payment',
        paymentStatus: 'paid',
        amount: 9900,
        currency: 'bdt',
        stripeSessionId: `uitest-tx-${runId}-cs-sub`,
        stripeSubscriptionId: `uitest-tx-${runId}-sub`,
        stripeEventId: `uitest-tx-${runId}-evt-sub`,
        paidAt: new Date(now - 30_000),
        createdAt: new Date(now - 30_000),
        updatedAt: new Date(now - 30_000),
      },
      {
        _id: txIds.failedOrderPayment,
        orderId: new ObjectId(),
        customerId: ids.customer,
        vendorId: ids.vendor,
        type: 'payment',
        paymentStatus: 'failed',
        amount: 500,
        currency: 'bdt',
        stripeSessionId: `uitest-tx-${runId}-cs-failed`,
        failureReason: 'Card declined',
        createdAt: new Date(now - 10_000),
        updatedAt: new Date(now - 10_000),
      },
    ];
    await getTransactionsCollection().insertMany(txDocs);
  });

  afterAll(async () => {
    await getTransactionsCollection().deleteMany({
      _id: { $in: Object.values(txIds) },
    });
    await getUsersCollection().deleteMany({
      _id: { $in: Object.values(ids) },
    });
    await disconnectDatabase();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  it('responds 401 without authentication', async () => {
    const res = await request(app).get('/api/transactions');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('responds 403 for non-admin users', async () => {
    const res = await request(app)
      .get('/api/transactions')
      .set('Authorization', `Bearer ${await tokenFor(ids.customer)}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('lists transactions for an admin with pagination and preserves context distinction', async () => {
    const res = await request(app)
      .get(
        `/api/transactions?search=uitest-tx-${runId}&page=1&limit=2&sortBy=createdAt&sortOrder=desc`,
      )
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Transactions retrieved');
    const { transactions, pagination } = res.body.data;
    expect(Array.isArray(transactions)).toBe(true);
    expect(transactions).toHaveLength(2);
    expect(pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });

    // newest first: failedOrderPayment, then subscriptionPayment
    expect(transactions[0].id).toBe(String(txIds.failedOrderPayment));
    expect(transactions[0].context).toBe('customer_order');
    expect(transactions[0].orderId).toBe(String(transactions[0].orderId));
    expect(transactions[0].paymentStatus).toBe('failed');
    expect(transactions[0].failureReason).toBe('Card declined');
    expect(transactions[0]).not.toHaveProperty('stripeSubscriptionId');

    expect(transactions[1].id).toBe(String(txIds.subscriptionPayment));
    expect(transactions[1].context).toBe('vendor_subscription');
    expect(transactions[1]).not.toHaveProperty('orderId');
    expect(transactions[1].stripeSubscriptionId).toBe(`uitest-tx-${runId}-sub`);
    expect(transactions[1].customer.id).toBe(ids.vendor);
    expect(transactions[1].vendor.id).toBe(ids.vendor);
    expect(transactions[1].vendor.name).toContain(`UITEST-${runId}`);

    // Whitelisted DTO: no unexpected internal fields
    expect(transactions[1]).not.toHaveProperty('_id');
  });

  it('returns the next page of results', async () => {
    const res = await request(app)
      .get(
        `/api/transactions?search=uitest-tx-${runId}&page=2&limit=2&sortBy=createdAt&sortOrder=desc`,
      )
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.transactions).toHaveLength(1);
    expect(res.body.data.transactions[0].id).toBe(String(txIds.orderPayment));
    expect(res.body.data.transactions[0].context).toBe('customer_order');
    expect(res.body.data.transactions[0].orderId).toBe(String(orderId));
    expect(res.body.data.transactions[0].customer.email).toBe(
      `uitest-${runId}.tx-customer@example.com`,
    );
    expect(res.body.data.pagination).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('filters by status and type', async () => {
    const res = await request(app)
      .get(`/api/transactions?search=uitest-tx-${runId}&status=failed&type=payment`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.transactions).toHaveLength(1);
    expect(res.body.data.transactions[0].id).toBe(String(txIds.failedOrderPayment));
    expect(res.body.data.transactions[0].paymentStatus).toBe('failed');
  });

  it('rejects invalid query parameters with 400', async () => {
    const res = await request(app)
      .get(
        '/api/transactions?page=0&limit=101&sortBy=nope&status=unknown&type=charge&from=bad-date',
      )
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Validation failed');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('rejects from later than to with 400', async () => {
    const res = await request(app)
      .get('/api/transactions?from=2026-01-10T00:00:00.000Z&to=2026-01-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });

  it('returns empty results when no transactions match', async () => {
    const res = await request(app)
      .get('/api/transactions?search=uitest-tx-does-not-exist-zzzz')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.transactions).toEqual([]);
    expect(res.body.data.pagination.total).toBe(0);
    expect(res.body.data.pagination.totalPages).toBe(1);
  });
});
