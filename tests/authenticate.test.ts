import { createServer, type AddressInfo, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createJwtAuthMiddleware } from '../src/app/auth/authenticate.js';
import type { AuthenticatedUser } from '../src/app/auth/auth.types.js';
import type { Request, Response } from 'express';

const ISSUER = 'https://auth.pizzahub.test';
const AUDIENCE = 'pizzahub-api';
const USER_ID = 'better-auth-user-123';

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

interface TestKey {
  kid: string;
  jwk: JWK;
  keyPair: GeneratedKeyPair;
}

/**
 * Tests run the real middleware against a local JWKS endpoint, so the full
 * flow is exercised: remote fetch, caching, verification, and rotation.
 */
describe('Better Auth JWT authentication middleware', () => {
  let jwksServer: Server;
  let jwksUrl: string;
  let servedKeys: JWK[];
  let signingKeys: TestKey[];
  let authenticate: ReturnType<typeof createJwtAuthMiddleware>;

  beforeAll(async () => {
    // Two keys so key rotation can be simulated.
    signingKeys = await Promise.all(
      ['test-key-1', 'test-key-2'].map(async (kid): Promise<TestKey> => {
        const keyPair = await generateKeyPair('RS256', { extractable: true });
        const jwk = await exportJWK(keyPair.publicKey);
        jwk.kid = kid;
        jwk.alg = 'RS256';
        jwk.use = 'sig';
        return { kid, jwk, keyPair };
      }),
    );

    // Start by serving only the first key (rotation adds the second later).
    servedKeys = [signingKeys[0]!.jwk];

    jwksServer = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: servedKeys }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const { port } = jwksServer.address() as AddressInfo;
    jwksUrl = `http://127.0.0.1:${port}/jwks`;

    authenticate = createJwtAuthMiddleware({
      jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
      cooldownDuration: 0, // allow immediate JWKS re-fetch for rotation tests
    });
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        jwksServer.close(() => resolve());
      }),
  );

  // ── helpers ──────────────────────────────────────────────────────────

  function signToken(
    key: TestKey,
    claims: { sub?: string; iss?: string; aud?: string; exp?: number; omitSub?: boolean } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const builder = new SignJWT({ email: 'user@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuedAt()
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? AUDIENCE)
      .setExpirationTime(claims.exp ?? now + 300);

    if (!claims.omitSub) {
      builder.setSubject(claims.sub ?? USER_ID);
    }

    return builder.sign(key.keyPair.privateKey);
  }

  function call(
    token: string | undefined,
  ): Promise<{ next: ReturnType<typeof vi.fn>; res: ReturnType<typeof createRes>; req: Request }> {
    const req = {
      headers: token === undefined ? {} : { authorization: token },
    } as unknown as Request;
    const res = createRes();
    const next = vi.fn();
    return authenticate(req, res, next).then(() => ({ next, res, req }));
  }

  function createRes(): Response {
    const res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return res as unknown as Response;
  }

  function expectUnauthorized(callResult: {
    next: ReturnType<typeof vi.fn>;
    res: ReturnType<typeof createRes>;
  }) {
    expect(callResult.next).not.toHaveBeenCalled();
    expect(callResult.res.status).toHaveBeenCalledWith(401);
    expect(callResult.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  }

  // ── valid tokens ─────────────────────────────────────────────────────

  it('accepts a valid token and attaches the verified auth context', async () => {
    const token = await signToken(signingKeys[0]!);
    const result = await call(`Bearer ${token}`);

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.res.status).not.toHaveBeenCalled();

    const auth = (result.req as Request & { auth?: AuthenticatedUser }).auth;
    expect(auth).toBeDefined();
    expect(auth?.userId).toBe(USER_ID);
    expect(auth?.issuer).toBe(ISSUER);
    expect(auth?.audience).toBe(AUDIENCE);
    expect(auth?.email).toBe('user@example.com');
    expect(auth?.emailVerified).toBe(true);
    expect(auth?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // ── missing / malformed ──────────────────────────────────────────────

  it('rejects a missing Authorization header with 401', async () => {
    expectUnauthorized(await call(undefined));
  });

  it('rejects a non-Bearer Authorization header with 401', async () => {
    expectUnauthorized(await call('Basic dXNlcjpwYXNz'));
  });

  it('rejects an empty Bearer token with 401', async () => {
    expectUnauthorized(await call('Bearer '));
  });

  it('rejects a syntactically invalid token with 401', async () => {
    expectUnauthorized(await call('Bearer not-a-real-jwt'));
  });

  // ── signature / claims ───────────────────────────────────────────────

  it('rejects a token signed by an unknown key (bad signature) with 401', async () => {
    const rogue = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'rogue-key' })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(rogue.privateKey);

    expectUnauthorized(await call(`Bearer ${token}`));
  });

  it('rejects an expired token with 401', async () => {
    const token = await signToken(signingKeys[0]!, { exp: Math.floor(Date.now() / 1000) - 3600 });
    expectUnauthorized(await call(`Bearer ${token}`));
  });

  it('rejects a token with a wrong issuer with 401', async () => {
    const token = await signToken(signingKeys[0]!, { iss: 'https://evil.example.com' });
    expectUnauthorized(await call(`Bearer ${token}`));
  });

  it('rejects a token with a wrong audience with 401', async () => {
    const token = await signToken(signingKeys[0]!, { aud: 'some-other-api' });
    expectUnauthorized(await call(`Bearer ${token}`));
  });

  it('rejects a token without a subject claim with 401', async () => {
    const token = await signToken(signingKeys[0]!, { omitSub: true });
    expectUnauthorized(await call(`Bearer ${token}`));
  });

  // ── key rotation ─────────────────────────────────────────────────────

  it('supports key rotation: verifies a token signed by a newly added key', async () => {
    // Warm the cache with key 1.
    const warmupToken = await signToken(signingKeys[0]!);
    const warmup = await call(`Bearer ${warmupToken}`);
    expect(warmup.next).toHaveBeenCalledOnce();

    // Rotate: serve key 2 as well; tokens signed with it have an unknown kid.
    servedKeys = signingKeys.map((key) => key.jwk);
    const rotatedToken = await signToken(signingKeys[1]!);

    const result = await call(`Bearer ${rotatedToken}`);
    expect(result.next).toHaveBeenCalledOnce();
    const auth = (result.req as Request & { auth?: AuthenticatedUser }).auth;
    expect(auth?.userId).toBe(USER_ID);
  });
});
