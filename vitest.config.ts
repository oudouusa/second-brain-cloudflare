import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // 5 s (the default) is too tight for tests that boot a sqlite-backed corpus or the eval CLI on a CI runner under coverage:
    // two of them timed out there at 5 s though each takes about a second locally.
    testTimeout: 30_000,
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // .worktrees/ is where this repo's .gitignore expects git worktrees to live.
    // Without this, a checkout with any worktree present runs the whole suite once
    // per worktree — the counts multiply, and in-progress work in a sibling branch
    // reports as a failure of the branch you are actually on. Excluded rather than
    // relocated because the ignore rule already establishes the location.
    exclude: [...configDefaults.exclude, ".worktrees/**", "experiments/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "public/utils.js"],
      reporter: ["text", "html", "json-summary", "json"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 86,
        branches: 78,
        functions: 88,
        lines: 87,
      },
    },
  },
});
