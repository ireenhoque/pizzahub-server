import { Router, type RequestHandler } from 'express';
import { requireVendor } from '../../auth/require-auth.js';
import { uploadSingleImage } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { createMenuItemControllers } from './menu-item.controller.js';
import { createMenuItemSchema } from './menu-item.validation.js';
import { uploadToImgBB } from '../../utils/imgbb.js';
import type { UploadImageFn } from './menu-item.types.js';

export interface MenuRouterOptions {
  /** Injectable image uploader (production: ImgBB; tests: fakes). */
  uploadImage?: UploadImageFn;
}

/**
 * Menu item routes.
 *
 * Creation order matters:
 *  1. requireAuth   — verified JWT + DB-backed user
 *  2. requireVendor — DB-verified vendor role
 *  3. multer        — multipart parsing, MIME/size validation
 *  4. Zod validate  — name/category/description/price/location (strict)
 *  5. controller    — quota checks, ImgBB upload, Mongo insert
 */
export function createMenuRouter(
  requireAuth: RequestHandler,
  options: MenuRouterOptions = {},
): Router {
  const router = Router();
  const controllers = createMenuItemControllers({
    uploadImage: options.uploadImage ?? uploadToImgBB,
  });

  router.post(
    '/',
    requireAuth,
    requireVendor,
    uploadSingleImage('image'),
    validate({ body: createMenuItemSchema }),
    controllers.createMenuItem,
  );

  return router;
}
