# Command contract

This document is the canonical map of the repository's build, test, lint, and
smoke-test entry points. Every workspace package listed here commits to the
script surface described below, and CI enforces it: if a package drops or
renames one of these scripts, `pnpm validate:commands` (and the
**Command Contract** CI job) fails.

If you change a `scripts` block in any `package.json`, or add a new workspace
package, update this document **and** the contract table in
[`scripts/validate-commands.mjs`](../scripts/validate-commands.mjs) in the
same change.

## TL;DR — which command do I run?

| I changed… | Run this |
| --- | --- |
| Solidity contracts (`contracts/`) | `pnpm --filter @wafflefinance/contracts test` |
| Soroban contracts (`soroban/`) | `cd soroban && cargo test` |
| SDK (`packages/sdk/`) | `pnpm --filter @wafflefinance/sdk build && pnpm --filter @wafflefinance/sdk test` |
| Coordinator (`coordinator/`) | `pnpm --filter @wafflefinance/coordinator test` |
| Relayer (`relayer/`) | `pnpm --filter @wafflefinance/relayer test` |
| Resolver (`resolver/`) | `pnpm --filter @wafflefinance/resolver test` |
| Frontend (`frontend/`) | `pnpm --filter @wafflefinance/frontend test` and `pnpm --filter @wafflefinance/frontend lint` |
| Anything cross-package | `pnpm build && pnpm test` from the repo root |
| `package.json` scripts or workspace layout | `pnpm validate:commands && pnpm validate:manifests` |

Tests in one package do **not** validate another package's runtime contract.
The coordinator suite passing says nothing about the relayer; a green Hardhat
run says nothing about the Soroban contracts. Cross-package behaviour is only
covered by the e2e suite (`pnpm test:e2e`).

## Focused test runs

These examples target a single file or test name without running the whole
package suite. They complement — not replace — the suite commands above.

### TypeScript services (coordinator, relayer, resolver, frontend, e2e)

The `test` script for these packages is `vitest run`. Pass extra arguments
after `--` to scope the run:

```bash
# Run a single test file (coordinator example; substitute any service filter)
pnpm --filter @wafflefinance/coordinator exec vitest run src/services/order-service.test.ts

# Run only tests whose name matches a pattern (-t accepts a substring or regex)
pnpm --filter @wafflefinance/coordinator exec vitest run -t "recordSrcLock"

# Same pattern for the relayer or resolver
pnpm --filter @wafflefinance/relayer exec vitest run src/services/recovery-service.test.ts
pnpm --filter @wafflefinance/resolver exec vitest run -t "cursor"
```

> These run the same `vitest run` that the `test` script uses — focused runs
> do not bypass or replace the suite.

### Solidity contracts (Hardhat)

```bash
# Run a single test file
pnpm --filter @wafflefinance/contracts exec hardhat test test/HTLCEscrow.test.ts

# Filter by test name with --grep (substring or regex)
pnpm --filter @wafflefinance/contracts exec hardhat test --grep "claim with valid preimage"
```

> Build step: `pnpm --filter @wafflefinance/contracts build` (or
> `pnpm --filter @wafflefinance/contracts compile`) must have run first so
> Hardhat finds the compiled artifacts.

### Soroban contracts (Cargo)

```bash
# Run a single test function
cd soroban && cargo test test_claim_with_valid_preimage

# Run all tests in a module
cd soroban && cargo test htlc::

# Show stdout for a single test
cd soroban && cargo test test_refund_after_timelock -- --nocapture
```

> Soroban contracts are a Cargo workspace outside the pnpm workspace; no
> `pnpm` command reaches them. Run all commands from the `soroban/` directory.

### SDK — prerequisite build step

Services that import `@wafflefinance/sdk` from its compiled output
(coordinator, relayer, resolver) require the SDK to be built before tests run:

```bash
pnpm --filter @wafflefinance/sdk build   # build once before running service tests
```

