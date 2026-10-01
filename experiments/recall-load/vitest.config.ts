import { defineConfig } from "vitest/config";
import base from "../../vitest.config";

// Explicit opt-in: the normal suite continues to exclude experiments/**.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["experiments/recall-load/replay.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", ".worktrees/**"],
    fileParallelism: false, maxWorkers: 1, testTimeout: 180_000,
  },
});
