import type { RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';
import { ApiError } from '../error/ApiError.js';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Zod validation middleware.
 *
 * - `body` is parsed in place (Express' json middleware makes it writable).
 * - `query`/`params` are parsed into `req.validatedQuery`/`req.validatedParams`
 *   because Express 5 exposes them as read-only getters.
 * - Failures become a 400 ApiError with per-field details, rendered by the
 *   centralized error handler — so every invalid request gets the same
 *   `{ success: false, message, details }` shape.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body ?? {});
      }
      if (schemas.query) {
        req.validatedQuery = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        req.validatedParams = schemas.params.parse(req.params);
      }
      next();
    } catch (error) {
      next(error instanceof ZodError ? zodToApiError(error) : error);
    }
  };
}

function zodToApiError(error: ZodError): ApiError {
  return new ApiError(
    400,
    'Validation failed',
    error.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  );
}
