import { z } from 'zod';
import { MENU_ITEM_CATEGORIES } from '../../types/menuItem.types.js';

/**
 * Menu item creation schema (multipart text fields — everything arrives as
 * a string, hence the coercions).
 *
 * STRICT by design: `vendorId` and `status` are NOT part of the schema, so
 * any client attempt to supply them (or any other unknown field) is rejected
 * with 400. The service sets vendorId from the verified JWT and status to
 * 'pending' unconditionally.
 */
export const createMenuItemSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(3, 'Name must be at least 3 characters')
    .max(100, 'Name must be at most 100 characters'),
  category: z.enum(MENU_ITEM_CATEGORIES),
  description: z
    .string()
    .trim()
    .min(10, 'Description must be at least 10 characters')
    .max(1000, 'Description must be at most 1000 characters'),
  price: z.coerce
    .number()
    .positive('Price must be greater than 0')
    .max(10_000_000, 'Price is unreasonably high'),
  location: z
    .string()
    .trim()
    .min(3, 'Location must be at least 3 characters')
    .max(200, 'Location must be at most 200 characters'),
});
