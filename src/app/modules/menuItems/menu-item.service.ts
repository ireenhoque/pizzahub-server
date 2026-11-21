import { ObjectId, type Filter } from 'mongodb';
import {
  findBetterAuthUserById,
  getMenuItemsCollection,
  getUsersCollection,
} from '../../db/collections.js';
import { ApiError } from '../../error/ApiError.js';
import type { AuthenticatedUser, BetterAuthUser } from '../../auth/auth.types.js';
import { assertOwnership } from '../../auth/ownership.js';
import { hasActivePremiumSubscription } from '../users/user.service.js';
import {
  MENU_ITEM_CURRENCY,
  type MenuItem,
  type MenuItemStatus,
} from '../../types/menuItem.types.js';
import { escapeRegex } from '../../utils/regex.js';
import { uploadToImgBB } from '../../utils/imgbb.js';
import {
  assertCanAddActiveMenuItem,
  freePlanLimitMessage,
  FREE_PLAN_MAX_ACTIVE_MENU_ITEMS,
  withMenuQuotaLock,
} from './free-plan-limit.js';
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

/** Re-exported for existing consumers/tests; the rule lives in free-plan-limit.ts. */
export { FREE_PLAN_MAX_ACTIVE_MENU_ITEMS } from './free-plan-limit.js';

/** Whitelist serializer — the ImgBB delete URL and private vendor fields are NEVER included. */
export function toPublicMenuItem(item: MenuItem, isPremium = false): PublicMenuItem {
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
    isPremium,
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
        throw new ApiError(403, freePlanLimitMessage());
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

    // Authoritative re-check inside the vendor lock. The fast check above
    // avoids a pointless image upload; this one closes the check-then-insert
    // race with concurrent admin approvals for the same vendor.
    const insertedId = await withMenuQuotaLock(vendor.userId, async (session) => {
      await assertCanAddActiveMenuItem(vendor.userId, session);
      const result = await getMenuItemsCollection().insertOne(doc as MenuItem, { session });
      return result.insertedId;
    });

    return toPublicMenuItem(
      { ...doc, _id: insertedId } as MenuItem,
      await isPremiumVendor(vendor.userId),
    );
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
    const baseFilter: Filter<MenuItem> = { status: 'active', isAvailable: true };

    // Category filter.
    if (query.category) {
      baseFilter.category = query.category;
    }

    // Location filter – case‑insensitive partial match.
    if (query.location) {
      baseFilter.location = { $regex: escapeRegex(query.location), $options: 'i' };
    }

    // Price range filter.
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const priceFilter: { $gte?: number; $lte?: number } = {};
      if (query.minPrice !== undefined) priceFilter.$gte = query.minPrice;
      if (query.maxPrice !== undefined) priceFilter.$lte = query.maxPrice;
      baseFilter.price = priceFilter;
    }

    // Apply name/description search (adds $or clause).
    const filterWithSearch = buildSearchFilter(baseFilter, query.search, query.category);

    // Sorting – use requested field and order; default fallback handled in paginateMenuItems.
    const sortSpec: Record<string, 1 | -1> = {
      [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1,
      _id: 1,
    };

    // Public/storefront lists (including the homepage featured query) put
    // current Premium vendors first. The premium flag is derived from the
    // users collection on the server, never from a client query parameter.
    return paginateMenuItems(filterWithSearch, query, sortSpec, { premiumFirst: true });
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
  },

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
  },

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

    const isPremium = await isPremiumVendor(item.vendorId);

    if (viewer?.roles.includes('admin')) {
      return toPublicMenuItem(item, isPremium);
    }

    if (viewer?.roles.includes('vendor') && item.vendorId === viewer.userId) {
      return toPublicMenuItem(item, isPremium);
    }

    if (item.status !== 'active') {
      return null;
    }

    return toPublicMenuItem(item, isPremium);
  },

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
    return toPublicMenuItem(updated, await isPremiumVendor(item.vendorId));
  },

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
    return toPublicMenuItem(item, await isPremiumVendor(item.vendorId));
  },

  /**
   * Admin status management (approve → 'active', reject → 'rejected',
   * re-submit → 'pending', etc.). Approval also flips `isAvailable` to true
   * so approved items are immediately live; other transitions leave vendor
   * availability untouched.
   */
  async setMenuItemStatus(id: string, status: MenuItemStatus): Promise<PublicMenuItem> {
    const itemId = toMenuItemId(id);
    const items = getMenuItemsCollection();

    // Cheap pre-read only to learn which vendor lock to take. The authoritative
    // read, quota check and write all happen again inside the locked callback.
    const initial = await items.findOne({ _id: itemId });
    if (!initial) {
      throw new ApiError(404, 'Menu item not found');
    }

    return withMenuQuotaLock(initial.vendorId, async (session) => {
      const item = await items.findOne({ _id: itemId }, { session });
      if (!item) {
        throw new ApiError(404, 'Menu item not found');
      }

      // Only a non-active → active transition consumes a free-plan slot.
      // Re-approving an already-active item remains an idempotent no-op.
      if (status === 'active' && item.status !== 'active') {
        await assertCanAddActiveMenuItem(item.vendorId, session);
      }

      const set: Record<string, unknown> = { status, updatedAt: new Date() };
      if (status === 'active') {
        set.isAvailable = true;
      }

      await items.updateOne({ _id: item._id }, { $set: set }, { session });

      const updated = await items.findOne({ _id: item._id }, { session });
      if (!updated) {
        throw new ApiError(404, 'Menu item not found');
      }
      return toPublicMenuItem(updated, await isPremiumVendor(item.vendorId));
    });
  },
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