The frontend and e2e suite alias SDK source directly and do **not** need a
prior SDK build step.

## Root aggregate commands

Run from the repository root. These fan out with `pnpm -r`, which visits every
workspace package **that defines the script** and silently skips the rest —
the tables below pin down exactly which packages participate in each.

| Command | What it does | Covers |
| --- | --- | --- |
| `pnpm build` | `pnpm -r build` | Every package except `e2e` (test-only, nothing to build) |
| `pnpm test` | `pnpm -r test` | Every package, including `e2e` |
| `pnpm test:e2e` | Cross-package end-to-end suite only | `e2e` |
| `pnpm lint` | `pnpm -r lint` | Every package that defines `lint` (`contracts` uses solhint, the rest eslint; `config` currently has no lint script) |
| `pnpm dev` | `pnpm -r dev` | Long-running dev servers (coordinator, relayer, resolver, dashboard, frontend) |
| `pnpm clean` | `pnpm -r clean` + removes root `node_modules` | Packages that define `clean` |
| `pnpm format` / `pnpm format:check` | Prettier write / check across the repo | All TS/TSX/JSON/MD files |
| `pnpm validate:commands` | Enforces this command contract | All workspace manifests |
| `pnpm validate:manifests` | Validates names, versions, and export paths | All workspace manifests |
| `pnpm validate:deployments` | Validates `deployments.testnet.json` | Deployment records |
| `pnpm validate:release-artifacts` | Verifies built artifacts exist for every declared export path in publishable packages (`@wafflefinance/sdk`, `@wafflefinance/config`); requires `pnpm build` first | Shared package release readiness |
| `pnpm validate:versions` | Checks Node and pnpm version consistency across `.nvmrc`, `engines`, `packageManager`, CI workflows, and dev container | Platform tooling alignment |
| `pnpm health:check` | Smoke-tests a locally running coordinator (`GET /health`) | Coordinator runtime |

`pnpm -r build` ordering is dependency-aware; `@wafflefinance/sdk` and
`@wafflefinance/config` build before the services that import them.

## Per-package contract

The "validates" notes state what a green run of the script actually tells
you, and nothing more.

### `@wafflefinance/contracts` — Solidity / Hardhat (Node driver)

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `hardhat compile` (alias of `compile`) | Solidity sources compile; artifacts generated |
| `compile` | `hardhat compile` | Same as `build` (kept for Hardhat convention) |
| `test` | `hardhat test` | Contract behaviour on an in-process Hardhat EVM |
| `lint` | `solhint 'contracts/**/*.sol'` | Solidity style/security lint only |
| `coverage` | `hardhat coverage` | Test coverage report |
| `clean` | Removes artifacts and cache | — |

Deployment scripts (`deploy:*`, `validate:sepolia`, `validate:mainnet`,
`verify`) are release tooling, not part of the day-to-day contract; see
[RELEASE_POLICY.md](../RELEASE_POLICY.md). Foundry fuzz/invariant tests run
via `scripts/verify-release-locally.{sh,ps1}`, not via a package script.

### `@wafflefinance/coordinator`, `@wafflefinance/relayer`, `@wafflefinance/resolver` — Node 22 services

These services share an identical script surface:

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `tsc` | Type-checks and emits `dist/` |
| `test` | `vitest run` | Unit/integration tests for **this service only** |
| `test:watch` | `vitest` | Watch mode for local development |
| `lint` | `eslint src --ext .ts` | ESLint over the service's sources |
| `dev` | `tsx watch src/index.ts` | Local dev server with reload |
| `start` | `node dist/index.js` | Runs the built service (requires `build` first) |
| `clean` | Removes `dist/` | — |

`@wafflefinance/dashboard` (in `packages/`) follows the same surface, minus
`clean`.

Coordinator extras: `seed-demo` (demo data), `db:backup` / `db:restore`
(operational tooling), and Postgres-backed tests via
`TEST_WITH_POSTGRES=true pnpm --filter @wafflefinance/coordinator test`.

