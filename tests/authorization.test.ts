import { createServer, type AddressInfo, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { ApiError } from '../src/app/error/ApiError.js';
import {
  createRequireAuth,
  requireRole,
  requireCustomer,
  requireVendor,
  requireAdmin,
} from '../src/app/auth/require-auth.js';
import { canAccessResource, isResourceOwner, requireOwnership } from '../src/app/auth/ownership.js';
import type { AuthenticatedUser, BetterAuthUser } from '../src/app/auth/auth.types.js';
import type { Request, RequestHandler, Response } from 'express';
import type { UserRole } from '../src/app/types/common.types.js';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

interface TestKey {
  kid: string;
  jwk: JWK;
  keyPair: GeneratedKeyPair;
}

/**
 * Fresh, DB-backed role + block status is the core of requireAuth, so the
 * user lookup is stubbed instead of hitting a real users collection.
 */
function createUserLookup(users: Map<string, BetterAuthUser>) {
  return {
    findUserById: async (userId: string) => users.get(userId) ?? null,
  };
}

function makeAuthContext(userId: string, roles: UserRole[]): AuthenticatedUser {
  const role = roles[0]!;
  return {
    userId,
    role,
    roles,
    issuer: ISSUER,
    audience: AUDIENCE,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 300_000),
  };
}

