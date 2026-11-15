import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { join } from "node:path";
import { isolateTestEnvironment } from "./test/environment";

const root = isolateTestEnvironment();
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  cacheDir: join(root, "cache/vite"),
  test: {
    pool: "forks",
    setupFiles: ["test/setup.ts"],
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Suites share the machine with other builders; slow-but-correct tests shouldn't flake at the 5 s default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
