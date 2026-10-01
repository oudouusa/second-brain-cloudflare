import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["experiments/known-item-recall/*.test.ts"],
    testTimeout: 120_000,
  },
});
