import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["experiments/nightly-perf/local-probe.test.ts"],
    testTimeout: 60000,
    fileParallelism: false,
  },
});
