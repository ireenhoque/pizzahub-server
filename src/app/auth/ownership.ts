import type { Request, RequestHandler } from 'express';
import { ApiError } from '../error/ApiError.js';
import type { AuthenticatedUser } from './auth.types.js';
import { sendUnauthorized } from './authenticate.js';

/**
 * Reusable resource-ownership verification.
 *
 * Ownership is a server-side decision: the resource's owner id must come
 * from the database (via `resolveOwnerId`), and the actor must be the
 * DB-verified `req.auth.userId`. Client-supplied owner ids are ignored.
 */
export interface OwnershipOptions {
  /** When true, admins may access resources they do not own. */
  allowAdminBypass?: boolean;
}

/** True when `ownerId` is a non-empty string matching the verified user. */
export function isResourceOwner(auth: AuthenticatedUser, ownerId: unknown): boolean {
  return typeof ownerId === 'string' && ownerId.length > 0 && ownerId === auth.userId;
}

/** Central access decision — reuse from services, not just middleware. */
export function canAccessResource(
  auth: AuthenticatedUser,
  ownerId: unknown,
  options: OwnershipOptions = {},
): boolean {
  if (isResourceOwner(auth, ownerId)) {
    return true;
  }
  return options.allowAdminBypass === true && auth.roles.includes('admin');
}

/**
 * Throws a 403 ApiError unless the verified user owns the resource
 * (or admin bypass applies). Works inside any try/catch pipeline: the
 * centralized error handler renders the standard 403 body.
 */
export function assertOwnership(
  auth: AuthenticatedUser,
  ownerId: unknown,
  options: OwnershipOptions = {},
): void {
  if (!canAccessResource(auth, ownerId, options)) {
    throw new ApiError(403, 'You do not have permission to access this resource');
  }
}

/**
 * Ownership middleware.
 *
 * @param resolveOwnerId loads the resource's owner id from the database,
 *   e.g. `async (req) => (await getOrdersCollection().findOne(
 *     { _id: new ObjectId(req.params.id) }))?.vendorId`
 *   Returning null/undefined denies access (resource missing or no owner).
 */
export function requireOwnership(
  resolveOwnerId: (req: Request) => Promise<unknown>,
  options: OwnershipOptions = {},
): RequestHandler {
  return async (req, res, next): Promise<void> => {
    if (!req.auth) {
      sendUnauthorized(res, 'Authentication required');
      return;
    }

    try {
      const ownerId = await resolveOwnerId(req);
      assertOwnership(req.auth, ownerId, options);
      next();
    } catch (error) {
      next(error);
    }
  };
}
