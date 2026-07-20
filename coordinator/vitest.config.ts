import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Map the workspace package's root and /node sub-exports directly to
      // source so vitest doesn't need a compiled dist/ to run tests.
      "@wafflefinance/config/node": resolve(__dirname, "../packages/config/src/node.ts"),
      "@wafflefinance/config": resolve(__dirname, "../packages/config/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    server: {
      deps: {
        external: [/^node:/]
      }
    }
  }
});
