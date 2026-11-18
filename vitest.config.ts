import { defineConfig } from 'vitest/config';

/**
 * Required environment variables are set here so that importing application
 * modules (which read env.ts at module load) works in tests. Test values
 * only — tests build their own middleware instances via the factory and
 * never connect to MongoDB.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'development',
      PORT: '5000',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/unused-in-tests',
      DB_NAME: 'pizzahub-test',
      // Replaced per-test: the middleware factory takes the JWKS URL as an option.
      BETTER_AUTH_JWKS_URL: 'http://127.0.0.1:9/jwks',
      JWT_ISSUER: 'https://auth.pizzahub.test',
      JWT_AUDIENCE: 'pizzahub-api',
    },
  },
});
