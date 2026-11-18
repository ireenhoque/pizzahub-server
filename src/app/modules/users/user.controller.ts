import type { RequestHandler } from 'express';
import { getAuthenticatedUser } from '../../auth/require-auth.js';
import { ApiError } from '../../error/ApiError.js';
import { userService } from './user.service.js';
import type { ListUsersQuery, UpdateSelfInput } from './user.types.js';

/**
 * User & profile controllers. `req.auth` is guaranteed by `requireAuth`;
 * identity comes exclusively from the verified JWT + DB lookup, never from
 * request bodies or client headers.
 */

/** GET /api/users/me */
export const getCurrentUser: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuthenticatedUser(req);
    const user = await userService.getUserById(auth.userId);

    if (!user) {
      // requireAuth already rejects missing users; this is a safety net.
      throw new ApiError(404, 'User not found');
    }

    res.status(200).json({ success: true, message: 'Current user retrieved', data: { user } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/users/me — only whitelisted profile fields are accepted. */
export const updateCurrentUser: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuthenticatedUser(req);
    const updates = req.body as UpdateSelfInput; // validated by updateSelfSchema

    const user = await userService.updateCurrentUser(auth.userId, updates);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    res.status(200).json({ success: true, message: 'Profile updated', data: { user } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/users — admin-only listing with search, role filter, pagination. */
export const listUsers: RequestHandler = async (req, res, next) => {
  try {
    getAuthenticatedUser(req); // admin check done by requireAdmin middleware
    const query = req.validatedQuery as ListUsersQuery;

    const result = await userService.listUsers(query);
    res.status(200).json({ success: true, message: 'Users retrieved', data: result });
  } catch (error) {
    next(error);
  }
};

/** POST /api/users/:id/block — admin-only. */
export const blockUser: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuthenticatedUser(req);
    const { id } = req.validatedParams as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };

    const user = await userService.blockUser(id, auth.userId, reason);
    res.status(200).json({ success: true, message: 'User blocked', data: { user } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/users/:id/unblock — admin-only. */
export const unblockUser: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuthenticatedUser(req);
    const { id } = req.validatedParams as { id: string };

    const user = await userService.unblockUser(id, auth.userId);
    res.status(200).json({ success: true, message: 'User unblocked', data: { user } });
  } catch (error) {
    next(error);
  }
};
