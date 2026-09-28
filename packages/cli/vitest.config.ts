import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // each test runs `npm pack` / `npm install` against a local mock registry
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
