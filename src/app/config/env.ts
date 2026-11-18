import dotenv from 'dotenv';

dotenv.config();

function readRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const nodeEnv = readRequiredEnv('NODE_ENV');
const port = Number.parseInt(readRequiredEnv('PORT'), 10);
const mongoUri = readRequiredEnv('MONGODB_URI');
const dbName = readRequiredEnv('DB_NAME');

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
} as const;
