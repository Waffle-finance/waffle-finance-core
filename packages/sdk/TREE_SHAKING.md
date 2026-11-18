# Tree-Shaking & Package Shape

The intended package shape, and the measurements behind it. Written for
[issue #731](https://github.com/Waffle-finance/waffle-finance-core/issues/731)
("Improve code-splitting and package boundaries for SDK consumers").

The short version: **the subpath layout is the tree-shaking story, and it is
`sideEffects: false` that makes the root barrel cheap for bundlers.** Everything
below is the reasoning, plus the numbers, plus how to re-measure them.

## The shape

One narrow subpath per concern, grouped by chain so a consumer never loads a
chain it does not use. `@wafflefinance/sdk` (`.`) is the convenience barrel
over all of them and remains fully supported — see the table in
[README.md](./README.md#subpath-exports) for the authoritative list, and
`package.json#exports` for the machine-readable one.

Three rules govern the layout:

1. **A module gets a subpath if a consumer has a reason to want it alone.**
   `SolanaRpcProvider` (#713) is a failover layer you might use from a script
   that never constructs a `SolanaHTLCClient`; before #731 it had no subpath, so
   the only supported way to reach it was the whole root barrel.
2. **Chain-specific code never appears in a chain-neutral subpath.** Enforced at
   runtime by `npm run verify:subpaths`, not just by convention.
3. **Nothing is emitted that no subpath can reach.** `npm run analyze` fails the
   build if it happens, so "I forgot to add the subpath" is a CI error rather
   than a support issue six months later.

## Why the root barrel is kept

The obvious move for a code-splitting issue is to strip the root barrel down.
That was measured and rejected.

A bundler that honours `sideEffects: false` already tree-shakes the root barrel
completely. Bundling a realistic single-symbol consumer with esbuild
(`viem`/`stellar-sdk`/`web3.js` external, minified):

| Consumer entry                                                     | Bytes |  gzip |
| ------------------------------------------------------------------ | ----: | ----: |
| `import { EthereumHTLCClient } from "@wafflefinance/sdk"`          | 4,354 | 1,087 |
| `import { EthereumHTLCClient } from "@wafflefinance/sdk/ethereum"` | 4,354 | 1,086 |
| `import { generateSecret } from "@wafflefinance/sdk"`              | 1,225 |   667 |
| `import { generateSecret } from "@wafflefinance/sdk/secrets"`      | 1,225 |   662 |

Identical, to within gzip framing. A namespace import is where the barrel
shows its weight — `import * as sdk` from `.` is 64,247 bytes / 18,043 gzip
against 4,492 / 1,182 for `./ethereum` — but a namespace import is a deliberate
choice to keep everything, and `sideEffects: false` is the flag that makes the
named-import case free.

So removing chain re-exports from the root barrel would have bought bundler
consumers **0 bytes** while breaking every `import { EthereumHTLCClient } from
"@wafflefinance/sdk"` in the wild. That is a regression, not an improvement.
The barrel stays.

What the barrel _does_ cost is Node ESM consumers — the relayer, the resolver,
CI, `node -e` scripts — which have no bundler and therefore load the entire
graph eagerly. `import "@wafflefinance/sdk"` reaches **28 modules / 209.3 KiB**
of SDK code plus all three chain SDKs; `import "@wafflefinance/sdk/ethereum"`
reaches **4 modules / 26.3 KiB** and viem only. That gap is invisible to `tsc`,
to a static analyser, and to a bundler, which is exactly why
`verify-subpath-isolation.mjs` probes the loader instead of reading the graph.

## What #731 changed, measured

Before, these modules were emitted but had no subpath, so a consumer wanting one
of them had to take the root barrel — or, for two of them, deep-import
`dist/`, which `package.json#exports` blocks:

| Module                      | Before                                   | After                         | Subpath cost after                |
| --------------------------- | ---------------------------------------- | ----------------------------- | --------------------------------- |
| `solana/rpc-provider`       | root barrel only                         | `./solana/rpc-provider`       | 1 module, 9.6 KiB, solana only    |
| `solana/account-validation` | root barrel only                         | `./solana/account-validation` | 2 modules, 25.6 KiB, solana only  |
| `solana/idl`                | root barrel only                         | `./solana/idl`                | 1 module, 11.3 KiB, chain-neutral |
| `soroban/orchestrator`      | root barrel only                         | `./soroban/orchestrator`      | 1 module, 15.2 KiB, soroban only  |
| `approval`                  | **unreachable**                          | `./approval`                  | 1 module, 5.1 KiB, chain-neutral  |
| `status-display`            | **unreachable**                          | `./status-display`            | 1 module, 4.1 KiB, chain-neutral  |
| `routes/fee-policy`         | root barrel only (and broken, see below) | `./routes/fee-policy`         | 1 module, 5.1 KiB, chain-neutral  |

Compare against the root barrel's 28 modules / 209.3 KiB / all three chains.

Subpath count: **15 → 23**. Emitted-but-unreachable modules: **4 → 0**.

Two bugs fixed along the way, both of which made "just import the root" fail:

- `src/routes/index.ts` used the fee policy without re-exporting it, while
  `src/index.ts` re-exported those names from the routes barrel. `tsc` reported
  it (TS2459 ×6) and esbuild refused to link `dist/index.js` at all — so
  `import ... from "@wafflefinance/sdk"` was broken for **every** consumer,
  bundler or not. The barrel now passes the fee-policy surface through.
- Colocated `*.test.ts` files were inside the build's `include`, so
  `dist/shared-utils/rpc-compat.test.js` shipped in the published tarball. They
  are excluded from `tsconfig.json` and still typechecked by
  `tsconfig.typecheck.json`.

## Known coupling

`./secrets` is chain-neutral but loads **viem**, because viem is the SDK's only
source of `keccak256` (`node:crypto` has `sha256` but no keccak256). Fixing it
means reimplementing keccak256 or changing a dependency — out of scope for
#731. It is recorded in `KNOWN_COUPLINGS` in
`scripts/verify-subpath-isolation.mjs`, so the gate is green today but prints
the coupling instead of hiding it, and a _new_ coupling still fails.

## Re-measuring

```bash
pnpm build                 # tsc → dist/
pnpm analyze               # every exports subpath resolves; nothing unreachable
pnpm analyze:cost          # per-entry module count, graph bytes, chain SDKs
pnpm analyze:cost:bundle   # ...plus real minified + gzipped bundle bytes (esbuild)
pnpm verify:subpaths       # runtime module-resolution probe, one subpath at a time
```

`analyze:cost:bundle` bundles a synthetic one-import consumer per subpath with
esbuild. esbuild is not a declared dependency of this package, so the flag
degrades to a module-graph report with a note if it cannot be resolved.

`analyze` is a gate, not a report: it exits non-zero on a dangling subpath, an
unreachable emitted module, a missing `sideEffects: false`, or a subpath with no
colocated `.d.ts`. It replaces a hardcoded list of eight filenames that had
drifted out of sync with `package.json` — it could not have caught a dangling
entry, which is the failure mode that only appears after publish.

## For bundler users

Modern bundlers will automatically:

1. Follow subpath exports to their specific entry points
2. Omit unused modules when `sideEffects: false` is set
3. Tree-shake unused named exports
4. Merge declarations correctly with `"declaration": true`

If your bundle still feels large, check that you are not doing a namespace
import (`import * as sdk`) from the root barrel, and that your bundler honours
`sideEffects: false` (all modern ones do).
