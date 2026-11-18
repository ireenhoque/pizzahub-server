export class ApiError extends Error {
  public readonly statusCode: number;
  /** Optional machine-readable details (e.g. validation issues). */
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }
}
