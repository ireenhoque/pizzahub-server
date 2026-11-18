import type { RequestHandler } from 'express';
import multer, { MulterError } from 'multer';
import { ApiError } from '../error/ApiError.js';

/** Accepted image types — validated against the declared multipart MIME type. */
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  // Memory storage: the buffer is forwarded to ImgBB, never written to disk.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new ApiError(400, 'Unsupported image type. Use JPEG, PNG or WebP'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Wraps `multer.single(field)` so Multer errors become consistent 400
 * ApiErrors (rendered by the centralized error handler) instead of raw
 * 500s: size limit, wrong field name, unsupported MIME type, etc.
 */
export function uploadSingleImage(field = 'image'): RequestHandler {
  const single = upload.single(field);

  return (req, res, next): void => {
    single(req, res, (error: unknown) => {
      if (error instanceof MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          next(
            new ApiError(
              400,
              `Image exceeds the ${Math.floor(MAX_IMAGE_SIZE_BYTES / (1024 * 1024))} MB size limit`,
            ),
          );
          return;
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
          next(new ApiError(400, `Unexpected file field. Attach the image as "${field}"`));
          return;
        }
        next(new ApiError(400, 'Image upload failed: invalid file'));
        return;
      }

      if (error instanceof ApiError) {
        next(error);
        return;
      }

      if (error instanceof Error) {
        next(new ApiError(400, 'Image upload failed: invalid file'));
        return;
      }

      next();
    });
  };
}
