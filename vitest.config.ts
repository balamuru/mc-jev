import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests need a local server and live tests spend real money: both are opt-in.
    exclude: ['test/integration/**', 'test/live/**'],
  },
});
