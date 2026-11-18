import type { BaseDocument, UserReference } from './common.types.js';

/**
 * `pending` is the initial state: newly created items await admin approval
 * before becoming `active` (visible/purchasable in the storefront).
 */
export const MENU_ITEM_STATUSES = ['pending', 'active', 'inactive', 'out_of_stock'] as const;
export type MenuItemStatus = (typeof MENU_ITEM_STATUSES)[number];

export const MENU_ITEM_CATEGORIES = ['pizza', 'sides', 'drinks', 'desserts', 'combos'] as const;
export type MenuItemCategory = (typeof MENU_ITEM_CATEGORIES)[number];

/** Currency used for all menu prices. */
export const MENU_ITEM_CURRENCY = 'BDT' as const;

export interface MenuItem extends BaseDocument {
  /** Better Auth vendor `_id` — reference only; vendor data is NOT duplicated. */
  vendorId: UserReference;

  /** Searchable fields — indexed by the single text index on this collection. */
  name: string;
  description: string;
  tags: string[];

  category: MenuItemCategory;
  price: number;
  currency: string;
  /** Vendor outlet / delivery area for this item. */
  location: string;

  /** ImgBB URLs (upload happens server-side; the delete URL is secret). */
  imageUrl: string;
  imageThumbUrl?: string | null;
  /** ImgBB delete URL — stored but NEVER returned by any API. */
  imageDeleteUrl?: string | null;

  status: MenuItemStatus;
  /** Instant toggle without touching `status` (e.g. temporary stock-out). */
  isAvailable: boolean;

  prepMinutes?: number;

  /** Aggregated rating, updated from reviews (never stored per-user here). */
  ratingAvg: number;
  ratingCount: number;
}
