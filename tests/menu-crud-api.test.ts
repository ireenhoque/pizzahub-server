import { createServer, type AddressInfo, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { Express } from 'express';
import { ObjectId } from 'mongodb';
import { connectDatabase, disconnectDatabase } from '../src/app/config/db.js';
import { getMenuItemsCollection, getUsersCollection } from '../src/app/db/collections.js';
import { createRequireAuth } from '../src/app/auth/require-auth.js';
import { createApp } from '../src/create-app.js';
import {
  enforceExpiredPremiumMenuLimits,
  enforceFreePlanActiveLimit,
} from '../src/app/modules/menuItems/free-plan-limit.js';
import type { MenuItem } from '../src/app/types/menuItem.types.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/** Minimal valid MenuItem factory for seeding. */
function menuItem(
  vendorId: string,
  name: string,
  overrides: Partial<Omit<MenuItem, '_id' | 'vendorId'>> = {},
): Omit<MenuItem, '_id'> {
  const now = new Date();
  return {
    vendorId,
    name,
    description: 'Seeded CRUD test item used by tests',
    tags: [],
    category: 'pizza',
    price: 10,
    currency: 'BDT',
    location: 'Dhanmondi, Dhaka',
    imageUrl: 'https://i.ibb.co/test/seeded.png',
    status: 'active',
    isAvailable: true,
    ratingAvg: 0,
    ratingCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Menu item read/update/delete APIs (public, vendor, admin)', () => {
  let jwksServer: Server;
  let app: Express;
  let keyPair: GeneratedKeyPair;
  let ids: Record<string, string>;
  let itemIds: Record<string, string>;

  const runId = randomUUID().slice(0, 8);

  const signedIn = new Map<string, string>();

  async function tokenFor(userId: string): Promise<string> {
    let token = signedIn.get(userId);
    if (!token) {
      token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'menu-crud-test-key' })
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

    keyPair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'menu-crud-test-key';
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

    // No uploadImage injection needed - this suite performs no creation.
    app = createApp({ requireAuthMiddleware: requireAuth });

    // ── Seed users ──────────────────────────────────────────────────────
    ids = {
      vendorA: `uitest-${runId}-crud-va`,
      vendorB: `uitest-${runId}-crud-vb`,
      customer: `uitest-${runId}-crud-cust`,
      admin: `uitest-${runId}-crud-admin`,
      quotaFree: `uitest-${runId}-crud-qfree`,
      quotaPremium: `uitest-${runId}-crud-qpremium`,
      quotaExpired: `uitest-${runId}-crud-qexpired`,
      quotaRace: `uitest-${runId}-crud-qrace`,
      quotaSweep: `uitest-${runId}-crud-qsweep`,
      priorityPremium: `uitest-${runId}-crud-prpremium`,
      priorityFree: `uitest-${runId}-crud-prfree`,
      priorityExpired: `uitest-${runId}-crud-prerexpired`,
    };

    await getUsersCollection().insertMany(
      [
        { _id: ids.vendorA, role: 'vendor' },
        { _id: ids.vendorB, role: 'vendor' },
        { _id: ids.customer, role: 'customer' },
        { _id: ids.admin, role: 'admin' },
        { _id: ids.quotaFree, role: 'vendor' },
        {
          _id: ids.quotaPremium,
          role: 'vendor',
          subscriptionPlan: 'premium',
          subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          _id: ids.quotaExpired,
          role: 'vendor',
          subscriptionPlan: 'premium',
          subscriptionExpiresAt: new Date(Date.now() - 86_400_000),
        },
        { _id: ids.quotaRace, role: 'vendor' },
        {
          _id: ids.quotaSweep,
          role: 'vendor',
          subscriptionPlan: 'premium',
          subscriptionExpiresAt: new Date(Date.now() - 86_400_000),
        },
        {
          _id: ids.priorityPremium,
          role: 'vendor',
          subscriptionPlan: 'premium',
          subscriptionExpiresAt: new Date(Date.now() + 86_400_000),
        },
        { _id: ids.priorityFree, role: 'vendor' },
        {
          _id: ids.priorityExpired,
          role: 'vendor',
          subscriptionPlan: 'premium',
          subscriptionExpiresAt: new Date(Date.now() - 86_400_000),
        },
      ].map((user) => ({
        ...user,
        name: `UITEST-${runId} ${user.role}`,
        email: `${user._id}@example.com`,
        emailVerified: true,
        role: user.role,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );

    // ── Seed menu items ─────────────────────────────────────────────────
    const docs = [
      menuItem(ids.vendorA, `UITEST-${runId} Active A`, { category: 'pizza' }),
      menuItem(ids.vendorA, `UITEST-${runId} Pending A`, {
        status: 'pending',
        isAvailable: false,
      }),
      menuItem(ids.vendorA, `UITEST-${runId} Pending A2`, {
        status: 'pending',
        isAvailable: false,
      }),
      menuItem(ids.vendorA, `UITEST-${runId} Rejected A`, {
        status: 'rejected',
        isAvailable: false,
      }),
      menuItem(ids.vendorB, `UITEST-${runId} Active B`, {
        category: 'drinks',
        price: 45,
        location: 'Banani, Dhaka',
      }),
    ];

    // Dedicated vendors for the free-plan invariant tests. These are older
    // than the five legacy items above so existing pagination assertions stay
    // scoped to those original records. `createdAt` ordering decides which
    // active items are preserved on downgrade.
    const quotaBase = Date.now() - 100_000;
    const quotaActive = (vendorId: string, label: string, index: number) =>
      menuItem(vendorId, `UITEST-${runId} ${label} Active ${index}`, {
        createdAt: new Date(quotaBase + index * 1000),
      });
    const quotaPending = (vendorId: string, label: string, index: number) =>
      menuItem(vendorId, `UITEST-${runId} ${label} Pending ${index}`, {
        status: 'pending',
        isAvailable: false,
        createdAt: new Date(quotaBase + 10_000 + index * 1000),
      });

    docs.push(
      ...Array.from({ length: 3 }, (_, i) => quotaActive(ids.quotaFree, 'Free', i)),
      quotaPending(ids.quotaFree, 'Free', 0),
      ...Array.from({ length: 5 }, (_, i) => quotaActive(ids.quotaPremium, 'Premium', i)),
      quotaPending(ids.quotaPremium, 'Premium', 0),
      ...Array.from({ length: 3 }, (_, i) => quotaActive(ids.quotaExpired, 'Expired', i)),
      quotaPending(ids.quotaExpired, 'Expired', 0),
      ...Array.from({ length: 2 }, (_, i) => quotaActive(ids.quotaRace, 'Race', i)),
      quotaPending(ids.quotaRace, 'Race', 0),
      quotaPending(ids.quotaRace, 'Race', 1),
      ...Array.from({ length: 5 }, (_, i) => quotaActive(ids.quotaSweep, 'Sweep', i)),
    );

    // Dedicated items for the storefront premium-priority query. Their unique
    // location keeps the ordering assertions scoped to this suite.
    const priorityLocation = `Priority-${runId}`;
    const priorityBase = quotaBase - 20_000;
    const priorityItem = (vendorId: string, label: string, price: number) =>
      menuItem(vendorId, `UITEST-${runId} Priority ${label}`, {
        location: priorityLocation,
        price,
        createdAt: new Date(priorityBase),
      });
    docs.push(
      priorityItem(ids.priorityPremium, 'Premium High', 30),
      priorityItem(ids.priorityPremium, 'Premium Low', 10),
      priorityItem(ids.priorityFree, 'Free Cheap', 5),
      priorityItem(ids.priorityFree, 'Free Mid', 20),
      priorityItem(ids.priorityExpired, 'Expired Cheap', 1),
    );

    const inserted = await getMenuItemsCollection().insertMany(
      docs.map((doc) => ({ ...doc, name: doc.name })),
    );

    itemIds = {
      activeA: String(inserted.insertedIds[0]),
      pendingA: String(inserted.insertedIds[1]),
      pendingA2: String(inserted.insertedIds[2]),
      rejectedA: String(inserted.insertedIds[3]),
      activeB: String(inserted.insertedIds[4]),
      quotaFreePending: String(inserted.insertedIds[8]),
      quotaFreeActive0: String(inserted.insertedIds[5]),
      quotaPremiumPending: String(inserted.insertedIds[14]),
      quotaExpiredPending: String(inserted.insertedIds[18]),
      quotaRacePending0: String(inserted.insertedIds[21]),
      quotaRacePending1: String(inserted.insertedIds[22]),
      quotaPremiumActive0: String(inserted.insertedIds[9]),
      quotaExpiredActive0: String(inserted.insertedIds[15]),
      priorityPremiumHigh: String(inserted.insertedIds[28]),
      priorityPremiumLow: String(inserted.insertedIds[29]),
      priorityFreeCheap: String(inserted.insertedIds[30]),
      priorityFreeMid: String(inserted.insertedIds[31]),
      priorityExpiredCheap: String(inserted.insertedIds[32]),
    };
  });

  afterAll(async () => {
    const seededUserIds = Object.values(ids);
    await getMenuItemsCollection().deleteMany({ vendorId: { $in: seededUserIds } });
    await getUsersCollection().deleteMany({ _id: { $in: seededUserIds } });
    await disconnectDatabase();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  // ── Admin console ──────────────────────────────────────────────────────

  /** Scope helper - other test suites run in parallel against the same DB. */
  function mine(items: Array<{ name: string; vendorId: string }>) {
    return items.filter(
      (i) => i.name.includes(runId) && [ids.vendorA, ids.vendorB].includes(i.vendorId),
    );
  }

  it('admin lists every item including pending and rejected, with pagination', async () => {
    const res = await request(app)
      .get('/api/menu-items/admin?limit=100')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    const seeded = mine(res.body.data.items);
    expect(seeded).toHaveLength(5);

    const statuses = seeded.map((i: { status: string }) => i.status);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('rejected');
    expect(statuses).toContain('active');
  });

  it('admin filters by status and vendorId', async () => {
    const pending = await request(app)
      .get('/api/menu-items/admin?status=pending&limit=100')
      .set('Authorization', `Bearer ${signedIn.get(ids.admin) ?? ''}`);

    expect(pending.status).toBe(200);
    expect(mine(pending.body.data.items)).toHaveLength(2);
    expect(pending.body.data.items.every((i: { status: string }) => i.status === 'pending')).toBe(
      true,
    );

    const vendorB = await request(app)
      .get(`/api/menu-items/admin?vendorId=${ids.vendorB}`)
      .set('Authorization', `Bearer ${signedIn.get(ids.admin) ?? ''}`);

    expect(vendorB.status).toBe(200);
    expect(vendorB.body.data.items).toHaveLength(1);
    expect(vendorB.body.data.items[0].vendorId).toBe(ids.vendorB);
  });

  it('responds 403 when a non-admin uses the admin listing', async () => {
    const res = await request(app)
      .get('/api/menu-items/admin')
      .set('Authorization', `Bearer ${await tokenFor(ids.customer)}`);
    expect(res.status).toBe(403);
  });

  // ── Public storefront ──────────────────────────────────────────────────

  it('public listing returns only active items (never pending/rejected)', async () => {
    const res = await request(app).get('/api/menu-items?limit=100');

    expect(res.status).toBe(200);
    expect(mine(res.body.data.items)).toHaveLength(2);

    const seededNames = mine(res.body.data.items).map((i: { name: string }) => i.name);
    expect(seededNames.join(' ')).not.toContain('Pending');
    expect(seededNames.join(' ')).not.toContain('Rejected');

    const idsReturned = res.body.data.items.map((i: { id: string }) => i.id);
    expect(idsReturned).toContain(itemIds.activeA);
    expect(idsReturned).toContain(itemIds.activeB);
    expect(idsReturned).not.toContain(itemIds.pendingA);
    expect(idsReturned).not.toContain(itemIds.rejectedA);
  });

  it('public listing supports category and search', async () => {
    const pizza = await request(app).get('/api/menu-items?category=pizza&limit=100');
    expect(mine(pizza.body.data.items)).toHaveLength(1);
    expect(mine(pizza.body.data.items)[0].category).toBe('pizza');

    const search = await request(app).get(
      `/api/menu-items?search=${encodeURIComponent(`UITEST-${runId} Active B`)}`,
    );
    expect(search.body.data.items.map((i: { id: string }) => i.id)).toContain(itemIds.activeB);
    expect(mine(search.body.data.items)).toHaveLength(1);
  });

  it('exposes only server-derived premium status in public menu DTOs', async () => {
    const premium = await request(app).get(`/api/menu-items/${itemIds.quotaPremiumActive0}`);
    const free = await request(app).get(`/api/menu-items/${itemIds.activeA}`);
    const expired = await request(app).get(`/api/menu-items/${itemIds.quotaExpiredActive0}`);

    expect(premium.status).toBe(200);
    expect(free.status).toBe(200);
    expect(expired.status).toBe(200);
    expect(premium.body.data.menuItem.isPremium).toBe(true);
    expect(free.body.data.menuItem.isPremium).toBe(false);
    expect(expired.body.data.menuItem.isPremium).toBe(false);

    for (const body of [premium.body.data.menuItem, free.body.data.menuItem]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('subscriptionPlan');
      expect(serialized).not.toContain('subscriptionExpiresAt');
      expect(serialized).not.toContain('stripeCustomerId');
    }

    const list = await request(app).get(
      `/api/menu-items?location=${encodeURIComponent(`Priority-${runId}`)}`,
    );
    const flags = new Map(
      (list.body.data.items as Array<{ id: string; isPremium: boolean }>).map((item) => [
        item.id,
        item.isPremium,
      ]),
    );
    expect(flags.get(itemIds.priorityPremiumLow)).toBe(true);
    expect(flags.get(itemIds.priorityFreeCheap)).toBe(false);
    expect(flags.get(itemIds.priorityExpiredCheap)).toBe(false);
  });

  it('prioritizes current premium vendors while preserving the requested sort within groups', async () => {
    const res = await request(app).get(
      `/api/menu-items?location=${encodeURIComponent(`Priority-${runId}`)}&sortBy=price&sortOrder=asc`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(5);
    expect((res.body.data.items as Array<{ id: string }>).map((item) => item.id)).toEqual([
      itemIds.priorityPremiumLow,
      itemIds.priorityPremiumHigh,
      itemIds.priorityExpiredCheap,
      itemIds.priorityFreeCheap,
      itemIds.priorityFreeMid,
    ]);
  });

  it('vendor listing pagination works per vendor', async () => {
    const res = await request(app)
      .get('/api/menu-items/mine?page=2&limit=2')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorA)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.pagination).toMatchObject({
      page: 2,
      limit: 2,
      total: 4,
      totalPages: 2,
    });
  });

  it('public detail returns active items to anonymous viewers', async () => {
    const res = await request(app).get(`/api/menu-items/${itemIds.activeA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.menuItem.id).toBe(itemIds.activeA);
  });

  it('public detail hides pending and rejected items with 404', async () => {
    const pending = await request(app).get(`/api/menu-items/${itemIds.pendingA}`);
    expect(pending.status).toBe(404);

    const rejected = await request(app).get(`/api/menu-items/${itemIds.rejectedA}`);
    expect(rejected.status).toBe(404);
  });

  it('vendors see their own non-active items, but other vendors do not', async () => {
    const owner = await request(app)
      .get(`/api/menu-items/${itemIds.pendingA}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorA)}`);
    expect(owner.status).toBe(200);
    expect(owner.body.data.menuItem.status).toBe('pending');

    const otherVendor = await request(app)
      .get(`/api/menu-items/${itemIds.pendingA}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorB)}`);
    expect(otherVendor.status).toBe(404);
  });

  it('responds 400 for invalid ids and 404 for missing items', async () => {
    const invalid = await request(app).get('/api/menu-items/not-an-objectid');
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).toContain('Invalid menu item id');

    const missing = await request(app).get(
      `/api/menu-items/${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    );
    expect(missing.status).toBe(404);
  });

  // ── Vendor self-service ────────────────────────────────────────────────

  it('vendor lists only their own items, in every status', async () => {
    const res = await request(app)
      .get('/api/menu-items/mine')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorA)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(4);
    expect(res.body.data.items.every((i: { vendorId: string }) => i.vendorId === ids.vendorA)).toBe(
      true,
    );

    const statuses = res.body.data.items.map((i: { status: string }) => i.status);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('rejected');
  });

  it('vendor listing supports a status filter', async () => {
    const res = await request(app)
      .get('/api/menu-items/mine?status=pending')
      .set('Authorization', `Bearer ${signedIn.get(ids.vendorA) ?? ''}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items.every((i: { status: string }) => i.status === 'pending')).toBe(true);
  });

  it('responds 403 when a non-vendor uses /mine', async () => {
    const res = await request(app)
      .get('/api/menu-items/mine')
      .set('Authorization', `Bearer ${await tokenFor(ids.customer)}`);
    expect(res.status).toBe(403);
  });

  it('vendor updates their own permitted fields', async () => {
    const res = await request(app)
      .patch(`/api/menu-items/mine/${itemIds.activeA}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorA)}`)
      .send({ name: `UITEST-${runId} Active A Updated`, price: 12.5, isAvailable: false });

    expect(res.status).toBe(200);
    expect(res.body.data.menuItem.name).toBe(`UITEST-${runId} Active A Updated`);
    expect(res.body.data.menuItem.price).toBe(12.5);
    expect(res.body.data.menuItem.isAvailable).toBe(false);

    const doc = await getMenuItemsCollection().findOne({
      _id: new ObjectId(itemIds.activeA),
    });
    expect(doc?.name).toBe(`UITEST-${runId} Active A Updated`);
    expect(doc?.isAvailable).toBe(false);
  });

  it('rejects vendor status manipulation with 400', async () => {
    const res = await request(app)
      .patch(`/api/menu-items/mine/${itemIds.activeA}`)
      .set('Authorization', `Bearer ${signedIn.get(ids.vendorA) ?? ''}`)
      .send({ status: 'active', name: 'Status Spoof Pizza' });

    expect(res.status).toBe(400);

    const doc = await getMenuItemsCollection().findOne({ _id: new ObjectId(itemIds.activeA) });
    expect(doc?.name).not.toBe('Status Spoof Pizza');
  });

  it('responds 403 when a vendor updates another vendor’s item', async () => {
    const res = await request(app)
      .patch(`/api/menu-items/mine/${itemIds.activeB}`)
      .set('Authorization', `Bearer ${signedIn.get(ids.vendorA) ?? ''}`)
      .send({ name: 'Hijacked Pizza Name' });

    expect(res.status).toBe(403);

    const doc = await getMenuItemsCollection().findOne({ _id: new ObjectId(itemIds.activeB) });
    expect(doc?.name).not.toBe('Hijacked Pizza Name');
  });

  it('responds 404 for missing items and 400 for invalid ids on update', async () => {
    const missing = await request(app)
      .patch(`/api/menu-items/mine/${randomUUID().replace(/-/g, '').slice(0, 24)}`)
      .set('Authorization', `Bearer ${signedIn.get(ids.vendorA) ?? ''}`)
      .send({ name: 'Missing Pizza' });
    expect(missing.status).toBe(404);

    const invalid = await request(app)
      .patch('/api/menu-items/mine/nope')
      .set('Authorization', `Bearer ${signedIn.get(ids.vendorA) ?? ''}`)
      .send({ name: 'Invalid Pizza' });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).toContain('Invalid menu item id');
  });

  it('vendor deletes their own item; deletes of others- items are forbidden', async () => {
    const own = await request(app)
      .delete(`/api/menu-items/mine/${itemIds.pendingA}`)
      .set('Authorization', `Bearer ${signedIn.get(ids.vendorA) ?? ''}`);
    expect(own.status).toBe(200);

    const gone = await getMenuItemsCollection().findOne({ _id: new ObjectId(itemIds.pendingA) });
    expect(gone).toBeNull();

    const foreign = await request(app)
      .delete(`/api/menu-items/mine/${itemIds.activeB}`)
      .set('Authorization', `Bearer ${signedIn.get(ids.vendorA) ?? ''}`);
    expect(foreign.status).toBe(403);

    const stillThere = await getMenuItemsCollection().findOne({
      _id: new ObjectId(itemIds.activeB),
    });
    expect(stillThere).not.toBeNull();
  });

  // ── Admin review decisions ─────────────────────────────────────────────

  it('admin approves a pending item, making it publicly visible', async () => {
    const approve = await request(app)
      .patch(`/api/menu-items/admin/${itemIds.pendingA2}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`)
      .send({ status: 'active' });

    expect(approve.status).toBe(200);
    expect(approve.body.data.menuItem.status).toBe('active');
    expect(approve.body.data.menuItem.isAvailable).toBe(true);

    const publicView = await request(app).get(`/api/menu-items/${itemIds.pendingA2}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.data.menuItem.status).toBe('active');
  });

  it('admin rejects an active item, hiding it from the public storefront', async () => {
    const reject = await request(app)
      .patch(`/api/menu-items/admin/${itemIds.activeB}/status`)
      .set('Authorization', `Bearer ${signedIn.get(ids.admin) ?? ''}`)
      .send({ status: 'rejected' });

    expect(reject.status).toBe(200);
    expect(reject.body.data.menuItem.status).toBe('rejected');

    const publicView = await request(app).get(`/api/menu-items/${itemIds.activeB}`);
    expect(publicView.status).toBe(404);
  });

  it('responds 403 when a non-admin changes an item status', async () => {
    const res = await request(app)
      .patch(`/api/menu-items/admin/${itemIds.pendingA2}/status`)
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorA)}`)
      .send({ status: 'rejected' });
    expect(res.status).toBe(403);
  });

  // ── Free-plan active-item invariant ─────────────────────────────────────

  describe('free-plan active-item invariant', () => {
    async function setStatus(itemId: string, status: string) {
      return request(app)
        .patch(`/api/menu-items/admin/${itemId}/status`)
        .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`)
        .send({ status });
    }

    it('blocks admin approval at the free-plan cap and leaves already-active items idempotent', async () => {
      const blocked = await setStatus(itemIds.quotaFreePending, 'active');
      expect(blocked.status).toBe(403);
      expect(blocked.body.message).toContain('3 active menu items');

      const pending = await getMenuItemsCollection().findOne({
        _id: new ObjectId(itemIds.quotaFreePending),
      });
      expect(pending?.status).toBe('pending');
      expect(pending?.isAvailable).toBe(false);

      const noop = await setStatus(itemIds.quotaFreeActive0, 'active');
      expect(noop.status).toBe(200);
      expect(noop.body.data.menuItem.status).toBe('active');
    });

    it('allows approval once a slot is freed', async () => {
      const freed = await setStatus(itemIds.quotaFreeActive0, 'rejected');
      expect(freed.status).toBe(200);

      const approved = await setStatus(itemIds.quotaFreePending, 'active');
      expect(approved.status).toBe(200);
      expect(approved.body.data.menuItem.isAvailable).toBe(true);

      const activeCount = await getMenuItemsCollection().countDocuments({
        vendorId: ids.quotaFree,
        status: 'active',
      });
      expect(activeCount).toBe(3);
    });

    it('keeps the unlimited cap for active premium vendors', async () => {
      const approved = await setStatus(itemIds.quotaPremiumPending, 'active');
      expect(approved.status).toBe(200);

      const activeCount = await getMenuItemsCollection().countDocuments({
        vendorId: ids.quotaPremium,
        status: 'active',
      });
      expect(activeCount).toBe(6);
    });

    it('treats expired premium as free on approval', async () => {
      const blocked = await setStatus(itemIds.quotaExpiredPending, 'active');
      expect(blocked.status).toBe(403);

      const activeCount = await getMenuItemsCollection().countDocuments({
        vendorId: ids.quotaExpired,
        status: 'active',
      });
      expect(activeCount).toBe(3);
    });

    it('preserves every document on downgrade, pauses only excess items, and freezes activations', async () => {
      await getUsersCollection().updateOne(
        { _id: ids.quotaPremium },
        { $set: { subscriptionPlan: 'free', subscriptionExpiresAt: null } },
      );

      const result = await enforceFreePlanActiveLimit(ids.quotaPremium);
      expect(result.activeCountBefore).toBe(6);
      expect(result.activeCountAfter).toBe(3);
      expect(result.pausedItemIds).toHaveLength(3);

      const allDocs = await getMenuItemsCollection().find({ vendorId: ids.quotaPremium }).toArray();
      expect(allDocs).toHaveLength(6); // no deletes
      expect(allDocs.filter((item) => item.status === 'active')).toHaveLength(3);
      expect(allDocs.filter((item) => item.status === 'inactive')).toHaveLength(3);
      expect(allDocs.every((item) => item.isAvailable === (item.status === 'active'))).toBe(true);

      const blocked = await setStatus(itemIds.quotaPremiumPending, 'rejected');
      expect(blocked.status).toBe(200);

      const stillBlocked = await setStatus(itemIds.quotaPremiumPending, 'active');
      expect(stillBlocked.status).toBe(403);
    });

    it('serializes concurrent approvals so the free cap cannot be exceeded', async () => {
      const adminToken = await tokenFor(ids.admin);
      const [first, second] = await Promise.all([
        request(app)
          .patch(`/api/menu-items/admin/${itemIds.quotaRacePending0}/status`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ status: 'active' }),
        request(app)
          .patch(`/api/menu-items/admin/${itemIds.quotaRacePending1}/status`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ status: 'active' }),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 403]);
      const activeCount = await getMenuItemsCollection().countDocuments({
        vendorId: ids.quotaRace,
        status: 'active',
      });
      expect(activeCount).toBe(3);
    });

    it('reconciles already-expired premium vendors on the startup-style sweep', async () => {
      const result = await enforceExpiredPremiumMenuLimits();
      expect(result.checked).toBeGreaterThanOrEqual(1);

      const docs = await getMenuItemsCollection().find({ vendorId: ids.quotaSweep }).toArray();
      expect(docs).toHaveLength(5); // no deletes
      expect(docs.filter((item) => item.status === 'active')).toHaveLength(3);
      expect(docs.filter((item) => item.status === 'inactive')).toHaveLength(2);
      expect(docs.every((item) => item.isAvailable === (item.status === 'active'))).toBe(true);
    });
  });
});
