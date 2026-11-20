import { z } from 'zod';
import { PAYMENT_STATUSES } from '../../types/common.types.js';
import { TRANSACTION_TYPES } from '../../types/transaction.types.js';

export const TRANSACTION_SORT_FIELDS = ['createdAt', 'amount', 'updatedAt'] as const;

const dateQuery = z
  .string()
  .trim()
  .min(1, 'Date cannot be empty')
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid date' })
  .transform((value) => new Date(value));

export const listTransactionsQuerySchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(100).optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    type: z.enum(TRANSACTION_TYPES).optional(),
    sortBy: z.enum(TRANSACTION_SORT_FIELDS).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    from: dateQuery.optional(),
    to: dateQuery.optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'from cannot be later than to',
    path: ['from'],
  });
