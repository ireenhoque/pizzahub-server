import { defineConfig } from 'vitest/config';

/**
 * Required environment variables come from the real .env via
 * `tests/setup-env.ts` (loaded before test modules import `env.ts`).
 * The users API tests run against the real MongoDB instance — they only
 * ever touch documents they created themselves (unique `uitest-*` ids).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
  },
});
