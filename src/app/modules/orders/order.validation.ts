import { z } from 'zod';
import { ObjectId } from 'mongodb';

/** Pagination common shape */
const paginationShape = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
} as const;

/** Validate line items for order creation */
export const createOrderSchema = z.object({
  lineItems: z
    .array(
      z.object({
        // Menu items are MongoDB documents — an invalid id would otherwise
        // throw a BSON error (500) deep inside the order service.
        menuItemId: z
          .string()
          .trim()
          .min(1)
          .refine((value) => ObjectId.isValid(value), {
            message: 'menuItemId must be a valid MongoDB ObjectId',
          }),
        quantity: z.coerce.number().int().min(1),
      }),
    )
    .min(1)
    // Bound the payload so a single request cannot stream unbounded work.
    .max(50),
  deliveryAddress: z.string().trim().min(5),
  contactPhone: z.string().trim().min(5).max(20).optional(),
  notes: z.string().trim().max(500).optional(),
});

/** Pagination for listing orders */
export const orderListQuerySchema = z.object({
  ...paginationShape,
});

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

/** Vendor/admin status update. `cart` is a customer-owned state and cannot be set here. */
export const updateOrderStatusSchema = z.object({
  status: z.enum(['placed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled']),
});

export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
