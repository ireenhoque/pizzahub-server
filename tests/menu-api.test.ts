import { createServer, type AddressInfo, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { Express } from 'express';
import { connectDatabase, disconnectDatabase } from '../src/app/config/db.js';
import { getMenuItemsCollection, getUsersCollection } from '../src/app/db/collections.js';
import { createRequireAuth } from '../src/app/auth/require-auth.js';
import { createApp } from '../src/create-app.js';
import type { MenuItem } from '../src/app/types/menuItem.types.js';
import type { UploadedImage } from '../src/app/modules/menuItems/menu-item.types.js';
import { FREE_PLAN_MAX_ACTIVE_MENU_ITEMS } from '../src/app/modules/menuItems/menu-item.service.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/** Fake ImgBB uploader: succeeds with canned URLs, fails on demand. */
const fakeUpload = async (file: { originalname: string }): Promise<UploadedImage> => {
  if (file.originalname === 'fail.png') {
    throw new Error('imgbb exploded'); // non-ApiError → service maps to 502
  }
  return {
    imageUrl: `https://i.ibb.co/test/${randomUUID()}.png`,
    thumbUrl: 'https://i.ibb.co/test/thumb.png',
    deleteUrl: 'https://api.imgbb.com/delete?secret-token',
  };
};

/** Minimal valid MenuItem factory for quota seeding. */
function activeItem(vendorId: string, name: string): Omit<MenuItem, '_id'> {
  const now = new Date();
  return {
    vendorId,
    name,
    description: 'Seeded quota item used by tests',
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
  };
}

describe('Menu item creation API (vendor-only, ImgBB upload)', () => {
  let jwksServer: Server;
  let app: Express;
  let keyPair: GeneratedKeyPair;
  let ids: Record<string, string>;

  const runId = randomUUID().slice(0, 8);

  const signedIn = new Map<string, string>();

  async function tokenFor(userId: string): Promise<string> {
    let token = signedIn.get(userId);
    if (!token) {
      token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'menu-api-test-key' })
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
    jwk.kid = 'menu-api-test-key';
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

    app = createApp({ requireAuthMiddleware: requireAuth, uploadImage: fakeUpload });

    // ── Seed users ──────────────────────────────────────────────────────
    ids = {
      vendorFree: `uitest-${runId}-m-free`,
      vendorNew: `uitest-${runId}-m-new`,
      vendorPremium: `uitest-${runId}-m-prem`,
      vendorExpired: `uitest-${runId}-m-exp`,
      customer: `uitest-${runId}-m-cust`,
    };

    const users = [
      { _id: ids.vendorFree, role: 'vendor' },
      { _id: ids.vendorNew, role: 'vendor' },
      { _id: ids.vendorPremium, role: 'vendor' },
      { _id: ids.vendorExpired, role: 'vendor' },
      { _id: ids.customer, role: 'customer' },
    ] as const;

    await getUsersCollection().insertMany(
      users.map((user) => ({
        _id: user._id,
        name: `UITEST-${runId} ${user.role}`,
        email: `${user._id}@example.com`,
        emailVerified: true,
        role: user.role,
        ...(user._id === ids.vendorPremium
          ? {
              subscriptionPlan: 'premium',
              subscriptionExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
            }
          : {}),
        ...(user._id === ids.vendorExpired
          ? {
              subscriptionPlan: 'premium',
              subscriptionExpiresAt: new Date(Date.now() - 24 * 3600 * 1000),
            }
          : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );

    // ── Seed quota items ────────────────────────────────────────────────
    await getMenuItemsCollection().insertMany([
      // Free vendor already at the limit.
      ...Array.from({ length: FREE_PLAN_MAX_ACTIVE_MENU_ITEMS }, (_, i) =>
        activeItem(ids.vendorFree, `UITEST-${runId} Free Active ${i + 1}`),
      ),
      // Premium vendor beyond the free limit.
      ...Array.from({ length: FREE_PLAN_MAX_ACTIVE_MENU_ITEMS + 2 }, (_, i) =>
        activeItem(ids.vendorPremium, `UITEST-${runId} Premium Active ${i + 1}`),
      ),
      // Expired-premium vendor: free-tier limits apply, so fill the quota too.
      ...Array.from({ length: FREE_PLAN_MAX_ACTIVE_MENU_ITEMS }, (_, i) =>
        activeItem(ids.vendorExpired, `UITEST-${runId} Expired Active ${i + 1}`),
      ),
    ]);
  });

  afterAll(async () => {
    const seededUserIds = Object.values(ids);
    await getMenuItemsCollection().deleteMany({ vendorId: { $in: seededUserIds } });
    await getUsersCollection().deleteMany({ _id: { $in: seededUserIds } });
    await disconnectDatabase();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  it('creates a pending menu item for a vendor with the image uploaded server-side', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', `UITEST-${runId} Margherita`)
      .field('category', 'pizza')
      .field('description', 'Classic tomato and mozzarella pizza')
      .field('price', '12.5')
      .field('location', 'Dhanmondi, Dhaka')
      .attach('image', Buffer.from('fake-image-bytes'), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(201);
    const menuItem = res.body.data.menuItem;
    expect(menuItem.status).toBe('pending'); // initial status, never client-chosen
    expect(menuItem.vendorId).toBe(ids.vendorNew); // from verified JWT, not body
    expect(menuItem.imageUrl).toMatch(/^https:\/\/i\.ibb\.co\/test\//);
    expect(menuItem.price).toBe(12.5);
    expect(menuItem.location).toBe('Dhanmondi, Dhaka');
    expect(menuItem.isAvailable).toBe(false);

    // The ImgBB delete URL must be stored but NEVER exposed.
    expect(JSON.stringify(res.body)).not.toContain('deleteUrl');
    expect(JSON.stringify(res.body)).not.toContain('secret-token');

    const doc = await getMenuItemsCollection().findOne({ vendorId: ids.vendorNew });
    expect(doc?.imageDeleteUrl).toBe('https://api.imgbb.com/delete?secret-token');
    expect(doc?.status).toBe('pending');
  });

  it('responds 401 without a token', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .attach('image', Buffer.from('x'), 'a.png');
    expect(res.status).toBe(401);
  });

  it('responds 403 for non-vendors (customer role)', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.customer)}`)
      .field('name', 'Should Not Exist')
      .field('category', 'pizza')
      .field('description', 'Customer attempting vendor action')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .attach('image', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(await getMenuItemsCollection().countDocuments({ vendorId: ids.customer })).toBe(0);
  });

  it('responds 400 when no image is attached', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', 'No Image Pizza')
      .field('category', 'pizza')
      .field('description', 'Attempt without an attached image')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka');

    expect(res.status).toBe(400);
  });

  it('responds 400 for an unsupported image MIME type', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', 'Text File Pizza')
      .field('category', 'pizza')
      .field('description', 'Attempt with a text file image')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .attach('image', Buffer.from('just text'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Unsupported image type');
  });

  it('responds 400 for files larger than the size limit', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', 'Big Pizza')
      .field('category', 'pizza')
      .field('description', 'Attempt with an oversized image')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .attach('image', Buffer.alloc(6 * 1024 * 1024), {
        filename: 'big.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('size limit');
  });

  it('responds 400 when the file is attached to the wrong field', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', 'Wrong Field Pizza')
      .field('category', 'pizza')
      .field('description', 'Attempt with wrong multipart field')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .attach('photo', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('"image"');
  });

  it('rejects invalid price, category and missing fields with 400', async () => {
    const token = await tokenFor(ids.vendorNew);
    const base = () =>
      request(app)
        .post('/api/menu-items')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Validation Pizza')
        .field('category', 'pizza')
        .field('description', 'Validation testing description')
        .field('price', '10')
        .field('location', 'Mirpur, Dhaka');

    const badPrice = await base().field('price', 'abc').attach('image', Buffer.from('x'), 'a.png');
    expect(badPrice.status).toBe(400);

    const negative = await base().field('price', '-5').attach('image', Buffer.from('x'), 'a.png');
    expect(negative.status).toBe(400);

    const badCategory = await base()
      .field('category', 'shoes')
      .attach('image', Buffer.from('x'), 'a.png');
    expect(badCategory.status).toBe(400);

    const missingDescription = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', 'No Description')
      .field('category', 'pizza')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .attach('image', Buffer.from('x'), 'a.png');
    expect(missingDescription.status).toBe(400);
  });

  it('rejects client-supplied vendorId and status with 400', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', 'Spoofed Pizza')
      .field('category', 'pizza')
      .field('description', 'Attempting to spoof vendorId and status')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .field('vendorId', ids.customer)
      .field('status', 'active')
      .attach('image', Buffer.from('x'), 'a.png');

    expect(res.status).toBe(400);
    expect(await getMenuItemsCollection().countDocuments({ vendorId: ids.customer })).toBe(0);
    const docs = await getMenuItemsCollection()
      .find({ name: { $regex: 'Spoofed Pizza' } })
      .toArray();
    expect(docs).toHaveLength(0);
  });

  it('enforces the free-plan limit of 3 active menu items', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorFree)}`)
      .field('name', 'Quota Pizza')
      .field('category', 'pizza')
      .field('description', 'Free vendor at the active item quota')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .attach('image', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('3 active menu items');
  });

  it('allows unlimited items for vendors with an active premium subscription', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorPremium)}`)
      .field('name', 'Premium Pizza')
      .field('category', 'pizza')
      .field('description', 'Premium vendor creating another item')
      .field('price', '20')
      .field('location', 'Banani, Dhaka')
      .attach('image', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
  });

  it('treats an expired premium subscription as free tier', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorExpired)}`)
      .field('name', 'Expired Premium Pizza')
      .field('category', 'pizza')
      .field('description', 'Expired premium trying to create an item')
      .field('price', '15')
      .field('location', 'Uttara, Dhaka')
      .attach('image', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('3 active menu items');
  });

  it('maps image upload failures to 502 and persists nothing', async () => {
    const before = await getMenuItemsCollection().countDocuments({ vendorId: ids.vendorNew });

    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${await tokenFor(ids.vendorNew)}`)
      .field('name', 'Upload Fail Pizza')
      .field('category', 'pizza')
      .field('description', 'Upload failure handling test item')
      .field('price', '10')
      .field('location', 'Mirpur, Dhaka')
      .attach('image', Buffer.from('x'), { filename: 'fail.png', contentType: 'image/png' });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);

    const after = await getMenuItemsCollection().countDocuments({ vendorId: ids.vendorNew });
    expect(after).toBe(before); // no partial writes
  });
});
