import type { RequestHandler } from 'express';
import { getAuthenticatedUser } from '../../auth/require-auth.js';
import { ApiError } from '../../error/ApiError.js';
import { menuItemService } from './menu-item.service.js';
import type {
  AdminListMenuItemsQuery,
  CreateMenuItemInput,
  PublicListMenuItemsQuery,
  UploadImageFn,
  VendorListMenuItemsQuery,
  VendorUpdateMenuItemInput,
} from './menu-item.types.js';
import type { MenuItemStatus } from '../../types/menuItem.types.js';

export interface MenuItemControllerOptions {
  /** Injectable image uploader (production: ImgBB; tests: fakes). */
  uploadImage: UploadImageFn;
}

/** Factory for vendor‑only creation route */
export function createMenuItemControllers(options: MenuItemControllerOptions) {
  return {
    /** POST /api/menu-items — vendor‑only, multipart/form-data. */
    createMenuItem: (async (req, res, next) => {
      try {
        const auth = getAuthenticatedUser(req);
        const file = req.file;
        if (!file) {
          throw new ApiError(400, 'Image file is required');
        }
        const input = req.body as CreateMenuItemInput; // validated by Zod schema
        const menuItem = await menuItemService.createMenuItem(
          auth,
          input,
          { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype },
          options.uploadImage,
        );
        res.status(201).json({
          success: true,
          message: 'Menu item created and submitted for approval',
          data: { menuItem },
        });
      } catch (error) {
        next(error);
      }
    }) as RequestHandler,
  };
}

/** Admin moderation controllers */
export const adminMenuItemControllers = {
  /** PATCH /api/menu-items/admin/:id/approve — approve a pending menu item. */
  approveMenuItem: (async (req, res, next) => {
    try {
      const { id } = req.validatedParams as { id: string };
      const menuItem = await menuItemService.setMenuItemStatus(id, 'active');
      res.status(200).json({ success: true, message: 'Menu item approved', data: { menuItem } });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,

  /** PATCH /api/menu-items/admin/:id/reject — reject a pending menu item. */
  rejectMenuItem: (async (req, res, next) => {
    try {
      const { id } = req.validatedParams as { id: string };
      const menuItem = await menuItemService.setMenuItemStatus(id, 'rejected');
      res.status(200).json({ success: true, message: 'Menu item rejected', data: { menuItem } });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
};

/** Public storefront listing */
export const listPublicMenuItems: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validatedQuery as PublicListMenuItemsQuery;
    const result = await menuItemService.listPublicMenuItems(query);
    res.status(200).json({ success: true, message: 'Menu items retrieved', data: result });
  } catch (error) {
    next(error);
  }
};

/** Get a single menu item (public or auth) */
export const getMenuItem: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.validatedParams as { id: string };
    const viewer = req.auth ?? null;
    const menuItem = await menuItemService.getMenuItemForViewer(id, viewer);
    if (!menuItem) {
      throw new ApiError(404, 'Menu item not found');
    }
    res.status(200).json({ success: true, message: 'Menu item retrieved', data: { menuItem } });
  } catch (error) {
    next(error);
  }
};

/** Vendor's own items */
export const listMyMenuItems: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuthenticatedUser(req);
    const query = req.validatedQuery as VendorListMenuItemsQuery;
    const result = await menuItemService.listVendorMenuItems(auth.userId, query);
    res.status(200).json({ success: true, message: 'Your menu items retrieved', data: result });
  } catch (error) {
    next(error);
  }
};

export const updateMyMenuItem: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuthenticatedUser(req);
    const { id } = req.validatedParams as { id: string };
    const updates = req.body as VendorUpdateMenuItemInput;
    const menuItem = await menuItemService.updateMenuItemByVendor(auth, id, updates);
    res.status(200).json({ success: true, message: 'Menu item updated', data: { menuItem } });
  } catch (error) {
    next(error);
  }
};

export const deleteMyMenuItem: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuthenticatedUser(req);
    const { id } = req.validatedParams as { id: string };
    const menuItem = await menuItemService.deleteMenuItemByVendor(auth, id);
    res.status(200).json({ success: true, message: 'Menu item deleted', data: { menuItem } });
  } catch (error) {
    next(error);
  }
};

/** Admin list all items */
export const listAllMenuItems: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validatedQuery as AdminListMenuItemsQuery;
    const result = await menuItemService.listAllMenuItemsForAdmin(query);
    res.status(200).json({ success: true, message: 'Menu items retrieved', data: result });
  } catch (error) {
    next(error);
  }
};

/** Admin set status (fallback for generic status updates) */
export const setMenuItemStatus: RequestHandler = async (req, res, next) => {
  try {
    const { id } = req.validatedParams as { id: string };
    const { status } = req.body as { status: MenuItemStatus };
    const menuItem = await menuItemService.setMenuItemStatus(id, status);
    res
      .status(200)
      .json({ success: true, message: 'Menu item status updated', data: { menuItem } });
  } catch (error) {
    next(error);
  }
};
