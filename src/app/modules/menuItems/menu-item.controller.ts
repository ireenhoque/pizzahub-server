import type { RequestHandler } from 'express';
import { getAuthenticatedUser } from '../../auth/require-auth.js';
import { ApiError } from '../../error/ApiError.js';
import { menuItemService } from './menu-item.service.js';
import type { CreateMenuItemInput, UploadImageFn } from './menu-item.types.js';

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
