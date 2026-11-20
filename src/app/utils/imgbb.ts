import { ApiError } from '../error/ApiError.js';
import { env } from '../config/env.js';
import type { UploadedImage } from '../modules/menuItems/menu-item.types.js';

/**
 * Uploads an image to ImgBB from the Express server.
 *
 * SECURITY: `IMGBB_API_KEY` lives only in server environment variables. It
 * is sent to ImgBB directly (server → ImgBB request) and is never included
 * in any API response, log message, or client-facing payload. Log lines
 * intentionally contain only status codes/error names — never the request
 * body, which contains the key.
 */
export async function uploadToImgBB(file: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}): Promise<UploadedImage> {
  const form = new FormData();
  // ImgBB accepts base64 image payloads in multipart/form-data.
  form.append('image', file.buffer.toString('base64'));
  form.append('name', file.originalname);

  // ImgBB requires the API key as a query parameter, not a form field.
  const uploadUrl = new URL(env.imgbbUploadUrl);
  uploadUrl.searchParams.set('key', env.imgbbApiKey);

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    console.error(`ImgBB upload failed (network): ${reason}`);
    throw new ApiError(502, 'Image upload failed: the image service is unreachable');
  }

  if (!response.ok) {
    // Log the status only — the response body may echo request parameters.
    console.error(`ImgBB upload failed with HTTP ${response.status}`);
    throw new ApiError(502, 'Image upload failed');
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: { url?: string; thumb?: { url?: string }; delete_url?: string };
  } | null;

  const imageUrl = payload?.data?.url;
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('https://')) {
    throw new ApiError(502, 'Image upload failed: unexpected response from the image service');
  }

  return {
    imageUrl,
    thumbUrl: typeof payload?.data?.thumb?.url === 'string' ? payload.data.thumb.url : undefined,
    deleteUrl: typeof payload?.data?.delete_url === 'string' ? payload.data.delete_url : undefined,
  };
}
