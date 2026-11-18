import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { getUsersCollection } from '../db/collections.js';
import {
  AuthenticationFailure,
  buildVerifiedContext,
  createRemoteJwks,
  respondWithFailure,
  sendUnauthorized,
  verifyBearerToken,
  type JwtAuthOptions,
} from './authenticate.js';
import type { BetterAuthUser } from './auth.types.js';
import { USER_ROLES, type UserRole } from '../types/common.types.js';

/**
 * Server-side authorization for PizzaHub.
 *
 * `requireAuth` verifies the Better Auth JWT AND resolves the current user
 * from the Better Auth-managed `users` collection in MongoDB on every
 * protected request. Role and blocked status are therefore always read from
 * the database — never from the token payload, request body, query string
 * or client headers.
 */
export interface UserLookupService {
  findUserById(userId: string): Promise<BetterAuthUser | null>;
}

/**
 * Default lookup against the Better Auth `users` collection.
 * Better Auth ids are strings, but ObjectId-stored ids are tolerated.
 */
export const defaultUserLookup: UserLookupService = {
  async findUserById(userId: string): Promise<BetterAuthUser | null> {
    const users = getUsersCollection();

    const asString = await users.findOne({ _id: userId });
    if (asString) {
      return asString;
    }

    if (/^[0-9a-f]{24}$/i.test(userId)) {
      return users.findOne({ _id: new ObjectId(userId) });
    }

    return null;
  },
};

/** Blocked = PizzaHub `isBlocked`, or Better Auth admin-plugin `banned`. */
export function isUserBlocked(user: BetterAuthUser): boolean {
  if (user.isBlocked === true) {
    return true;
  }

  if (user.banned === true) {
    // `banExpires` marks a temporary ban: once it has passed, the user is
    // no longer blocked. Missing/NaN expiry means a permanent ban.
    if (user.banExpires === undefined) {
      return true;
    }
    const expiry =
      typeof user.banExpires === 'number' ? user.banExpires : user.banExpires.getTime();
    return Number.isNaN(expiry) || expiry > Date.now();
  }

  return false;
}

/** Normalizes the DB role into the recognized PizzaHub vocabulary. */
export function normalizeRoles(user: BetterAuthUser): UserRole[] {
  const raw = Array.isArray(user.role) ? user.role : user.role ? [user.role] : [];
  const roles = raw.filter((role): role is UserRole =>
    (USER_ROLES as readonly string[]).includes(role),
  );

  // Better Auth's generic default ('user') maps to PizzaHub's default role.
  return roles.length > 0 ? roles : ['customer'];
}

/**
 * Builds `requireAuth`: JWT verification + fresh DB user resolution.
 *
 * - 401: missing/malformed/expired/invalid token, or subject no longer
 *   exists in the users collection.
 * - 403: the account is blocked.
 * - 500 (via next(error)): unexpected database failures.
 */
export function createRequireAuth(
  options: JwtAuthOptions,
  lookup: UserLookupService = defaultUserLookup,
): RequestHandler {
  const remoteJWKSet = createRemoteJwks(options);

  return async (req, res, next): Promise<void> => {
    try {
      const payload = await verifyBearerToken(req, remoteJWKSet, options);
      const dbUser = await lookup.findUserById(payload.sub as string);

      if (!dbUser) {
        sendUnauthorized(res, 'Authentication failed: account not found');
        return;
      }

      if (isUserBlocked(dbUser)) {
        res.status(403).json({ success: false, message: 'Your account has been blocked' });
        return;
      }

      const roles = normalizeRoles(dbUser);
      const verified = buildVerifiedContext(payload);

      req.auth = {
        ...verified,
        // DB values win over token claims (fresher and server-controlled).
        email: dbUser.email ?? verified.email,
        emailVerified: dbUser.emailVerified ?? verified.emailVerified,
        role: roles[0]!,
        roles,
      };
      next();
    } catch (error) {
      if (error instanceof AuthenticationFailure) {
        respondWithFailure(res, error);
        return;
      }
      // Unexpected (e.g. database) failure → centralized error handler → 500.
      next(error);
    }
  };
}

/**
 * Role gate. MUST run after `requireAuth` (it responds 401 when
 * `req.auth` is missing). Roles come exclusively from the DB-verified
 * `req.auth.roles` — client-supplied roles are never considered.
 */
export function requireRole(...allowed: UserRole[]): RequestHandler {
  if (allowed.length === 0) {
    throw new Error('requireRole() requires at least one role');
  }

  return (req, res, next): void => {
    const auth = req.auth;

    if (!auth) {
      sendUnauthorized(res, 'Authentication required');
      return;
    }

    if (!allowed.some((role) => auth.roles.includes(role))) {
      res.status(403).json({ success: false, message: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

/** Convenience presets for the three PizzaHub roles. */
export const requireAdmin = requireRole('admin');
export const requireVendor = requireRole('vendor');
export const requireCustomer = requireRole('customer');

/** Env-wired instance used when mounting protected business routes. */
export const requireAuth = createRequireAuth({
  jwksUrl: env.betterAuthJwksUrl,
  issuer: env.jwtIssuer,
  audience: env.jwtAudience,
});
