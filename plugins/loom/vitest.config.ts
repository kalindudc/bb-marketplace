import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The jsdom UI tests are CPU-heavy; leave headroom so a loaded machine does not push them past their timeout.
    maxWorkers: Math.min(6, Math.max(1, availableParallelism() - 1)),
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["test/**/*.test.tsx"],
          setupFiles: ["test/ui-setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
