import { defineConfig } from 'vitest/config';

// Integration tests need a local Minecraft server (see docs/setup.md). Not run in CI.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,
    passWithNoTests: true,
  },
});
