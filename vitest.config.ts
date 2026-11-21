import { defineConfig } from 'vitest/config';

/**
 * Required environment variables come from the real .env via
 * `tests/setup-env.ts` (loaded before test modules import `env.ts`).
 * API tests share one real MongoDB database, so files run sequentially to
 * avoid baselines being invalidated by another suite's cleanup.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    fileParallelism: false,
  },
});
