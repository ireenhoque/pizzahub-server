import type { RequestHandler, Response } from 'express';
import type { AuthenticatedUser } from './auth.types.js';
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
 * Builds the Better Auth JWT authentication middleware.
 *
 * - Verifies signature (against the remote JWKS), algorithm, issuer,
 *   audience and expiration on every request.
 * - Extracts the user id ONLY from the verified `sub` claim. User ids, roles
 *   or blocked statuses sent in the request body, query string or custom
 *   headers are NEVER trusted.
 * - Responds 401 for any authentication failure (missing, malformed,
 *   expired, invalid signature or claims) and 503 when the JWKS endpoint is
 *   unreachable.
 *
 * JWKS caching and key rotation are handled by `createRemoteJWKSet`:
 * keys are cached, re-fetched when an unknown `kid` appears (rate-limited by
 * `cooldownDuration`) and force-refreshed after `cacheMaxAge`, so Better Auth
 * key rotation is picked up automatically without restarts.
 */
export function createJwtAuthMiddleware(options: JwtAuthOptions): RequestHandler {
  // Fail fast at wiring time if the URL is malformed.
  const jwksUrl = new URL(options.jwksUrl);
  const algorithms = options.algorithms ?? DEFAULT_ALGORITHMS;

  const remoteJWKSet: RemoteJWKSet = createRemoteJWKSet(jwksUrl, {
    cooldownDuration: options.cooldownDuration ?? 30_000,
    cacheMaxAge: options.cacheMaxAge ?? 600_000,
  });

  const authenticate: RequestHandler = async (req, res, next): Promise<void> => {
    // Credentials are accepted ONLY from the Authorization: Bearer header.
    const header = req.headers.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      sendUnauthorized(res, 'Authentication token is missing');
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      sendUnauthorized(res, 'Authentication token is missing');
      return;
    }

    try {
      const { payload } = await jwtVerify(token, remoteJWKSet, {
        algorithms: [...algorithms],
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: 5, // seconds of leeway for clock skew
        requiredClaims: ['sub', 'exp'],
      });

      const authenticated = buildAuthenticatedUser(payload);
      if (!authenticated) {
        sendUnauthorized(res, 'Invalid authentication token');
        return;
      }

      req.auth = authenticated;
      next();
    } catch (error) {
      // Log only the failure reason — never the raw token (it is a credential).
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      console.warn(`JWT authentication failed: ${reason}`);

      if (isJwksUnavailable(error)) {
        res.status(503).json({
          success: false,
          message: 'Authentication service temporarily unavailable',
        });
        return;
      }

      sendUnauthorized(res, 'Invalid or expired authentication token');
    }
  };

  return authenticate;
}

/** 401 with the RFC 6750 `WWW-Authenticate` header. */
function sendUnauthorized(res: Response, message: string): void {
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer error="invalid_token"')
    .json({ success: false, message });
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
 * Maps a verified payload onto the request-scoped auth context.
 * Returns null if the required identity claims are missing/malformed.
 */
function buildAuthenticatedUser(payload: JWTPayload): AuthenticatedUser | null {
  const { sub, iss, aud, exp, iat, email, email_verified } = payload;

  if (typeof sub !== 'string' || sub.length === 0) {
    return null;
  }

  return {
    userId: sub,
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
