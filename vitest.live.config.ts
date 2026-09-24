import { defineConfig } from 'vitest/config';

// Live tests call the real Jev API with your key and cost a little money. Never run in CI.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