/**
 * Batch-loads the CURRENT premium status for the given vendor ids. Better
 * Auth ids are strings by default, but ObjectId-stored ids are tolerated in
 * the same way as elsewhere in the codebase. Only plan/expiry fields are
 * read; no private vendor information is copied into menu responses.
 */
async function findPremiumVendorIds(vendorIds: string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(vendorIds.filter((id) => id.length > 0))).map(String);
  if (unique.length === 0) {
    return new Set();
  }

  const objectIds = unique.filter((id) => /^[0-9a-f]{24}$/i.test(id)).map((id) => new ObjectId(id));
  const idFilter =
    objectIds.length > 0
      ? [{ _id: { $in: unique } }, { _id: { $in: objectIds } }]
      : [{ _id: { $in: unique } }];

  const users = await getUsersCollection()
    .find({ subscriptionPlan: 'premium', $or: idFilter } as Filter<BetterAuthUser>, {
      projection: { _id: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 },
    })
    .toArray();

  return new Set(users.filter(hasActivePremiumSubscription).map((user) => String(user._id)));
}

/** Resolves one vendor's current premium status from the database. */
async function isPremiumVendor(vendorId: string): Promise<boolean> {
  return (await findPremiumVendorIds([vendorId])).has(String(vendorId));
}

/** Paginates a menu item filter; public lists can prioritize premium vendors. */
async function paginateMenuItems(
  filter: Filter<MenuItem>,
  query: { page: number; limit: number },
  sortSpec?: Record<string, 1 | -1>,
  options: { premiumFirst?: boolean } = {},
): Promise<ListMenuItemsResult> {
  const items = getMenuItemsCollection();
  const total = await items.countDocuments(filter);
  const skip = (query.page - 1) * query.limit;
  const effectiveSort = sortSpec ?? { createdAt: -1, _id: 1 };

  let docs: MenuItem[];
  let premiumVendorIds = new Set<string>();

  if (options.premiumFirst) {
    const vendorIds = (await items.distinct('vendorId', filter)).map(String);
    premiumVendorIds = await findPremiumVendorIds(vendorIds);
  }

  if (options.premiumFirst && premiumVendorIds.size > 0) {
    // One aggregation keeps filtering, priority, requested sort and pagination
    // in the same query, so global totals/pages stay correct.
    const prioritySort = { __premium: -1, ...effectiveSort, _id: 1 };
    docs = await items
      .aggregate<MenuItem>([
        { $match: filter },
        {
          $addFields: {
            __premium: { $cond: [{ $in: ['$vendorId', [...premiumVendorIds]] }, 1, 0] },
          },
        },
        { $sort: prioritySort },
        { $skip: skip },
        { $limit: query.limit },
        { $project: { __premium: 0 } },
      ])
      .toArray();
  } else {
    docs = await items.find(filter).sort(effectiveSort).skip(skip).limit(query.limit).toArray();
  }

  return {
    items: docs.map((doc) => toPublicMenuItem(doc, premiumVendorIds.has(String(doc.vendorId)))),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}
