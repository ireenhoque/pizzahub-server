import { createServer, type AddressInfo, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { Express } from 'express';
import { ObjectId } from 'mongodb';
import { connectDatabase, disconnectDatabase } from '../src/app/config/db.js';
import {
  getMenuItemsCollection,
  getOrdersCollection,
  getTransactionsCollection,
  getUsersCollection,
} from '../src/app/db/collections.js';
import { createRequireAuth } from '../src/app/auth/require-auth.js';
import { createApp } from '../src/create-app.js';
import { adminService } from '../src/app/modules/admin/admin.service.js';
import type { MenuItem } from '../src/app/types/menuItem.types.js';
import type { Order } from '../src/app/types/order.types.js';
import type { Transaction } from '../src/app/types/transaction.types.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';
type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

describe('Admin overview API', () => {
  let jwksServer: Server;
  let app: Express;
  let keyPair: GeneratedKeyPair;
  let ids: { admin: string; customer: string; vendor: string };
  let baseline: Awaited<ReturnType<typeof adminService.getOverview>>;

  const runId = randomUUID().slice(0, 8);
  const signedIn = new Map<string, string>();

  async function tokenFor(userId: string): Promise<string> {
    let token = signedIn.get(userId);
    if (!token) {
      token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'admin-overview-test-key' })
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

  beforeAll(async () => {
    await connectDatabase();
    // Captured before seeding so parallel suites cannot invalidate deltas.
    baseline = await adminService.getOverview();

    keyPair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'admin-overview-test-key';
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

    ids = {
      admin: `uitest-${runId}-overview-admin`,
      customer: `uitest-${runId}-overview-customer`,
      vendor: `uitest-${runId}-overview-vendor`,
    };
    const now = new Date();

    await getUsersCollection().insertMany([
      {
        _id: ids.admin,
        name: 'UITEST admin',
        email: `${ids.admin}@example.com`,
        emailVerified: true,
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: ids.customer,
        name: 'UITEST customer',
        email: `${ids.customer}@example.com`,
        emailVerified: true,
        role: 'customer',
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: ids.vendor,
        name: 'UITEST vendor',
        email: `${ids.vendor}@example.com`,
        emailVerified: true,
        role: ['vendor'],
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const menuDoc = (name: string, overrides: Partial<Omit<MenuItem, '_id'>> = {}) => ({
      vendorId: ids.vendor,
      name: `UITEST-${runId} ${name}`,
      description: 'Admin overview test item',
      tags: [],
      category: 'pizza' as const,
      price: 100,
      currency: 'BDT',
      location: 'Dhanmondi, Dhaka',
      imageUrl: 'https://i.ibb.co/test/seeded.png',
      status: 'active' as const,
      isAvailable: true,
      ratingAvg: 0,
      ratingCount: 0,
      // Keep fixtures older than the main CRUD suite's pagination fixtures.
      createdAt: new Date(now.getTime() - 200_000),
      updatedAt: new Date(now.getTime() - 200_000),
      ...overrides,
    });
    await getMenuItemsCollection().insertMany([
      menuDoc('Overview active 1'),
      menuDoc('Overview active 2'),
      menuDoc('Overview pending', { status: 'pending', isAvailable: false }),
    ]);

    const order: Omit<Order, '_id'> = {
      customerId: ids.customer,
      vendorId: ids.vendor,
      lineItems: [{ menuItemId: new ObjectId(), name: 'Test', unitPrice: 6000, quantity: 1 }],
      status: 'placed',
      subtotal: 6000,
      deliveryFee: 0,
      totalAmount: 6000,
      currency: 'BDT',
      deliveryAddress: 'Test address',
      contactPhone: '01700000000',
      createdAt: now,
      updatedAt: now,
    };
    await getOrdersCollection().insertOne(order as Order);

    const transaction = (paymentStatus: Transaction['paymentStatus'], suffix: string) => ({
      _id: new ObjectId(),
      customerId: ids.customer,
      vendorId: ids.vendor,
      type: 'payment' as const,
      paymentStatus,
      amount: 6000,
      currency: 'BDT',
      stripeSessionId: `cs_${runId}_${suffix}`,
      paidAt: paymentStatus === 'paid' ? now : undefined,
      failureReason: paymentStatus === 'failed' ? 'Test failure' : undefined,
      createdAt: now,
      updatedAt: now,
    });
    await getTransactionsCollection().insertMany([
      transaction('paid', 'paid'),
      transaction('failed', 'failed'),
    ]);
  });

  afterAll(async () => {
    const seededIds = Object.values(ids);
    await getMenuItemsCollection().deleteMany({ vendorId: { $in: seededIds } });
    await getOrdersCollection().deleteMany({ customerId: ids.customer });
    await getTransactionsCollection().deleteMany({ vendorId: { $in: seededIds } });
    await getUsersCollection().deleteMany({ _id: { $in: seededIds } });
    await disconnectDatabase();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  it('protects the overview with authentication and the admin role', async () => {
    expect((await request(app).get('/api/admin/overview')).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/admin/overview')
          .set('Authorization', `Bearer ${await tokenFor(ids.customer)}`)
      ).status,
    ).toBe(403);
  });

  it('returns safe summary counts based on existing records', async () => {
    const res = await request(app)
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const overview = res.body.data;

    expect(overview.users.total).toBeGreaterThanOrEqual(baseline.users.total + 3);
    expect(overview.users.customers).toBeGreaterThanOrEqual(baseline.users.customers + 1);
    expect(overview.users.vendors).toBeGreaterThanOrEqual(baseline.users.vendors + 1);
    expect(overview.users.admins).toBeGreaterThanOrEqual(baseline.users.admins + 1);

    expect(overview.menuItems.total).toBeGreaterThanOrEqual(baseline.menuItems.total + 3);
    expect(overview.menuItems.active).toBeGreaterThanOrEqual(baseline.menuItems.active + 2);
    expect(overview.menuItems.pending).toBeGreaterThanOrEqual(baseline.menuItems.pending + 1);

    expect(overview.orders.total).toBeGreaterThanOrEqual(baseline.orders.total + 1);
    expect(overview.orders.placed).toBeGreaterThanOrEqual(baseline.orders.placed + 1);

    expect(overview.transactions.count).toBeGreaterThanOrEqual(baseline.transactions.count + 2);
    expect(overview.transactions.paidCount).toBeGreaterThanOrEqual(
      baseline.transactions.paidCount + 1,
    );
    expect(overview.transactions.paidAmount).toBeGreaterThanOrEqual(
      baseline.transactions.paidAmount + 6000,
    );
    expect(typeof overview.transactions.currency).toBe('string');
  });
});
