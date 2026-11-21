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
  getUsersCollection,
} from '../src/app/db/collections.js';
import { createRequireAuth } from '../src/app/auth/require-auth.js';
import { createApp } from '../src/create-app.js';
import { orderService } from '../src/app/modules/orders/order.service.js';
import type { AuthenticatedUser } from '../src/app/auth/auth.types.js';
import type { UserRole } from '../src/app/types/common.types.js';
import type { MenuItem } from '../src/app/types/menuItem.types.js';
import type { Order } from '../src/app/types/order.types.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/**
 * Regression coverage for the order-module fixes:
 * - GET /api/orders/:id requires authentication (PII was public via optionalAuth)
 * - ownership/admin authorization on order reads and status changes (ApiError → 403, not 500)
 * - DB-derived customer role gate on order creation (route + service)
 * - blocked/banned rejection via isUserBlocked (the old `customer.blocked` check was dead code)
 * - single-vendor cart enforcement (vendorId is no longer taken from an arbitrary line item)
 * - orderId/menuItemId validation (no BSON errors escaping as 500s) and bounded lineItems
 * - legal order status transitions (terminal states stay terminal)
 */
describe('Order APIs (authentication, authorization, validation, transitions)', () => {
  let jwksServer: Server;
  let app: Express;
  let keyPair: GeneratedKeyPair;

  const runId = randomUUID().slice(0, 8);
  const signedIn = new Map<string, string>();

  const ids = {
    cust1: `uitest-${runId}-ord-cust1`,
    cust2: `uitest-${runId}-ord-cust2`,
    vendA: `uitest-${runId}-ord-va`,
    vendB: `uitest-${runId}-ord-vb`,
    admin: `uitest-${runId}-ord-admin`,
    blocked: `uitest-${runId}-ord-blocked`,
    banned: `uitest-${runId}-ord-banned`,
  };

  let itemA1 = '';
  let itemA2 = '';
  let itemB1 = '';
  let itemUnavailable = '';
  let orderPlaced = '';
  let orderDelivered = '';
  let orderCancelled = '';

  async function tokenFor(userId: string): Promise<string> {
    let token = signedIn.get(userId);
    if (!token) {
      token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'orders-test-key' })
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

  function authCtx(userId: string, roles: UserRole[]): AuthenticatedUser {
    return {
      userId,
      role: roles[0]!,
      roles,
      issuer: ISSUER,
      audience: AUDIENCE,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  beforeAll(async () => {
    await connectDatabase();

    keyPair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'orders-test-key';
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

    // ── Seed users ──────────────────────────────────────────────────────
    await getUsersCollection().insertMany(
      [
        { _id: ids.cust1, role: 'customer' },
        { _id: ids.cust2, role: 'customer' },
        { _id: ids.vendA, role: 'vendor' },
        { _id: ids.vendB, role: 'vendor' },
        { _id: ids.admin, role: 'admin' },
        { _id: ids.blocked, role: 'customer', isBlocked: true },
        { _id: ids.banned, role: 'customer', banned: true },
      ].map((user) => ({
        _id: user._id,
        name: `UITEST-${runId} ${user.role}`,
        email: `${user._id}@example.com`,
        emailVerified: true,
        role: user.role,
        isBlocked: user.isBlocked ?? false,
        banned: user.banned ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );

    // ── Seed menu items (two vendors) ───────────────────────────────────
    function menuItem(vendorId: string, name: string, price: number): Omit<MenuItem, '_id'> {
      const now = new Date();
      return {
        vendorId,
        name,
        description: 'Seeded order test item used by tests',
        tags: [],
        category: 'pizza',
        price,
        currency: 'BDT',
        location: 'Dhanmondi, Dhaka',
        imageUrl: 'https://i.ibb.co/test/seeded.png',
        status: 'active',
        isAvailable: true,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    }

    const inserted = await getMenuItemsCollection().insertMany([
      menuItem(ids.vendA, `UITEST-${runId} Item A1`, 10),
      menuItem(ids.vendA, `UITEST-${runId} Item A2`, 15),
      menuItem(ids.vendB, `UITEST-${runId} Item B1`, 20),
      { ...menuItem(ids.vendA, `UITEST-${runId} Item Unavailable`, 5), isAvailable: false },
    ]);
    itemA1 = String(inserted.insertedIds[0]);
    itemA2 = String(inserted.insertedIds[1]);
    itemB1 = String(inserted.insertedIds[2]);
    itemUnavailable = String(inserted.insertedIds[3]);

    // ── Seed orders in three lifecycle states ───────────────────────────
    function seedOrder(
      status: Order['status'],
      menuItemId: string,
      price: number,
    ): Omit<Order, '_id'> {
      const now = new Date();
      return {
        customerId: ids.cust1,
        vendorId: ids.vendA,
        lineItems: [
          { menuItemId: new ObjectId(menuItemId), name: 'Seeded', unitPrice: price, quantity: 1 },
        ],
        status,
        subtotal: price,
        deliveryFee: 0,
        totalAmount: price,
        currency: 'USD',
        deliveryAddress: '12 Regression Street, Dhaka',
        contactPhone: '+8801700000000',
        createdAt: now,
        updatedAt: now,
      };
    }

    const orderInsert = await getOrdersCollection().insertMany([
      seedOrder('placed', itemA1, 10),
      seedOrder('delivered', itemA2, 15),
      seedOrder('cancelled', itemA1, 10),
    ]);
    orderPlaced = String(orderInsert.insertedIds[0]);
    orderDelivered = String(orderInsert.insertedIds[1]);
    orderCancelled = String(orderInsert.insertedIds[2]);
  });

  afterAll(async () => {
    const seededUserIds = Object.values(ids);
    await getOrdersCollection().deleteMany({ customerId: { $in: [ids.cust1, ids.cust2] } });
    await getMenuItemsCollection().deleteMany({ vendorId: { $in: [ids.vendA, ids.vendB] } });
    await getUsersCollection().deleteMany({ _id: { $in: seededUserIds } });
    await disconnectDatabase();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  // ── GET /api/orders/:id — PII exposure fix ────────────────────────────

  it('rejects anonymous access to order details with 401 (order PII is never public)', async () => {
    const res = await request(app).get(`/api/orders/${orderPlaced}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects a malformed order id with 400 instead of a 500', async () => {
    const res = await request(app)
      .get('/api/orders/not-an-objectid')
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`);
    expect(res.status).toBe(400);
  });

  it('lets the owning customer read their order', async () => {
    const res = await request(app)
      .get(`/api/orders/${orderPlaced}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.order._id).toBe(orderPlaced);
    expect(res.body.data.order.customerId).toBe(ids.cust1);
  });

  it('forbids another customer from reading someone else’s order with 403', async () => {
    const res = await request(app)
      .get(`/api/orders/${orderPlaced}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.cust2)}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('allows the fulfilling vendor but forbids an unrelated vendor', async () => {
    const owner = await request(app)
      .get(`/api/orders/${orderPlaced}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`);
    expect(owner.status).toBe(200);

    const other = await request(app)
      .get(`/api/orders/${orderPlaced}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendB)}`);
    expect(other.status).toBe(403);
  });

  it('allows an admin to read any order', async () => {
    const res = await request(app)
      .get(`/api/orders/${orderPlaced}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.order._id).toBe(orderPlaced);
  });

  // ── POST /api/orders — role, blocked, validation and vendor fixes ─────

  it('rejects order creation from a vendor account with 403', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`)
      .send({
        lineItems: [{ menuItemId: itemA1, quantity: 1 }],
        deliveryAddress: '5 Vendor Lane, Dhaka',
      });

    expect(res.status).toBe(403);
  });

  it('rejects order creation from a blocked account with 403', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.blocked)}`)
      .send({
        lineItems: [{ menuItemId: itemA1, quantity: 1 }],
        deliveryAddress: '9 Blocked Road, Dhaka',
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Your account has been blocked');
  });

  it('creates an order with a single vendor and correct totals', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.cust2)}`)
      .send({
        lineItems: [{ menuItemId: itemB1, quantity: 2 }],
        deliveryAddress: '21 Happy Street, Dhaka',
      });

    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.status).toBe('placed');
    expect(order.vendorId).toBe(ids.vendB);
    expect(order.subtotal).toBe(40); // 20 × 2
    expect(order.totalAmount).toBe(order.subtotal + order.deliveryFee);
    expect(order.lineItems).toHaveLength(1);
  });

  it('allows a repeat order even when an earlier order for the item is still in flight', async () => {
    // cust1 already has a seeded `placed` order containing itemA1. That must
    // not prevent a legitimate second order for the same available item.
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`)
      .send({
        lineItems: [{ menuItemId: itemA1, quantity: 2 }],
        deliveryAddress: '14 Repeat Order Street, Dhaka',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.order.status).toBe('placed');
    expect(res.body.data.order.lineItems).toHaveLength(1);
    expect(res.body.data.order.lineItems[0].menuItemId).toBe(itemA1);
    expect(res.body.data.order.subtotal).toBe(20);
  });

  it('still rejects unavailable menu items at order creation', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`)
      .send({
        lineItems: [{ menuItemId: itemUnavailable, quantity: 1 }],
        deliveryAddress: '15 Unavailable Lane, Dhaka',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Menu item is not available for ordering');
  });

  it('rejects a cart that mixes vendors with 400 (vendorId is never guessed)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`)
      .send({
        lineItems: [
          { menuItemId: itemA1, quantity: 1 },
          { menuItemId: itemB1, quantity: 1 },
        ],
        deliveryAddress: '8 Mixed Avenue, Dhaka',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('same vendor');
  });

  it('rejects a non-ObjectId menuItemId with a 400 validation error (not a 500)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`)
      .send({
        lineItems: [{ menuItemId: 'definitely-not-an-id', quantity: 1 }],
        deliveryAddress: '3 Invalid Item Way, Dhaka',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.details.some((d: { field: string }) => d.field.startsWith('lineItems'))).toBe(
      true,
    );
  });

  it('rejects an unbounded lineItems payload with 400', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`)
      .send({
        lineItems: Array.from({ length: 51 }, () => ({ menuItemId: itemA1, quantity: 1 })),
        deliveryAddress: '4 Too Many Boulevard, Dhaka',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });

  // ── Service-level gates (blocked/banned/role read from MongoDB) ───────

  it('refuses order creation for a blocked account even at the service level', async () => {
    await expect(
      orderService.createOrder(authCtx(ids.blocked, ['customer']), {
        lineItems: [{ menuItemId: itemA1, quantity: 1 }],
        deliveryAddress: '1 Service Blocked Lane, Dhaka',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'User is blocked and cannot place orders',
    });
  });

  it('refuses order creation for a banned (Better Auth admin plugin) account', async () => {
    await expect(
      orderService.createOrder(authCtx(ids.banned, ['customer']), {
        lineItems: [{ menuItemId: itemA1, quantity: 1 }],
        deliveryAddress: '2 Service Banned Lane, Dhaka',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'User is blocked and cannot place orders',
    });
  });

  it('refuses order creation from a non-customer role at the service level', async () => {
    await expect(
      orderService.createOrder(authCtx(ids.vendA, ['vendor']), {
        lineItems: [{ menuItemId: itemA1, quantity: 1 }],
        deliveryAddress: '7 Service Vendor Lane, Dhaka',
      }),
    ).rejects.toMatchObject({ statusCode: 403, message: 'Only customers can place orders' });
  });

  // ── PATCH /api/orders/:id/status — authorization + transitions ────────

  it('lets the order vendor advance placed → preparing', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderPlaced}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`)
      .send({ status: 'preparing' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('preparing');
  });

  it('treats a repeated same-status update as an idempotent no-op', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderPlaced}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`)
      .send({ status: 'preparing' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('preparing');
  });

  it('rejects leaving a terminal state (delivered → preparing) with 409', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderDelivered}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`)
      .send({ status: 'preparing' });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Invalid status transition');
  });

  it('rejects resurrecting a cancelled order (cancelled → placed) with 409', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderCancelled}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`)
      .send({ status: 'placed' });

    expect(res.status).toBe(409);
  });

  it('forbids the ordering customer from changing status with 403 (ApiError, not 500)', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderPlaced}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.cust1)}`)
      .send({ status: 'ready' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('forbids a vendor who does not fulfil the order with 403', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderPlaced}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendB)}`)
      .send({ status: 'ready' });

    expect(res.status).toBe(403);
  });

  it('lets an admin advance preparing → ready', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderPlaced}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`)
      .send({ status: 'ready' });

    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('ready');
  });

  it('rejects an unknown status value with 400 validation', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderPlaced}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`)
      .send({ status: 'teleported' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });

  it('rejects a malformed order id on status update with 400', async () => {
    const res = await request(app)
      .patch('/api/orders/nope/status')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendA)}`)
      .send({ status: 'ready' });

    expect(res.status).toBe(400);
  });
});
