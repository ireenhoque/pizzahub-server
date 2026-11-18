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

export function createMenuItemControllers(options: MenuItemControllerOptions) {
  return {
    /** POST /api/menu-items — vendor-only, multipart/form-data. */
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
          {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
          },
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

interface ValidatedParams {
  id: string;
}

/**
 * Read/update/delete controllers. These endpoints perform no uploads, so
 * they need no injected dependencies.
 */
export const menuItemControllers = {
  /** GET /api/menu-items — public storefront listing (active items only). */
  listPublicMenuItems: (async (req, res, next) => {
    try {
      const query = req.validatedQuery as PublicListMenuItemsQuery;
      const result = await menuItemService.listPublicMenuItems(query);
      res.status(200).json({
        success: true,
        message: 'Menu items retrieved',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,

  /** GET /api/menu-items/:id — role-aware detail (optional auth). */
  getMenuItem: (async (req, res, next) => {
    try {
      const { id } = req.validatedParams as ValidatedParams;
      const viewer = req.auth ?? null;

      const menuItem = await menuItemService.getMenuItemForViewer(id, viewer);
      if (!menuItem) {
        // Also covers pending/rejected items: hidden from public viewers.
        throw new ApiError(404, 'Menu item not found');
      }

      res.status(200).json({
        success: true,
        message: 'Menu item retrieved',
        data: { menuItem },
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,

  /** GET /api/menu-items/mine — vendor's own items (all statuses). */
  listMyMenuItems: (async (req, res, next) => {
    try {
      const auth = getAuthenticatedUser(req);
      const query = req.validatedQuery as VendorListMenuItemsQuery;

      const result = await menuItemService.listVendorMenuItems(auth.userId, query);
      res.status(200).json({
        success: true,
        message: 'Your menu items retrieved',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,

  /** PATCH /api/menu-items/mine/:id — vendor updates own permitted fields. */
  updateMyMenuItem: (async (req, res, next) => {
    try {
      const auth = getAuthenticatedUser(req);
      const { id } = req.validatedParams as ValidatedParams;
      const updates = req.body as VendorUpdateMenuItemInput; // validated by Zod

      const menuItem = await menuItemService.updateMenuItemByVendor(auth, id, updates);
      res.status(200).json({
        success: true,
        message: 'Menu item updated',
        data: { menuItem },
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,

  /** DELETE /api/menu-items/mine/:id — vendor deletes own item. */
  deleteMyMenuItem: (async (req, res, next) => {
    try {
      const auth = getAuthenticatedUser(req);
      const { id } = req.validatedParams as ValidatedParams;

      const menuItem = await menuItemService.deleteMenuItemByVendor(auth, id);
      res.status(200).json({
        success: true,
        message: 'Menu item deleted',
        data: { menuItem },
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,

  /** GET /api/menu-items/admin — admin review console listing. */
  listAllMenuItems: (async (req, res, next) => {
    try {
      const query = req.validatedQuery as AdminListMenuItemsQuery;
      const result = await menuItemService.listAllMenuItemsForAdmin(query);
      res.status(200).json({
        success: true,
        message: 'Menu items retrieved',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,

  /** PATCH /api/menu-items/admin/:id/status — admin review decision. */
  setMenuItemStatus: (async (req, res, next) => {
    try {
      const { id } = req.validatedParams as ValidatedParams;
      const { status } = req.body as { status: MenuItemStatus }; // validated by Zod

      const menuItem = await menuItemService.setMenuItemStatus(id, status);
      res.status(200).json({
        success: true,
        message: 'Menu item status updated',
        data: { menuItem },
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler,
};