### `@wafflefinance/sdk`, `@wafflefinance/config` — shared TypeScript libraries

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `tsc` | Type-checks and emits `dist/` consumed by every service |
| `test` | `vitest run` | Library unit tests |
| `test:watch` | `vitest` | Watch mode |
| `lint` (sdk only) | `eslint src --ext .ts` | ESLint over sources |
| `clean` | Removes `dist/` | — |

SDK extra: `build:analyze` reports bundle size. Build the SDK before working
on any package that imports it (`pnpm --filter @wafflefinance/sdk build`).

### `@wafflefinance/frontend` — browser app (Vite + React)

| Script | Command | Validates |
| --- | --- | --- |
| `build` | `tsc && vite build` | Type-check plus production bundle |
| `test` | `vitest run` | Component/unit tests (jsdom, not a real browser) |
| `lint` | `eslint . --ext ts,tsx … --max-warnings 0` | Strictest lint in the repo — warnings fail |
| `dev` | `vite` | Local dev server |
| `preview` | `vite preview` | Serves the production build locally |
| `clean` | Removes `dist/` | — |

### `@wafflefinance/e2e` — cross-package end-to-end suite

| Script | Command | Validates |
| --- | --- | --- |
| `test` | `vitest run` | Cross-package flows against running services |
| `test:smoke` | `vitest run cross-chain.test.ts solana-settlement.test.ts solana-timeout-refund.test.ts lifecycle-cases.test.ts` | Deterministic local degraded-mode subset: timeout, duplicate-event (double-claim/refund idempotency), and recovery/backstop-refund cases — no wallets or RPC endpoints |
| `test:watch` | `vitest` | Watch mode |
| `lint` | `eslint src --ext .ts` | ESLint over the test sources |

`e2e` intentionally has **no `build` script** — it is executed by vitest
directly and produces no artifacts. This is the one sanctioned gap in the
`pnpm -r build` fan-out.

### `soroban/` — Rust / Soroban contracts (outside the pnpm workspace)

The Soroban contracts are a Cargo workspace, not a pnpm package, so **no
`pnpm` command reaches them**. Their entry points are:

| Command (from `soroban/`) | Validates |
| --- | --- |
| `stellar contract build` (or `cargo build --release --target wasm32-unknown-unknown`) | Contracts compile to wasm |
| `cargo test` | Contract unit tests on the Soroban host |

See [soroban/README.md](../soroban/README.md) for deployment and
TypeScript-bindings generation.

## Smoke tests

- **Degraded-mode local smoke (no wallets, no RPC):**
  `pnpm --filter @wafflefinance/e2e test:smoke` runs the fast deterministic
  subset (timeout, duplicate-event, and recovery/backstop cases). It exits
  non-zero and names the failing case on any scenario failure. Run this
  before changing recovery or listener code.
- **Coordinator:** start it (`pnpm coordinator:dev`), then `pnpm health:check`
  hits `GET /health` on port 3001.
- **Frontend:** `pnpm frontend:build && pnpm frontend:preview` serves the real
  production bundle.
- **Release:** `scripts/verify-release-locally.sh` (or `.ps1` on Windows) runs
  the full pre-release verification: Hardhat + Foundry compile/test parity,
  SDK build/export checks, and checksums.

## How CI enforces this

`.github/workflows/command-contract.yml` runs on every push and pull request.
It executes `node scripts/validate-commands.mjs`, which:

1. Resolves the workspace package list from the root `package.json`.
2. Fails if any package is missing a script required by this contract, or if
   a required script no longer invokes the tool the contract documents (e.g.
   a `test` script that stops running `vitest run` / `hardhat test`).
3. Fails if a workspace package exists that the contract doesn't cover, so
   new packages must be added to the contract deliberately.
4. Verifies every `pnpm --filter <pkg> <script>` shortcut in the root
   `package.json` resolves to a script that actually exists in the target
   package.

