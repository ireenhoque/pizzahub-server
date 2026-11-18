import type { MenuItemCategory, MenuItemStatus } from '../../types/menuItem.types.js';

/** Safe-to-expose menu item representation (the ImgBB delete URL is never included). */
export interface PublicMenuItem {
  id: string;
  vendorId: string;
  name: string;
  description: string;
  category: MenuItemCategory;
  price: number;
  currency: string;
  location: string;
  imageUrl: string;
  imageThumbUrl?: string | null;
  status: MenuItemStatus;
  isAvailable: boolean;
  ratingAvg: number;
  ratingCount: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Validated multipart body for menu item creation (vendorId/status excluded by design). */
export interface CreateMenuItemInput {
  name: string;
  category: MenuItemCategory;
  description: string;
  price: number;
  location: string;
}

export interface UploadedImage {
  imageUrl: string;
  thumbUrl?: string;
  deleteUrl?: string;
}

/**
 * Image upload abstraction — production uses ImgBB (`uploadToImgBB`);
 * tests inject fakes. The function receives ONLY the file buffer/metadata;
 * the ImgBB API key stays inside the server environment.
 */
export type UploadImageFn = (file: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}) => Promise<UploadedImage>;
