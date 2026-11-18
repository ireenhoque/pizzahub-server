import { z } from 'zod';
import { MENU_ITEM_CATEGORIES } from '../../types/menuItem.types.js';

/** Pagination common shape */
const paginationShape = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
} as const;

/** Validate line items for order creation */
export const createOrderSchema = z.object({
  lineItems: z.array(
    z.object({
      menuItemId: z.string().trim().min(1),
      quantity: z.coerce.number().int().min(1),
    })
  ).min(1),
  deliveryAddress: z.string().trim().min(5),
  contactPhone: z.string().trim().min(5).max(20).optional(),
  notes: z.string().trim().max(500).optional(),
});

/** Pagination for listing orders */
export const orderListQuerySchema = z.object({
  ...paginationShape,
});

