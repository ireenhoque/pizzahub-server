import { Router, type RequestHandler } from 'express';
import { optionalAuth, requireAdmin, requireVendor } from '../../auth/require-auth.js';
import { uploadSingleImage } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { adminMenuItemControllers, createMenuItemControllers, listPublicMenuItems, listMyMenuItems, updateMyMenuItem, deleteMyMenuItem, listAllMenuItems, setMenuItemStatus, getMenuItem } from './menu-item.controller.js';

const menuItemControllers = {
  listPublicMenuItems,
  listMyMenuItems,
  updateMyMenuItem,
  deleteMyMenuItem,
  listAllMenuItems,
  setMenuItemStatus,
  getMenuItem,
};

import {
  adminListMenuItemsQuerySchema,
  adminSetMenuItemStatusSchema,
  createMenuItemSchema,
  menuItemIdParamSchema,
  publicListMenuItemsQuerySchema,
  updateVendorMenuItemSchema,
  vendorListMenuItemsQuerySchema,
} from './menu-item.validation.js';
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

  // ── Public storefront listing (no auth required) ─────────────────────
  router.get(
    '/',
    validate({ query: publicListMenuItemsQuerySchema }),
    menuItemControllers.listPublicMenuItems,
  );

  // ── Vendor self-service ──────────────────────────────────────────────
  router.get(
    '/mine',
    requireAuth,
    requireVendor,
    validate({ query: vendorListMenuItemsQuerySchema }),
    menuItemControllers.listMyMenuItems,
  );

  router.patch(
    '/mine/:id',
    requireAuth,
    requireVendor,
    validate({ params: menuItemIdParamSchema, body: updateVendorMenuItemSchema }),
    menuItemControllers.updateMyMenuItem,
  );

  router.delete(
    '/mine/:id',
    requireAuth,
    requireVendor,
    validate({ params: menuItemIdParamSchema }),
    menuItemControllers.deleteMyMenuItem,
  );

  // ── Admin pending menu items ────────────────────────────────────────


  // ── Admin approve / reject actions ────────────────────────────────────────
  router.patch(
    '/admin/:id/approve',
    requireAuth,
    requireAdmin,
    validate({ params: menuItemIdParamSchema }),
    adminMenuItemControllers.approveMenuItem,
  );

  router.patch(
    '/admin/:id/reject',
    requireAuth,
    requireAdmin,
    validate({ params: menuItemIdParamSchema }),
    adminMenuItemControllers.rejectMenuItem,
  );


  // ── Admin review & management ────────────────────────────────────────
  router.get(
    '/admin',
    requireAuth,
    requireAdmin,
    validate({ query: adminListMenuItemsQuerySchema }),
    menuItemControllers.listAllMenuItems,
  );

  router.patch(
    '/admin/:id/status',
    requireAuth,
    requireAdmin,
    validate({ params: menuItemIdParamSchema, body: adminSetMenuItemStatusSchema }),
    menuItemControllers.setMenuItemStatus,
  );

  // ── Item detail by ID (registered LAST so /mine and /admin are not
  //    captured by the :id segment) ─────────────────────────────────────
  router.get(
    '/:id',
    optionalAuth(requireAuth),
    validate({ params: menuItemIdParamSchema }),
    menuItemControllers.getMenuItem,
  );

  return router;
}