function createRes(): Response & {
  status: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const res = {
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

/** Runs middlewares in sequence; stops at the first stage that never calls next(). */
async function runChain(
  middlewares: RequestHandler[],
  req: Request,
): Promise<{ res: ReturnType<typeof createRes>; nexts: ReturnType<typeof vi.fn>[] }> {
  const res = createRes();
  const nexts = middlewares.map(() => vi.fn());

  for (let i = 0; i < middlewares.length; i += 1) {
    await middlewares[i](req, res, nexts[i]);
    if (!nexts[i].mock.calls.length) {
      break; // chain stopped at this stage
    }
  }

  return { res, nexts };
}

describe('requireAuth (JWT + DB-backed role and block status)', () => {
  let jwksServer: Server;
  let jwksUrl: string;
  let signingKey: TestKey;
  let users: Map<string, BetterAuthUser>;
  let requireAuth: RequestHandler;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = 'authz-test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    signingKey = { kid: 'authz-test-key', jwk, keyPair };

    const jwksServerInstance = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [signingKey.jwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => jwksServerInstance.listen(0, '127.0.0.1', resolve));
    jwksServer = jwksServerInstance;
    const { port } = jwksServerInstance.address() as AddressInfo;
    jwksUrl = `http://127.0.0.1:${port}/jwks`;

    users = new Map<string, BetterAuthUser>([
      ['customer-1', { _id: 'customer-1', email: 'customer@test.dev', role: 'customer' }],
      ['vendor-1', { _id: 'vendor-1', email: 'vendor@test.dev', role: 'vendor' }],
      ['admin-1', { _id: 'admin-1', email: 'admin@test.dev', role: 'admin' }],
      [
        'blocked-1',
        { _id: 'blocked-1', email: 'blocked@test.dev', role: 'customer', isBlocked: true },
      ],
      // Better Auth admin-plugin style ban (permanent).
      ['banned-1', { _id: 'banned-1', email: 'banned@test.dev', role: 'customer', banned: true }],
      // Better Auth admin-plugin temporary ban that has already expired.
      [
        'temp-banned-1',
        {
          _id: 'temp-banned-1',
          email: 'temp@test.dev',
          role: 'customer',
          banned: true,
          banExpires: Date.now() / 1000 - 3600,
        },
      ],
    ]);

    requireAuth = createRequireAuth(
      { jwksUrl, issuer: ISSUER, audience: AUDIENCE, cooldownDuration: 0 },
      createUserLookup(users),
    );
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        jwksServer.close(() => resolve());
      }),
  );

  function signToken(sub: string, extraClaims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ email: 'spoofed@attacker.dev', email_verified: true, ...extraClaims })
      .setProtectedHeader({ alg: 'RS256', kid: signingKey.kid })
      .setSubject(sub)
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(signingKey.keyPair.privateKey);
  }

  function requestWithToken(
    token: string,
    extra: { body?: unknown; headers?: Record<string, string> } = {},
  ): Request {
    return {
      headers: { authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
      body: extra.body ?? {},
    } as unknown as Request;
  }

  it('authenticates a customer and resolves the role from MongoDB', async () => {
    const req = requestWithToken(await signToken('customer-1'));
    const { nexts } = await runChain([requireAuth, requireCustomer], req);

    expect(nexts[0]).toHaveBeenCalledOnce();
    expect(nexts[1]).toHaveBeenCalledOnce();
    expect(req.auth?.userId).toBe('customer-1');
    expect(req.auth?.role).toBe('customer');
    expect(req.auth?.email).toBe('customer@test.dev'); // DB value, not token claim
  });

  it('authenticates a vendor and accepts vendor-only routes', async () => {
    const req = requestWithToken(await signToken('vendor-1'));
    const { nexts } = await runChain([requireAuth, requireVendor], req);

    expect(nexts[0]).toHaveBeenCalledOnce();
    expect(nexts[1]).toHaveBeenCalledOnce();
    expect(req.auth?.role).toBe('vendor');
  });

  it('authenticates an admin and accepts admin-only routes', async () => {
    const req = requestWithToken(await signToken('admin-1'));
    const { nexts } = await runChain([requireAuth, requireAdmin], req);

    expect(nexts[0]).toHaveBeenCalledOnce();
    expect(nexts[1]).toHaveBeenCalledOnce();
    expect(req.auth?.role).toBe('admin');
  });

  it('forbids a vendor on customer-only routes with 403', async () => {
    const req = requestWithToken(await signToken('vendor-1'));
    const { res, nexts } = await runChain([requireAuth, requireCustomer], req);

    expect(nexts[0]).toHaveBeenCalledOnce(); // authentication passed
    expect(nexts[1]).not.toHaveBeenCalled(); // role gate stopped the chain
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('forbids an admin on vendor-only routes with 403 (roles are strict)', async () => {
    const req = requestWithToken(await signToken('admin-1'));
    const { res, nexts } = await runChain([requireAuth, requireVendor], req);

    expect(nexts[0]).toHaveBeenCalledOnce();
    expect(nexts[1]).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks a blocked account with 403', async () => {
    const req = requestWithToken(await signToken('blocked-1'));
    const { res, nexts } = await runChain([requireAuth, requireCustomer], req);

    expect(nexts[0]).not.toHaveBeenCalled();
    expect(nexts[1]).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Your account has been blocked' }),
    );
    expect(req.auth).toBeUndefined();
  });

  it('blocks accounts banned via the Better Auth admin plugin with 403', async () => {
    const req = requestWithToken(await signToken('banned-1'));
    const { res, nexts } = await runChain([requireAuth], req);

    expect(nexts[0]).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows an expired temporary ban', async () => {
    const req = requestWithToken(await signToken('temp-banned-1'));
    const { res, nexts } = await runChain([requireAuth], req);

    expect(nexts[0]).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a subject that no longer exists in the users collection with 401', async () => {
    const req = requestWithToken(await signToken('ghost-user'));
    const { res, nexts } = await runChain([requireAuth], req);

    expect(nexts[0]).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('ignores role claims from the token, body and headers', async () => {
    const req = requestWithToken(await signToken('customer-1', { role: 'admin' }), {
      body: { role: 'admin', isBlocked: false },
      headers: { 'x-user-role': 'admin', 'x-user-id': 'admin-1' },
    });
    const { res, nexts } = await runChain([requireAuth, requireAdmin], req);

    expect(nexts[0]).toHaveBeenCalledOnce();
    // Role came from MongoDB (customer) — the spoofed admin role is ignored.
    expect(req.auth?.role).toBe('customer');
    expect(req.auth?.userId).toBe('customer-1');
    expect(nexts[1]).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects a missing token with 401', async () => {
    const req = { headers: {} } as unknown as Request;
    const { res, nexts } = await runChain([requireAuth], req);

    expect(nexts[0]).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireRole', () => {
  it('responds 401 when requireAuth has not run', async () => {
    const req = { headers: {} } as unknown as Request;
    const res = createRes();
    const next = vi.fn();

    await requireRole('customer')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts any of the allowed roles (multi-role users)', async () => {
    const req = { auth: makeAuthContext('multi-1', ['vendor', 'admin']) } as unknown as Request;
    const res = createRes();
    const next = vi.fn();

    await requireRole('vendor', 'admin')(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('denies with 403 when the role does not match', async () => {
    const req = { auth: makeAuthContext('customer-1', ['customer']) } as unknown as Request;
    const res = createRes();
    const next = vi.fn();

    await requireVendor(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('ownership utilities', () => {
  const owner = makeAuthContext('user-1', ['customer']);
  const other = makeAuthContext('user-2', ['customer']);
  const admin = makeAuthContext('admin-1', ['admin']);

  it('isResourceOwner matches only the verified user id', () => {
    expect(isResourceOwner(owner, 'user-1')).toBe(true);
    expect(isResourceOwner(owner, 'user-2')).toBe(false);
    expect(isResourceOwner(owner, undefined)).toBe(false);
    expect(isResourceOwner(owner, '')).toBe(false);
  });

  it('canAccessResource supports the admin bypass', () => {
    expect(canAccessResource(owner, 'user-1')).toBe(true);
    expect(canAccessResource(other, 'user-1')).toBe(false);
    expect(canAccessResource(other, 'user-1', { allowAdminBypass: false })).toBe(false);
    expect(canAccessResource(admin, 'user-1', { allowAdminBypass: true })).toBe(true);
  });

  it('requireOwnership lets the owner through', async () => {
    const req = {
      auth: owner,
      params: { id: 'order-1' },
    } as unknown as Request;
    const next = vi.fn();

    await requireOwnership(async (r) =>
      (r as Request & { params: { id: string } }).params.id === 'order-1' ? 'user-1' : null,
    )(req, createRes(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('requireOwnership denies a non-owner with a 403 ApiError', async () => {
    const req = { auth: other } as unknown as Request;
    const next = vi.fn();

    await requireOwnership(async () => 'user-1')(req, createRes(), next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0] as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(403);
  });

  it('requireOwnership denies when the resource has no owner (missing resource)', async () => {
    const req = { auth: owner } as unknown as Request;
    const next = vi.fn();

    await requireOwnership(async () => null)(req, createRes(), next);

    const error = next.mock.calls[0][0] as ApiError;
    expect(error.statusCode).toBe(403);
  });

  it('requireOwnership allows admins when bypass is enabled', async () => {
    const req = { auth: admin } as unknown as Request;
    const next = vi.fn();

    await requireOwnership(async () => 'user-1', { allowAdminBypass: true })(
      req,
      createRes(),
      next,
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it('requireOwnership responds 401 when requireAuth has not run', async () => {
    const req = {} as unknown as Request;
    const res = createRes();
    const next = vi.fn();

    await requireOwnership(async () => 'user-1')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
