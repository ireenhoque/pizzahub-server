import dotenv from 'dotenv';

dotenv.config();

function readRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function readRequiredUrlEnv(key: string): string {
  const value = readRequiredEnv(key);
  try {
    new URL(value);
  } catch {
    throw new Error(`Environment variable ${key} must be a valid URL`);
  }
  return value;
}

const nodeEnv = readRequiredEnv('NODE_ENV');
export function getStripeWebhookSecret(): string {
  return readRequiredEnv('STRIPE_WEBHOOK_SECRET');
}

/*
 * Stripe billing settings are validated LAZILY, exactly like the webhook
 * secret above: the server boots and every non-billing endpoint keeps
 * working even when Stripe is not configured. Billing endpoints map a
 * missing variable to a 503 that names the variable — never its value.
 */
export function getStripeSecretKey(): string {
  return readRequiredEnv('STRIPE_SECRET_KEY');
}

/** Server-controlled Stripe Price for the vendor Premium plan (clients never send prices). */
export function getStripePremiumPriceId(): string {
  return readRequiredEnv('STRIPE_PREMIUM_PRICE_ID');
}

/** Configured browser URLs for Checkout success / cancellation. */
export function getStripeSuccessUrl(): string {
  return readRequiredUrlEnv('STRIPE_SUCCESS_URL');
}

export function getStripeCancelUrl(): string {
  return readRequiredUrlEnv('STRIPE_CANCEL_URL');
}

const port = Number.parseInt(readRequiredEnv('PORT'), 10);
const mongoUri = readRequiredEnv('MONGODB_URI');
const dbName = readRequiredEnv('DB_NAME');
const betterAuthJwksUrl = readRequiredUrlEnv('BETTER_AUTH_JWKS_URL');
const jwtIssuer = readRequiredEnv('JWT_ISSUER');
const jwtAudience = readRequiredEnv('JWT_AUDIENCE');
const imgbbApiKey = readRequiredEnv('IMGBB_API_KEY');

if (Number.isNaN(port)) {
  throw new Error('Environment variable PORT must be a valid number');
}

export const env = {
  nodeEnv,
  isDevelopment: nodeEnv === 'development',
  isProduction: nodeEnv === 'production',
  port,
  mongoUri,
  dbName,
  betterAuthJwksUrl,
  jwtIssuer,
  jwtAudience,
  imgbbApiKey,
  /** Overridable for tests/staging; production uses the real ImgBB API. */
  imgbbUploadUrl: process.env.IMGBB_UPLOAD_URL ?? 'https://api.imgbb.com/1/upload',
} as const;
