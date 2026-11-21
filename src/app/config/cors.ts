import type { CorsOptions } from 'cors';
import { env } from './env.js';

/** Safe defaults for local development only; production must configure origins. */
export const DEVELOPMENT_CORS_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'] as const;

/**
 * Accepts a comma-separated list of exact browser origins.
 *
 * Errors deliberately name the variable but never echo its value, so a bad
 * configuration cannot leak URLs or credentials into logs.
 */
export function parseCorsAllowedOrigins(
  raw: string | undefined,
  nodeEnv: string,
): readonly string[] {
  const configured = raw?.trim();

  if (!configured) {
    if (nodeEnv === 'production') {
      throw new Error('CORS_ALLOWED_ORIGINS is required in production');
    }
    return DEVELOPMENT_CORS_ORIGINS;
  }

  const candidates = configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (candidates.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS must contain at least one origin');
  }

  const allowed = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.includes('*')) {
      throw new Error('CORS_ALLOWED_ORIGINS must not contain wildcards');
    }

    try {
      const url = new URL(candidate);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      ) {
        throw new Error('invalid origin');
      }
      allowed.add(url.origin);
    } catch {
      throw new Error('CORS_ALLOWED_ORIGINS must contain only absolute http(s) origins');
    }
  }

  return [...allowed];
}

export const corsAllowedOrigins = parseCorsAllowedOrigins(
  process.env.CORS_ALLOWED_ORIGINS,
  env.nodeEnv,
);

export const corsOptions: CorsOptions = {
  // Requests without an Origin header (server-to-server, Stripe webhooks,
  // health checks) are not browser CORS requests and remain allowed.
  origin: (origin, callback) => {
    if (!origin || corsAllowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  exposedHeaders: ['Content-Type'],
  credentials: false,
  optionsSuccessStatus: 204,
};
