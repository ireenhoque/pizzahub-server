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
const port = Number.parseInt(readRequiredEnv('PORT'), 10);
const mongoUri = readRequiredEnv('MONGODB_URI');
const dbName = readRequiredEnv('DB_NAME');
const betterAuthJwksUrl = readRequiredUrlEnv('BETTER_AUTH_JWKS_URL');
const jwtIssuer = readRequiredEnv('JWT_ISSUER');
const jwtAudience = readRequiredEnv('JWT_AUDIENCE');

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
} as const;
