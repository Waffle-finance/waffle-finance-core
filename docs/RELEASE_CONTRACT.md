# Typed Build & Release Contract

A single, explicit contract for what "build" and "release" mean for each
package in this monorepo — build target, environment assumptions, artifact
names, and migration steps — so release readiness doesn't depend on an
individual maintainer remembering the right command sequence per package.

This document sits above two existing, narrower documents:

- [RELEASE_POLICY.md](../RELEASE_POLICY.md) — versioning policy (SemVer, version
  sync) and npm publish mechanics for the *publishable* packages.
- [.github/RELEASE_PROCESS.md](../.github/RELEASE_PROCESS.md) — what
  `scripts/verify-release-locally.sh` actually checks today (contracts + SDK
  in depth; everything else only typechecked).

## Coverage gap found while writing this contract (2026-07-26)

`scripts/verify-release-locally.sh` is the closest thing this repo has to a
CI-safe validation path today (see [docs/QUALITY_GATE.md](QUALITY_GATE.md) for
why it isn't wired into actual CI). Reading it line by line against the five
packages this issue asks the contract to cover:

| Package | What `verify-release-locally.sh` does |
|---|---|
| `contracts` (EVM) | Full: Hardhat compile, Foundry compile, bytecode consistency, both test suites, checksums |
| `packages/sdk` | Full: build, export validation, import testing, test suite, size check, checksums |
| `coordinator` | **Typecheck only** (`tsc --noEmit`) — never runs `pnpm build`, never runs its test suite as part of this script |
| `resolver` | **Typecheck only** — same gap |
| `frontend` | **Typecheck only** — same gap |
| `relayer` | **Not referenced anywhere in the script.** No build, no typecheck, no test run. |
| `soroban` (Rust/Stellar contracts) | **Not referenced anywhere in the script.** `EXPORT_PATHS=("... soroban ...")` on line 181 checks the SDK's `soroban` *TypeScript* subpath export — it does not touch `soroban/Cargo.toml` or run `stellar contract build`. |

So today, a release can pass local verification with the relayer failing to
build and the Soroban contracts failing to compile, and nothing catches it
until someone runs `pnpm --filter @wafflefinance/relayer build` or `cd soroban
&& stellar contract build` by hand. This is the gap the contract below is
scoped to close.

## The contract

For each package, the columns below are what "the build succeeded" and
"this artifact is releasable" concretely mean.

### `contracts` (EVM — Hardhat + Foundry)

| | |
|---|---|
| Build command | `pnpm --filter @wafflefinance/contracts compile` (Hardhat) + `forge build` (Foundry, run from `contracts/`) |
| Build target | Solidity → EVM bytecode + ABI, dual-toolchain for reproducibility |
| Artifact | `contracts/artifacts/contracts/**/*.json` (Hardhat), Foundry's own `out/` — validated critical contracts are `HTLCEscrow.sol`, `ResolverRegistry.sol` |
| Environment assumptions | Network config in `contracts/hardhat.config.ts`; `.env` RPC vars for `deploy:sepolia`/`deploy:mainnet` |
| Migration steps | None (contracts are immutable once deployed); a new deployment gets a new address recorded in `deployments.testnet.json` and `env.example` (see [docs/QUALITY_GATE.md](QUALITY_GATE.md) check #8) |
| Local verification today | Full — covered by `verify-release-locally.sh` |

### `packages/sdk`

| | |
|---|---|
| Build command | `pnpm --filter @wafflefinance/sdk build` |
| Build target | TypeScript → `dist/` (ESM), with subpath exports `ethereum`, `soroban`, `secrets`, `state-machine`, `solana`, `assets`, `types` per [RELEASE_POLICY.md](../RELEASE_POLICY.md) |
| Artifact | `packages/sdk/dist/index.js` + `.d.ts`, one pair per subpath export; published to npm as `@wafflefinance/sdk` |
| Environment assumptions | None at build time — the SDK is environment-agnostic by design |
| Migration steps | None — consumers pin a version; breaking changes are a major version bump per [RELEASE_POLICY.md](../RELEASE_POLICY.md#major-release-x00) |
| Local verification today | Full — covered by `verify-release-locally.sh` |

### `coordinator`

| | |
|---|---|
| Build command | `pnpm --filter @wafflefinance/coordinator build` (`tsc`) |
| Build target | TypeScript → `dist/index.js`, run with `node dist/index.js` — **not** published to npm ([RELEASE_POLICY.md](../RELEASE_POLICY.md) lists it as the one private package) |
| Artifact | `coordinator/dist/`. No Dockerfile in this repo (see [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md#deployment-topology-as-it-actually-exists-in-this-repo)) — the release artifact is the compiled JS, not a container image |
| Environment assumptions | `DATABASE_URL`, `COORDINATOR_PORT`, RPC URLs for Ethereum/Soroban/Solana — see `env.example` |
| Migration steps | SQL migrations in `coordinator/migrations/`, auto-applied on startup and tracked in the `schema_migrations` table — see `coordinator/docs/migrations.md`. A release that adds a migration file must be deployed with a DB backup taken first (`pnpm --filter @wafflefinance/coordinator db:backup`) |
| Local verification today | Partial — typechecked only; `pnpm build` and the test suite are not part of `verify-release-locally.sh` |

### `relayer`

| | |
|---|---|
| Build command | `pnpm --filter @wafflefinance/relayer build` (`tsc`), or `docker build -f relayer/Dockerfile .` for the container artifact |
| Build target | TypeScript → `dist/index.js`; Dockerfile produces a `node:22-alpine` runtime image exposing port `8080` |
| Artifact | `relayer/dist/` and/or the built Docker image |
| Environment assumptions | `RELAYER_ADMIN_API_KEY`, `RELAYER_ADMIN_PRIVATE_KEY`, `ETHEREUM_RPC_URL`, `STELLAR_HORIZON_URL` — several of these are read in code but currently missing from `env.example` (see [docs/QUALITY_GATE.md](QUALITY_GATE.md#1-env-vars-read-in-code-but-missing-from-envexample)) |
| Migration steps | None (stateless relayer; persistence is delegated to the coordinator) |
| Local verification today | **None** — not referenced in `verify-release-locally.sh` at all |

### `resolver`

| | |
|---|---|
| Build command | `pnpm --filter @wafflefinance/resolver build` (`tsc`), or `docker build -f resolver/Dockerfile .` |
| Build target | TypeScript → `dist/index.js`; Dockerfile produces a `node:20-alpine` image with `ENTRYPOINT ["node", "dist/index.js"] CMD ["run"]` |
| Artifact | `resolver/dist/` and the Docker image — the only package with a CI-gated Docker publish step described in [.github/RELEASE_PROCESS.md](../.github/RELEASE_PROCESS.md) (`resolver-docker` job, gated on verification passing) — though see [docs/QUALITY_GATE.md](QUALITY_GATE.md#2-docs-reference-ci-workflow-files-that-do-not-exist-in-the-repo) for the fact that no `.github/workflows/` currently exists to run that job |
| Environment assumptions | `RESOLVER_ETH_PRIVATE_KEY`, `RESOLVER_STELLAR_SECRET`, `RESOLVER_HEALTH_PORT`, `RESOLVER_METRICS_PORT` (the latter two missing from `env.example`) |
| Migration steps | None (stateless; registry state lives on-chain) |
| Local verification today | Partial — typechecked only |

### `frontend`

| | |
|---|---|
| Build command | `pnpm --filter @wafflefinance/frontend build` (`tsc && vite build`) |
| Build target | TypeScript + Vite → static assets in `frontend/dist/` |
| Artifact | `frontend/dist/`, deployed via Vercel — see [vercel.json](../vercel.json) (`buildCommand` builds the SDK first, then the frontend, then copies `frontend/dist` to the repo-root `dist/` that Vercel serves) |
| Environment assumptions | `VITE_API_BASE_URL`, `VITE_NETWORK_MODE`, `VITE_*_RPC_URL` — build-time-inlined, not runtime-configurable once built. `VITE_ENABLE_MOCK_DATA` is read in code but missing from `env.example` |
| Migration steps | None |
| Local verification today | Partial — typechecked only |

### `soroban` (Rust — Stellar/Soroban contracts)

| | |
|---|---|
| Build command | `stellar contract build` (per-package, `htlc` and `resolver-registry`) or `cargo build --release --target wasm32-unknown-unknown` |
| Build target | Rust → WASM, per [soroban/Cargo.toml](../soroban/Cargo.toml) workspace (`contracts/htlc`, `contracts/resolver-registry`), `release` profile with `lto = true`, `strip = "symbols"` |
| Artifact | WASM binaries under the `stellar contract build` output directory (see `soroban/scripts/deploy.sh`, which calls `stellar contract build --print-build-dir`) |
| Environment assumptions | Soroban CLI (`stellar`) installed and on PATH; deploy step additionally needs a funded Stellar account and network passphrase (testnet/mainnet, per `soroban/scripts/deploy.sh`) |
| Migration steps | None (contracts are immutable once deployed; a redeploy is a new contract ID, recorded the same way as the EVM side — `SOROBAN_HTLC_TESTNET` etc. in `env.example`) |
| Local verification today | **None** — not part of `verify-release-locally.sh`, and versioned independently (`workspace.package.version = "0.1.0"` in `soroban/Cargo.toml`) from the npm packages' `1.0.0` |

### `solana` (Rust — Anchor / Solana HTLC Program)

| | |
|---|---|
| Build command | `anchor build --verifiable` (from `solana/`) or `cargo build-sbf` |
| Build target | Rust → Solana SBF ELF bytecode (`target/deploy/wafflefinance_htlc.so`) + Anchor IDL (`target/idl/wafflefinance_htlc.json`) |
| Artifact | `solana/target/deploy/wafflefinance_htlc.so` and IDL; verified on-chain via `solana-verify` |
| Environment assumptions | Anchor CLI + Solana CLI installed; `SOLANA_HTLC_PROGRAM_TESTNET` / `SOLANA_HTLC_PROGRAM_MAINNET`; private multi-endpoint RPCs for mainnet per [docs/SOLANA_OPERATOR_GUIDE.md](SOLANA_OPERATOR_GUIDE.md) |
| Migration steps | Program upgrade via Anchor CLI / Squads multi-sig upgrade authority; no storage migration required for active Order PDAs |
| Local verification today | Anchor test suite (`anchor test`) + SDK IDL schema compatibility and production readiness suite (`npx vitest run test/anchor-schema-stability.test.ts test/solana-production-readiness.test.ts`) |

### Metadata inconsistency found while auditing this table

[RELEASE_POLICY.md](../RELEASE_POLICY.md#required-fields) requires every
`package.json` to set `"repository": {"url":
"https://github.com/waffle-finance/waffle-finance-core.git"}`. The npm
packages follow this. `soroban/Cargo.toml`'s `[workspace.package]`, however,
sets `repository = "https://github.com/karagozemin/wafflefinance"` and
`homepage` to the same URL — a different GitHub account/repo name entirely.
Anyone following that link from crate metadata lands somewhere other than
this repository. This should be corrected to match the npm packages'
convention the next time `soroban/Cargo.toml` is touched.

## Validation path (target state)

The contract above implies `verify-release-locally.sh` should gain two new
sections to match its existing contracts/SDK depth:

1. **Relayer**: `pnpm --filter @wafflefinance/relayer build` +
   `pnpm --filter @wafflefinance/relayer test`, mirroring the pattern already
   used for the SDK section of the script.
2. **Soroban**: `stellar contract build --package wafflefinance-htlc` and
   `--package wafflefinance-resolver-registry` (or `cargo build --release
   --target wasm32-unknown-unknown` as a CLI-less fallback), plus `cargo test`
   for the Rust unit/property tests already present under `soroban/contracts/`.
3. **Coordinator, resolver, frontend**: upgrade their existing typecheck-only
   steps to also run `pnpm build` (and, ideally, their test suites) rather
   than typecheck alone — a package can typecheck cleanly and still fail to
   build (e.g. a bundler-specific import issue).

## Status

This document defines the contract — the build target, artifact, environment
assumptions, and migration steps per package, plus the specific coverage gaps
found in the current local verification script. Extending
`scripts/verify-release-locally.sh` (and the `.github/RELEASE_PROCESS.md`
workflow it describes) to actually enforce items 1–3 above is out of scope for
this documentation pass and is the natural next implementation step.
