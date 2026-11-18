import type { Request, RequestHandler, Response } from 'express';
import type { VerifiedJwtContext } from './auth.types.js';
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type RemoteJWKSet,
} from 'jose';

/**
 * Better Auth's JWT plugin signs tokens with RS256. The allowed algorithm
 * list is PINNED so tokens claiming `alg: none` or an HMAC algorithm can
 * never pass verification (algorithm confusion attacks).
 */
const DEFAULT_ALGORITHMS = ['RS256'] as const;

export interface JwtAuthOptions {
  /** Better Auth JWT plugin JWKS endpoint (e.g. https://auth.example.com/api/auth/jwks). */
  jwksUrl: string;
  /** Expected `iss` claim. */
  issuer: string;
  /** Expected `aud` claim. */
  audience: string;
  /** Allowed signature algorithms. Defaults to RS256 only. */
  algorithms?: readonly string[];
  /**
   * ms after a successful JWKS fetch before an unmatched key may trigger a
   * re-fetch. This is the key-rotation window (default 30s, per jose).
   */
  cooldownDuration?: number;
  /** Max ms a cached JWKS stays valid before a forced refresh (default 10min). */
  cacheMaxAge?: number;
}

/**
 * A decided authentication failure.
 * 401 → the client's fault (missing/malformed/expired/invalid token).
 * 503 → infrastructure fault (JWKS endpoint unreachable).
 */
export class AuthenticationFailure extends Error {
  constructor(
    readonly statusCode: 401 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'AuthenticationFailure';
  }
}

/** Creates the caching remote JWKS resolver (key-rotation aware). */
export function createRemoteJwks(options: JwtAuthOptions): RemoteJWKSet {
  // Fail fast at wiring time if the URL is malformed.
  const jwksUrl = new URL(options.jwksUrl);

  return createRemoteJWKSet(jwksUrl, {
    cooldownDuration: options.cooldownDuration ?? 30_000,
    cacheMaxAge: options.cacheMaxAge ?? 600_000,
  });
}

/**
 * Verifies the `Authorization: Bearer` token against the remote JWKS.
 *
 * - Credentials are accepted ONLY from the Authorization header. Anything in
 *   the request body, query string or custom headers claiming to be a user
 *   id or role is NEVER trusted.
 * - Verifies signature, algorithm, issuer, audience and expiration, and
 *   requires the `sub` and `exp` claims.
 *
 * Throws `AuthenticationFailure` (never responds directly) so both the
 * token-only middleware and the DB-backed requireAuth can share it.
 */
export async function verifyBearerToken(
  req: Request,
  remoteJWKSet: RemoteJWKSet,
  options: JwtAuthOptions,
): Promise<JWTPayload> {
  const header = req.headers.authorization;

  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new AuthenticationFailure(401, 'Authentication token is missing');
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AuthenticationFailure(401, 'Authentication token is missing');
  }

  try {
    const { payload } = await jwtVerify(token, remoteJWKSet, {
      algorithms: [...(options.algorithms ?? DEFAULT_ALGORITHMS)],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: 5, // seconds of leeway for clock skew
      requiredClaims: ['sub', 'exp'],
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AuthenticationFailure(401, 'Invalid authentication token');
    }

    return payload;
  } catch (error) {
    if (error instanceof AuthenticationFailure) {
      throw error;
    }

    // Log only the failure reason — never the raw token (it is a credential).
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    console.warn(`JWT verification failed: ${reason}`);

    if (isJwksUnavailable(error)) {
      throw new AuthenticationFailure(503, 'Authentication service temporarily unavailable');
    }

    throw new AuthenticationFailure(401, 'Invalid or expired authentication token');
  }
}

/**
 * Maps a verified payload onto the token-only context.
 * Callers must ensure `sub` is a string (verifyBearerToken guarantees it).
 */
export function buildVerifiedContext(payload: JWTPayload): VerifiedJwtContext {
  const { sub, iss, aud, exp, iat, email, email_verified } = payload;

  return {
    userId: sub as string,
    email: typeof email === 'string' ? email : undefined,
    emailVerified: typeof email_verified === 'boolean' ? email_verified : undefined,
    issuer: typeof iss === 'string' ? iss : '',
    audience:
      typeof aud === 'string'
        ? aud
        : Array.isArray(aud) && typeof aud[0] === 'string'
          ? aud[0]
          : '',
    issuedAt: typeof iat === 'number' ? new Date(iat * 1000) : new Date(0),
    expiresAt: typeof exp === 'number' ? new Date(exp * 1000) : new Date(0),
  };
}

/** 401 with the RFC 6750 `WWW-Authenticate` header. */
export function sendUnauthorized(res: Response, message: string): void {
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer error="invalid_token"')
    .json({ success: false, message });
}

/** Responds with the decided status of an AuthenticationFailure. */
export function respondWithFailure(res: Response, failure: AuthenticationFailure): void {
  if (failure.statusCode === 401) {
    sendUnauthorized(res, failure.message);
    return;
  }
  res.status(failure.statusCode).json({ success: false, message: failure.message });
}

/**
 * True when verification failed because the JWKS endpoint could not be
 * reached (network error or fetch timeout) — an infrastructure problem, not
 * the client's fault, so it maps to 503 instead of 401.
 */
function isJwksUnavailable(error: unknown): boolean {
  return error instanceof joseErrors.JWKSTimeout || error instanceof TypeError;
}

/**
 * Token-only authentication middleware: verifies the JWT and attaches the
 * verified token context to `req.jwt`. It performs NO database lookups —
 * role/block checks and `req.auth` belong to `requireAuth`.
 *
 * JWKS caching and key rotation are handled by `createRemoteJWKSet`: keys
 * are cached, re-fetched when an unknown `kid` appears (rate-limited by
 * `cooldownDuration`) and force-refreshed after `cacheMaxAge`, so Better
 * Auth key rotation is picked up automatically without restarts.
 */
export function createJwtAuthMiddleware(options: JwtAuthOptions): RequestHandler {
  const remoteJWKSet = createRemoteJwks(options);

  return async (req, res, next): Promise<void> => {
    try {
      const payload = await verifyBearerToken(req, remoteJWKSet, options);
      req.jwt = buildVerifiedContext(payload);
      next();
    } catch (error) {
      if (error instanceof AuthenticationFailure) {
        respondWithFailure(res, error);
        return;
      }
      next(error);
    }
  };
}
