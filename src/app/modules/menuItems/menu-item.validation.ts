import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { MENU_ITEM_CATEGORIES, MENU_ITEM_STATUSES } from '../../types/menuItem.types.js';

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

/** Shared pagination shape for list endpoints. */
const paginationShape = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
} as const;

const searchShape = {
  search: z.string().trim().min(1).max(100).optional(),
} as const;

const categoryShape = {
  category: z.enum(MENU_ITEM_CATEGORIES).optional(),
} as const;

/** GET /api/menu-items — public storefront listing. */
export const publicListMenuItemsQuerySchema = z.strictObject({
  ...paginationShape,
  ...categoryShape,
  ...searchShape,
});

/** GET /api/menu-items/mine — vendor's own items, optional status filter. */
export const vendorListMenuItemsQuerySchema = z.strictObject({
  ...paginationShape,
  status: z.enum(MENU_ITEM_STATUSES).optional(),
});

/** GET /api/menu-items/admin — review filters for the admin console. */
export const adminListMenuItemsQuerySchema = z.strictObject({
  ...paginationShape,
  status: z.enum(MENU_ITEM_STATUSES).optional(),
  vendorId: z.string().trim().min(1).max(200).optional(),
  ...categoryShape,
  ...searchShape,
});

/** Mongo ObjectId route parameter — invalid ids are rejected with 400. */
export const menuItemIdParamSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1, 'Menu item id is required')
    .refine((value) => ObjectId.isValid(value), { message: 'Invalid menu item id' }),
});

/**
 * Vendor update schema (JSON body).
 *
 * STRICT by design: `status`, `vendorId`, ratings and image URLs are NOT
 * part of the schema, so any client attempt to supply them is rejected with
 * 400. Status transitions belong exclusively to the admin endpoint.
 */
export const updateVendorMenuItemSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(3, 'Name must be at least 3 characters')
    .max(100, 'Name must be at most 100 characters')
    .optional(),
  description: z
    .string()
    .trim()
    .min(10, 'Description must be at least 10 characters')
    .max(1000, 'Description must be at most 1000 characters')
    .optional(),
  category: z.enum(MENU_ITEM_CATEGORIES).optional(),
  price: z.coerce
    .number()
    .positive('Price must be greater than 0')
    .max(10_000_000, 'Price is unreasonably high')
    .optional(),
  location: z
    .string()
    .trim()
    .min(3, 'Location must be at least 3 characters')
    .max(200, 'Location must be at most 200 characters')
    .optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10, 'At most 10 tags are allowed').optional(),
  isAvailable: z.boolean().optional(),
});

/** PATCH /api/menu-items/admin/:id/status — admin review decision. */
export const adminSetMenuItemStatusSchema = z.strictObject({
  status: z.enum(MENU_ITEM_STATUSES),
});
