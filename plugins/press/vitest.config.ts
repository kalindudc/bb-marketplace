import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // UI tests opt into jsdom per file with `// @vitest-environment jsdom`; server tests stay on node.
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
