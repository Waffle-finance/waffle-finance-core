import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const configDist = resolve(__dirname, "../packages/config/dist");

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: [
      // Must come before the bare "@wafflefinance/config" alias so subpath
      // exports resolve to the correct dist file rather than re-resolving
      // through the (empty) pnpm stub in node_modules.
      {
        find: "@wafflefinance/config/node",
        replacement: resolve(configDist, "node.js"),
      },
      {
        find: "@wafflefinance/config",
        replacement: resolve(configDist, "index.js"),
      },
    ],
  },
});
