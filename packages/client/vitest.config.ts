import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // each test file spawns its own broker on a random port; the e2e flows wait up to ~6 s
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