The checker is a dependency-free Node script — CI needs no `pnpm install`,
and you can run it locally the same way.

Related but separate: `pnpm validate:manifests` checks manifest names,
versions, and export paths. Note it verifies built artifacts referenced by
`exports`, so it needs `pnpm --filter @wafflefinance/sdk build` (or a full
`pnpm build`) to have run first.

---

## CI vs local — which checks run where

Use this table to understand what a green PR actually proves and what you
still need to verify locally before opening one.

| Check | Command | When it runs | Workflow / job |
|---|---|---|---|
| Command contract (scripts match docs) | `pnpm validate:commands` | Every push + PR | [`command-contract.yml`](../.github/workflows/command-contract.yml) → `validate` |
| Foundry fuzz + invariant tests | `cd contracts && forge test` | Push/PR to `contracts/**` | [`foundry-contracts.yml`](../.github/workflows/foundry-contracts.yml) → `foundry` |
| Soroban cargo test + property fuzz | `cd soroban && cargo test` | Push/PR to `soroban/**` | [`soroban-contracts.yml`](../.github/workflows/soroban-contracts.yml) → `test` |
| Frontend Vitest (testnet + mainnet legs) | `pnpm --filter @wafflefinance/frontend test` | Push/PR to `frontend/**`, `packages/sdk/**`, `packages/config/**` | [`frontend.yml`](../.github/workflows/frontend.yml) → `vitest` |
| Frontend TypeScript type-check | `pnpm --filter @wafflefinance/frontend build` | Same path filter as above | [`frontend.yml`](../.github/workflows/frontend.yml) → `typecheck` |
| Frontend ESLint | `pnpm --filter @wafflefinance/frontend lint` | Same path filter as above | [`frontend.yml`](../.github/workflows/frontend.yml) → `lint` |
| Dependency CVE + licence scan | — (GitHub action, no local equivalent) | PRs touching `pnpm-lock.yaml` or any `package.json` | [`dep-review.yml`](../.github/workflows/dep-review.yml) → `dependency-review` |
| Cross-package dep-version alignment | `pnpm validate:deps` | Same path filter as dep-review | [`dep-review.yml`](../.github/workflows/dep-review.yml) → `validate-deps` |
| **Coordinator tests** | `pnpm --filter @wafflefinance/coordinator test` | **Local only — no CI job** | — |
| **Relayer tests** | `pnpm --filter @wafflefinance/relayer test` | **Local only — no CI job** | — |
| **Resolver tests** | `pnpm --filter @wafflefinance/resolver test` | **Local only — no CI job** | — |
| **SDK build + tests** | `pnpm --filter @wafflefinance/sdk build && pnpm --filter @wafflefinance/sdk test` | **Local only — no CI job** | — |
| **Hardhat contract tests** (Node driver) | `pnpm --filter @wafflefinance/contracts test` | **Local only — no CI job** | — |
| **Deployment manifest validation** | `pnpm validate:deployments` | **Local only — no CI job** | — |
| **Doc-drift + stale links** | `pnpm validate:docs` | **Local only — no CI job** | — |
| **Release verification** | `scripts/verify-release-locally.sh` | **Local only — no CI job** | — |
| **E2E cross-chain suite** | `pnpm test:e2e` | **Local only — no CI job** | — |

**Key takeaways:**

- CI only runs the command contract, Foundry/Soroban contract tests,
  frontend suite, and dependency review. Everything else is local only.
- A green PR does **not** mean coordinator, relayer, resolver, or SDK tests
  passed — you must run those locally before opening a PR if you touched
  those packages.
- Path filters mean CI is skipped entirely for a PR that only touches
  `coordinator/` or `relayer/` — those packages have no dedicated CI job.
- `pnpm validate:deployments` and `pnpm validate:docs` must be run manually;
  they catch manifest and doc drift that CI does not detect.
