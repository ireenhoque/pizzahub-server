import { ObjectId, type Filter } from 'mongodb';
import { findBetterAuthUserById, getMenuItemsCollection } from '../../db/collections.js';
import { ApiError } from '../../error/ApiError.js';
import type { AuthenticatedUser } from '../../auth/auth.types.js';
import { assertOwnership } from '../../auth/ownership.js';
import { hasActivePremiumSubscription } from '../users/user.service.js';
import {
  MENU_ITEM_CURRENCY,
  type MenuItem,
  type MenuItemStatus,
} from '../../types/menuItem.types.js';
import { escapeRegex } from '../../utils/regex.js';
import { uploadToImgBB } from '../../utils/imgbb.js';
import type {
  AdminListMenuItemsQuery,
  CreateMenuItemInput,
  ListMenuItemsResult,
  PublicListMenuItemsQuery,
  PublicMenuItem,
  UploadImageFn,
  VendorListMenuItemsQuery,
  VendorUpdateMenuItemInput,
} from './menu-item.types.js';

/** Free-plan vendors can keep at most this many `active` menu items. */
export const FREE_PLAN_MAX_ACTIVE_MENU_ITEMS = 3;

/** Whitelist serializer — the ImgBB delete URL is NEVER included. */
export function toPublicMenuItem(item: MenuItem): PublicMenuItem {
  return {
    id: String(item._id),
    vendorId: item.vendorId,
    name: item.name,
    description: item.description,
    category: item.category,
    price: item.price,
    currency: item.currency,
    location: item.location,
    imageUrl: item.imageUrl,
    imageThumbUrl: item.imageThumbUrl ?? null,
    status: item.status,
    isAvailable: item.isAvailable,
    ratingAvg: item.ratingAvg,
    ratingCount: item.ratingCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export const menuItemService = {
  /**
   * Creates a menu item for the authenticated vendor.
   *
   * - `vendorId` comes from the verified JWT/DB auth context — never from
   *   the request body.
   * - `status` is always 'pending' (admin approval flow) — never from the
   *   request body.
   * - Quota: free vendors (or expired premium) may hold at most
   *   FREE_PLAN_MAX_ACTIVE_MENU_ITEMS `active` items; an active premium
   *   subscription removes the cap.
   * - The image is uploaded server-side to ImgBB; upload failures become
   *   502 ApiErrors and no item is persisted.
   */
  async createMenuItem(
    vendor: AuthenticatedUser,
    input: CreateMenuItemInput,
    image: { buffer: Buffer; originalname: string; mimetype: string },
    uploadImage: UploadImageFn = uploadToImgBB,
  ): Promise<PublicMenuItem> {
    // Fresh user document: subscription plan and expiration are DB state.
    const vendorDoc = await findBetterAuthUserById(vendor.userId);
    if (!vendorDoc) {
      throw new ApiError(404, 'Vendor account not found');
    }

    if (!hasActivePremiumSubscription(vendorDoc)) {
      const activeCount = await getMenuItemsCollection().countDocuments({
        vendorId: vendor.userId,
        status: 'active',
      });

      if (activeCount >= FREE_PLAN_MAX_ACTIVE_MENU_ITEMS) {
        throw new ApiError(
          403,
          `Your current plan allows at most ${FREE_PLAN_MAX_ACTIVE_MENU_ITEMS} active menu items. ` +
            'Upgrade to a premium subscription for unlimited items.',
        );
      }
    }

    let uploaded;
    try {
      uploaded = await uploadImage(image);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      // Never log the raw error/details here — they could contain the API key.
      console.error('Image upload failed:', error instanceof Error ? error.name : 'unknown error');
      throw new ApiError(502, 'Image upload failed');
    }

    const now = new Date();
    const doc: Omit<MenuItem, '_id'> = {
      vendorId: vendor.userId,
      name: input.name,
      description: input.description,
      tags: [],
      category: input.category,
      price: input.price,
      currency: MENU_ITEM_CURRENCY,
      location: input.location,
      imageUrl: uploaded.imageUrl,
      imageThumbUrl: uploaded.thumbUrl ?? null,
      imageDeleteUrl: uploaded.deleteUrl ?? null,
      status: 'pending',
      isAvailable: false, // until an admin approves the item
      ratingAvg: 0,
      ratingCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = await getMenuItemsCollection().insertOne(doc as MenuItem);

    return toPublicMenuItem({ ...doc, _id: result.insertedId } as MenuItem);
  },


  /**
   * Public storefront listing — ONLY `active` items. `pending`, `rejected`,
   * `inactive` and `out_of_stock` documents are structurally excluded by the
   * status filter, so no review-state item can ever leak into public
   * results.
   */
  // Public storefront listing — ONLY `active` and `isAvailable` items with advanced filtering & sorting.
  listPublicMenuItems: async (query: PublicListMenuItemsQuery): Promise<ListMenuItemsResult> => {
    // Base filter ensures only approved & available items are shown.
    const baseFilter: Filter<MenuItem> = { status: 'active', isAvailable: true } as any;

    // Category filter.
    if (query.category) {
      baseFilter.category = query.category;
    }

    // Location filter – case‑insensitive partial match.
    if (query.location) {
      baseFilter.location = { $regex: escapeRegex(query.location), $options: 'i' } as any;
    }

    // Price range filter.
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const priceFilter: any = {};
      if (query.minPrice !== undefined) priceFilter.$gte = query.minPrice;
      if (query.maxPrice !== undefined) priceFilter.$lte = query.maxPrice;
      baseFilter.price = priceFilter;
    }

    // Apply name/description search (adds $or clause).
    const filterWithSearch = buildSearchFilter(baseFilter, query.search, query.category);

    // Sorting – use requested field and order; default fallback handled in paginateMenuItems.
    const sortSpec: Record<string, 1 | -1> = {
      [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1,
    };

    return paginateMenuItems(filterWithSearch, query, sortSpec);
  },
  /** Vendor listing — own items only, every status, optional status filter. */
  async listVendorMenuItems(
    vendorId: string,
    query: VendorListMenuItemsQuery,
  ): Promise<ListMenuItemsResult> {
    const filter: Filter<MenuItem> = { vendorId };
    if (query.status) {
      filter.status = query.status;
    }
    return paginateMenuItems(filter, query);

  /** Admin listing — every item, filterable by status/vendor/category/search. */
  async listAllMenuItemsForAdmin(query: AdminListMenuItemsQuery): Promise<ListMenuItemsResult> {
    const filter: Filter<MenuItem> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.vendorId) {
      filter.vendorId = query.vendorId;
    }
    return paginateMenuItems(buildSearchFilter(filter, query.search, query.category), query);

  /**
   * Role-aware detail lookup.
   *
   * - admins see everything;
   * - vendors see their OWN items in any state (ownership check);
   * - everyone else only sees `active` items — anything else returns null
   *   (rendered as 404, so the existence of pending/rejected items is never
   *   revealed).
   */
  async getMenuItemForViewer(
    id: string,
    viewer: AuthenticatedUser | null,
  ): Promise<PublicMenuItem | null> {
    const item = await getMenuItemsCollection().findOne({ _id: toMenuItemId(id) });
    if (!item) {
      return null;
    }

    if (viewer?.roles.includes('admin')) {
      return toPublicMenuItem(item);
    }

    if (viewer?.roles.includes('vendor') && item.vendorId === viewer.userId) {
      return toPublicMenuItem(item);
    }

    if (item.status !== 'active') {
      return null;
    }

    return toPublicMenuItem(item);

  /**
   * Vendor update of THEIR OWN item. Ownership is verified from the DB
   * document; non-owners get 403. Only whitelisted fields are applied —
   * status/vendorId/ratings/image URLs are structurally unreachable.
   */
  async updateMenuItemByVendor(
    vendor: AuthenticatedUser,
    id: string,
    updates: VendorUpdateMenuItemInput,
  ): Promise<PublicMenuItem> {
    const items = getMenuItemsCollection();
    const item = await items.findOne({ _id: toMenuItemId(id) });
    if (!item) {
      throw new ApiError(404, 'Menu item not found');
    }

    assertOwnership(vendor, item.vendorId);

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.description !== undefined) set.description = updates.description;
    if (updates.category !== undefined) set.category = updates.category;
    if (updates.price !== undefined) set.price = updates.price;
    if (updates.location !== undefined) set.location = updates.location;
    if (updates.tags !== undefined) set.tags = updates.tags;
    if (updates.isAvailable !== undefined) set.isAvailable = updates.isAvailable;

    await items.updateOne({ _id: item._id }, { $set: set });

    const updated = await items.findOne({ _id: item._id });
    if (!updated) {
      throw new ApiError(404, 'Menu item not found');
    }
    return toPublicMenuItem(updated);

  /**
   * Vendor delete of THEIR OWN item (hard delete). Ownership verified from
   * the DB document; missing items 404, non-owners 403.
   */
  async deleteMenuItemByVendor(vendor: AuthenticatedUser, id: string): Promise<PublicMenuItem> {
    const items = getMenuItemsCollection();
    const item = await items.findOne({ _id: toMenuItemId(id) });
    if (!item) {
      throw new ApiError(404, 'Menu item not found');
    }

    assertOwnership(vendor, item.vendorId);

    await items.deleteOne({ _id: item._id });
    return toPublicMenuItem(item);

  /**
   * Admin status management (approve → 'active', reject → 'rejected',
   * re-submit → 'pending', etc.). Approval also flips `isAvailable` to true
   * so approved items are immediately live; other transitions leave vendor
   * availability untouched.
   */
  async setMenuItemStatus(id: string, status: MenuItemStatus): Promise<PublicMenuItem> {
    const items = getMenuItemsCollection();
    const item = await items.findOne({ _id: toMenuItemId(id) });
    if (!item) {
      throw new ApiError(404, 'Menu item not found');
    }

    const set: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === 'active') {
      set.isAvailable = true;
    }

    await items.updateOne({ _id: item._id }, { $set: set });

    const updated = await items.findOne({ _id: item._id });
    if (!updated) {
      throw new ApiError(404, 'Menu item not found');
    }
    return toPublicMenuItem(updated);
};

/** Validates a route id as a Mongo ObjectId (invalid ids → 400 ApiError). */
function toMenuItemId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) {
    throw new ApiError(400, 'Invalid menu item id');
  }
  return new ObjectId(id);
}

/** Builds the shared text-search filter (escaped regex on name/description). */
function buildSearchFilter(
  base: Filter<MenuItem>,
  search?: string,
  category?: MenuItem['category'],
): Filter<MenuItem> {
  const filter: Filter<MenuItem> = { ...base };
  if (category) {
    filter.category = category;
  }
  if (search) {
    const pattern = escapeRegex(search);
    filter.$or = [
      { name: { $regex: pattern, $options: 'i' } },
      { description: { $regex: pattern, $options: 'i' } },
    ];
  }
  return filter;
}

/** Paginates a menu item filter, newest first. */
async function paginateMenuItems(
  filter: Filter<MenuItem>,
  query: { page: number; limit: number },
  sortSpec?: Record<string, 1 | -1>,
): Promise<ListMenuItemsResult> {
  const items = getMenuItemsCollection();
  const total = await items.countDocuments(filter);
  const skip = (query.page - 1) * query.limit;

  const cursor = items
    .find(filter)
    .sort(sortSpec ?? { createdAt: -1, _id: 1 })
    .skip(skip)
    .limit(query.limit);

  const docs = await cursor.toArray();

  return {
    items: docs.map(toPublicMenuItem),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
}
