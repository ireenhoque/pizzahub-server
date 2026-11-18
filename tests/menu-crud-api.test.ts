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
import { createApp } from '../src/app.js';
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
    };

    await getUsersCollection().insertMany(
      [
        { _id: ids.vendorA, role: 'vendor' },
        { _id: ids.vendorB, role: 'vendor' },
        { _id: ids.customer, role: 'customer' },
        { _id: ids.admin, role: 'admin' },
      ].map((user) => ({
        _id: user._id,
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

    const inserted = await getMenuItemsCollection().insertMany(
      docs.map((doc) => ({ ...doc, name: doc.name })),
    );

    itemIds = {
      activeA: String(inserted.insertedIds[0]),
      pendingA: String(inserted.insertedIds[1]),
      pendingA2: String(inserted.insertedIds[2]),
      rejectedA: String(inserted.insertedIds[3]),
      activeB: String(inserted.insertedIds[4]),
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
      .get('/api/menu-items/admin')
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
      .get('/api/menu-items/admin?status=pending')
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
    const res = await request(app).get('/api/menu-items');

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
    const pizza = await request(app).get('/api/menu-items?category=pizza');
    expect(mine(pizza.body.data.items)).toHaveLength(1);
    expect(mine(pizza.body.data.items)[0].category).toBe('pizza');

    const search = await request(app).get(
      `/api/menu-items?search=${encodeURIComponent(`UITEST-${runId} Active B`)}`,
    );
    expect(search.body.data.items.map((i: { id: string }) => i.id)).toContain(itemIds.activeB);
    expect(mine(search.body.data.items)).toHaveLength(1);
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
});
