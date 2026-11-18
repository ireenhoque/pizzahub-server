import { createServer, type AddressInfo, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { Express } from 'express';
import { connectDatabase, disconnectDatabase } from '../src/app/config/db.js';
import { getUsersCollection } from '../src/app/db/collections.js';
import { createRequireAuth } from '../src/app/auth/require-auth.js';
import { createApp } from '../src/app.js';
import type { BetterAuthUser } from '../src/app/auth/auth.types.js';
import type { PublicUser } from '../src/app/modules/users/user.types.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

/**
 * Full API tests against the REAL MongoDB (Atlas) — real JWT verification
 * via a local JWKS server, real requireAuth, real Zod validation, real
 * service logic. Only documents created here (unique `uitest-*` ids) are
 * touched, and all of them are removed afterwards.
 */
describe('User & profile APIs', () => {
  let jwksServer: Server;
  let app: Express;
  let keyPair: GeneratedKeyPair;
  let ids: Record<string, string>;

  // Unique per test run; derived before beforeAll so tests can use it.
  const runId = randomUUID().slice(0, 8);

  const signedIn = new Map<string, string>(); // userId → token

  async function tokenFor(userId: string): Promise<string> {
    let token = signedIn.get(userId);
    if (!token) {
      token = await new SignJWT({ email: `${userId}@test.dev` })
        .setProtectedHeader({ alg: 'RS256', kid: 'users-api-test-key' })
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
    jwk.kid = 'users-api-test-key';
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

    // ── Seed test users (unique per run) ────────────────────────────────
    ids = {
      me: `uitest-${runId}-me`,
      admin: `uitest-${runId}-admin`,
      admin2: `uitest-${runId}-admin2`,
      vendor: `uitest-${runId}-vendor`,
      searchable: `uitest-${runId}-searchable`,
      target: `uitest-${runId}-target`,
    };

    const docs: BetterAuthUser[] = [
      {
        _id: ids.me,
        name: `UITEST-${runId} Me`,
        email: `uitest-${runId}.me@example.com`,
        emailVerified: true,
        role: 'customer',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: ids.admin,
        name: `UITEST-${runId} Admin`,
        email: `uitest-${runId}.admin@example.com`,
        emailVerified: true,
        role: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: ids.admin2,
        name: `UITEST-${runId} Admin Two`,
        email: `uitest-${runId}.admin2@example.com`,
        emailVerified: true,
        role: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: ids.vendor,
        name: `UITEST-${runId} Vendor`,
        email: `uitest-${runId}.vendor@example.com`,
        emailVerified: true,
        role: 'vendor',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: ids.searchable,
        name: `UITEST-${runId} Searchable`,
        email: `findme.${runId}@example.com`,
        emailVerified: true,
        role: 'customer',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: ids.target,
        name: `UITEST-${runId} Target`,
        email: `uitest-${runId}.target@example.com`,
        emailVerified: true,
        role: 'customer',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await getUsersCollection().insertMany(docs);
  });

  afterAll(async () => {
    // Remove every document this run created.
    await getUsersCollection().deleteMany({
      _id: { $in: Object.values(ids) },
    });
    await disconnectDatabase();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  // ── GET /api/users/me ────────────────────────────────────────────────

  it('returns the current user profile for an authenticated customer', async () => {
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${await tokenFor(ids.me)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const user: PublicUser = res.body.data.user;
    expect(user.id).toBe(ids.me);
    expect(user.role).toBe('customer');
    expect(user.isBlocked).toBe(false);
    expect(user.email).toContain('uitest-');
  });

  it('responds 401 without a token', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('responds 403 for a blocked account', async () => {
    await getUsersCollection().updateOne({ _id: ids.target }, { $set: { isBlocked: true } });
    try {
      const res = await request(app)
        .get('/api/users/me')
        .set('Authorization', `Bearer ${await tokenFor(ids.target)}`);
      expect(res.status).toBe(403);
    } finally {
      await getUsersCollection().updateOne({ _id: ids.target }, { $set: { isBlocked: false } });
    }
  });

  // ── PATCH /api/users/me ──────────────────────────────────────────────

  it('updates permitted profile fields', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${await tokenFor(ids.me)}`)
      .send({ name: 'Renamed Via API' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Renamed Via API');
  });

  it('rejects self-updates to role, isBlocked and subscription fields with 400', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${await tokenFor(ids.me)}`)
      .send({
        name: 'Still Customer',
        role: 'admin',
        isBlocked: false,
        subscriptionPlan: 'premium',
        subscriptionExpiresAt: '2099-01-01T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.details).toBeDefined();

    // The DB must be untouched.
    const user = await getUsersCollection().findOne({ _id: ids.me });
    expect(user?.role).toBe('customer');
    expect(user?.isBlocked).toBeFalsy();
    expect(user?.subscriptionPlan).toBeUndefined();
  });

  it('rejects an empty name with 400', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${await tokenFor(ids.me)}`)
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });

  // ── Admin listing ────────────────────────────────────────────────────

  it('lists users with pagination for an admin', async () => {
    const res = await request(app)
      .get('/api/users?search=UITEST&page=1&limit=2')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    const { users, pagination } = res.body.data;
    expect(users.length).toBe(2);
    expect(pagination.total).toBeGreaterThanOrEqual(6);
    expect(pagination.page).toBe(1);
    expect(pagination.limit).toBe(2);
    expect(pagination.totalPages).toBeGreaterThanOrEqual(3);
  });

  it('paginates to the next page', async () => {
    const res = await request(app)
      .get('/api/users?search=UITEST&page=2&limit=2')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.users.length).toBe(2);
    expect(res.body.data.pagination.page).toBe(2);
  });

  it('forbids non-admins from listing users with 403', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${await tokenFor(ids.me)}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  // The seeded user ids embed the run id.
  it('searches users by name (case-insensitive)', async () => {
    const res = await request(app)
      .get(`/api/users?search=${encodeURIComponent(`${runId} Searchable`)}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    const found: PublicUser[] = res.body.data.users;
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(ids.searchable);
  });

  it('searches users by email', async () => {
    const res = await request(app)
      .get(`/api/users?search=${encodeURIComponent(`findme.${runId}`)}`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    const found: PublicUser[] = res.body.data.users;
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(ids.searchable);
  });

  it('filters users by role', async () => {
    const res = await request(app)
      .get(`/api/users?search=UITEST-${runId}&role=vendor`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(200);
    const found: PublicUser[] = res.body.data.users;
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(ids.vendor);
    expect(found[0]!.role).toBe('vendor');
  });

  it('rejects an invalid limit with 400', async () => {
    const res = await request(app)
      .get('/api/users?limit=1000')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });

  // ── Block / unblock ──────────────────────────────────────────────────

  it('blocks a user as admin; the block takes effect immediately', async () => {
    const blockRes = await request(app)
      .post(`/api/users/${ids.target}/block`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`)
      .send({ reason: 'API test block' });

    expect(blockRes.status).toBe(200);
    expect(blockRes.body.data.user.isBlocked).toBe(true);
    expect(blockRes.body.data.user.blockedReason).toBe('API test block');

    // The blocked user's own requests now fail with 403.
    const meRes = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${await tokenFor(ids.target)}`);
    expect(meRes.status).toBe(403);
  });

  it('unblocks a user as admin; access is restored', async () => {
    const unblockRes = await request(app)
      .post(`/api/users/${ids.target}/unblock`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`);

    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body.data.user.isBlocked).toBe(false);

    const meRes = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${await tokenFor(ids.target)}`);
    expect(meRes.status).toBe(200);
  });

  it('forbids non-admins from blocking users with 403', async () => {
    const res = await request(app)
      .post(`/api/users/${ids.vendor}/block`)
      .set('Authorization', `Bearer ${await tokenFor(ids.me)}`)
      .send({});

    expect(res.status).toBe(403);
    const vendor = await getUsersCollection().findOne({ _id: ids.vendor });
    expect(vendor?.isBlocked).toBeFalsy();
  });

  it('prevents an admin from blocking their own account', async () => {
    const res = await request(app)
      .post(`/api/users/${ids.admin}/block`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('prevents blocking other admin accounts', async () => {
    const res = await request(app)
      .post(`/api/users/${ids.admin2}/block`)
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin accounts cannot be blocked');
  });

  it('responds 404 when blocking an unknown user', async () => {
    const res = await request(app)
      .post('/api/users/uitest-unknown-user/block')
      .set('Authorization', `Bearer ${await tokenFor(ids.admin)}`)
      .send({});

    expect(res.status).toBe(404);
  });
});
