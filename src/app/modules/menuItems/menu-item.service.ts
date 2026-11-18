import { findBetterAuthUserById, getMenuItemsCollection } from '../../db/collections.js';
import { ApiError } from '../../error/ApiError.js';
import type { AuthenticatedUser } from '../../auth/auth.types.js';
import { hasActivePremiumSubscription } from '../users/user.service.js';
import { MENU_ITEM_CURRENCY, type MenuItem } from '../../types/menuItem.types.js';
import { uploadToImgBB } from '../../utils/imgbb.js';
import type { CreateMenuItemInput, PublicMenuItem, UploadImageFn } from './menu-item.types.js';

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
};
