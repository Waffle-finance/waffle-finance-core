import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Map the workspace package's root and /node sub-exports directly to
      // source so vitest doesn't need a compiled dist/ to run tests.
      "@wafflefinance/config/node": resolve(__dirname, "../packages/config/src/node.ts"),
      "@wafflefinance/config": resolve(__dirname, "../packages/config/src/index.ts"),
      // Map SDK sub-paths to source so the compat harness can import
      // SDK types and state-machine directly without a built dist/.
      "@wafflefinance/sdk/ethereum": resolve(__dirname, "../packages/sdk/src/ethereum/index.ts"),
      "@wafflefinance/sdk/shared-utils": resolve(__dirname, "../packages/sdk/src/shared-utils/index.ts"),
      "@wafflefinance/sdk/state-machine": resolve(__dirname, "../packages/sdk/src/state-machine/index.ts"),
      "@wafflefinance/sdk/solana": resolve(__dirname, "../packages/sdk/src/solana/rpc-provider.ts"),
      "@wafflefinance/sdk/types": resolve(__dirname, "../packages/sdk/src/types/index.ts"),
      "@wafflefinance/sdk": resolve(__dirname, "../packages/sdk/src/index.ts"),
      // Stub for the optional @wormhole/config package, which is not installed
      // in this environment. The coordinator's tests never exercise the SDK's
      // config-validation layer at runtime; this alias lets the module graph
      // resolve without the real package being present.
      "@wormhole/config": resolve(__dirname, "../packages/sdk/src/__stubs__/wormhole-config.ts"),
      // Stub for kysely — declared in kysely-db.ts but not added to the
      // coordinator's package.json yet. Tests never call createKyselyDb() so
      // a no-op stub is safe.
      "kysely": resolve(__dirname, "src/__stubs__/kysely.ts"),
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
