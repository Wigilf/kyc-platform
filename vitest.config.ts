import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // The regression suite drives the pipeline against the real database rather
    // than a mock of it, and the bugs it guards were all in how records are read
    // back. Sequential so runs cannot contend over the same demo applicants.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
