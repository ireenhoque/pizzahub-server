import { z } from 'zod';
import { USER_ROLES } from '../../types/common.types.js';

/**
 * Zod schemas for the user/profile APIs.
 *
 * Self-update schema is STRICT: any attempt to send `role`, `isBlocked`,
 * `subscriptionPlan`, `subscriptionExpiresAt` or any other unknown field is
 * rejected with 400 — privilege escalation via self-service is impossible.
 * (The service additionally builds its update from a whitelist, so these
 * fields can never reach MongoDB even if validation were bypassed.)
 */

export const updateSelfSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'Name cannot be empty')
    .max(100, 'Name must be at most 100 characters')
    .optional(),
  image: z.union([z.string().max(2048), z.null()]).optional(),
});

export const listUsersQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Case-insensitive search across name AND email. */
  search: z.string().trim().min(1).max(100).optional(),
  role: z.enum(USER_ROLES).optional(),
});

export const idParamSchema = z.strictObject({
  id: z.string().trim().min(1, 'User id is required'),
});

export const blockUserSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});
