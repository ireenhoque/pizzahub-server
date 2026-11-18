import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

type ErrorResponse = {
  success: boolean;
  message: string;
  details?: unknown;
  stack?: string;
};

function resolveError(err: unknown): {
  statusCode: number;
  message: string;
  details?: unknown;
  stack?: string;
} {
  if (err instanceof ApiError) {
    return {
      statusCode: err.statusCode,
      message: err.message,
      details: err.details,
      stack: err.stack,
    };
  }

  if (err instanceof Error) {
    return {
      statusCode: 500,
      message: err.message || 'Something went wrong',
      stack: err.stack,
    };
  }

  return { statusCode: 500, message: 'An unexpected error occurred' };
}

export const globalErrorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const { statusCode, message, details, stack } = resolveError(err);

  const body: ErrorResponse = {
    success: false,
    message,
  };

  if (details !== undefined) {
    body.details = details;
  }

  if (env.isDevelopment && stack) {
    body.stack = stack;
  }

  res.status(statusCode).json(body);
};
