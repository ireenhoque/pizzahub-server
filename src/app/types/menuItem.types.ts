import type { BaseDocument, UserReference } from './common.types.js';

export const MENU_ITEM_STATUSES = ['active', 'inactive', 'out_of_stock'] as const;
export type MenuItemStatus = (typeof MENU_ITEM_STATUSES)[number];

export const MENU_ITEM_CATEGORIES = ['pizza', 'sides', 'drinks', 'desserts', 'combos'] as const;
export type MenuItemCategory = (typeof MENU_ITEM_CATEGORIES)[number];

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
  imageUrl?: string;
  prepMinutes?: number;

  status: MenuItemStatus;
  /** Instant toggle without touching `status` (e.g. temporary stock-out). */
  isAvailable: boolean;

  /** Aggregated rating, updated from reviews (never stored per-user here). */
  ratingAvg: number;
  ratingCount: number;
}
