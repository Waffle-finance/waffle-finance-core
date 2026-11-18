# Multi-Package Release Checklist

> **Owner:** Engineering team  
> **Status:** Current  
> **Related docs:**
> - [RELEASE_POLICY.md](../RELEASE_POLICY.md) — versioning policy and publish mechanics
> - [docs/RELEASE_CONTRACT.md](RELEASE_CONTRACT.md) — per-package build targets and verification gaps
> - [.github/RELEASE_CHECKLIST.md](../.github/RELEASE_CHECKLIST.md) — operational release gate (use alongside this doc)
> - [docs/COMMANDS.md](COMMANDS.md) — canonical command reference per package

A change to one package in this monorepo almost always has ripple effects.
This document gives you a structured way to identify which packages are
affected before you cut a release, and what must be verified for each.

---

## Part 1 — Cross-package impact matrix

For each type of change you are releasing, check the row and verify every
downstream package listed.

| If you changed… | Directly affected | Transitively affected | What to verify |
|---|---|---|---|
| `packages/sdk` | `coordinator`, `relayer`, `resolver`, `frontend`, `e2e` | — | Build + test all five consumers; check SDK subpath exports haven't shrunk |
| `packages/config` | `coordinator`, `relayer`, `resolver`, `frontend`, `packages/sdk` | all of the above | All consumers still build cleanly against the new config schema |
| `contracts/` (EVM) | `packages/sdk` (ABI bindings), `relayer` (ABI in index.ts), `e2e` | `frontend`, `coordinator` (via SDK) | Hardhat + Foundry compile; SDK ABI imports resolve; relayer ABI updated if signatures changed |
| `soroban/` (Stellar contracts) | `packages/sdk` (TS bindings), `resolver` (Soroban settle path), `e2e` | `frontend`, `coordinator` | Regenerate TS bindings (TD-020); build SDK; `cargo test` in `soroban/` |
| `coordinator/` | `e2e`, `relayer` (polling coordinator API), `frontend` (REST consumer) | — | Coordinator build + test; check REST API contract hasn't changed under consumers |
| `relayer/` | `coordinator` (relayer status feeds), `e2e` | — | Relayer build + test; verify health endpoint still matches `docs/HEALTH_DASHBOARD.md` |
| `resolver/` | `coordinator` (resolver registry lookups), `e2e` | — | Resolver build + test; verify on-chain registry address in `env.example` is current |
| `frontend/` | — | — | Frontend build + test (both testnet + mainnet legs) |
| `e2e/` | — | — | `pnpm --filter @wafflefinance/e2e test` against running local stack |
| `env.example` | All services that read the changed var | — | `pnpm validate:docs` (check #1 in quality gate) |
| `deployments.testnet.json` | `env.example`, `docs/OPERATIONS.md` | SDK asset mappings | Addresses in `env.example` contract-address section match; `pnpm validate:deployments` |

---

## Part 2 — Per-package verification steps

Work through only the packages marked affected in Part 1.

### `packages/sdk`

```bash
pnpm --filter @wafflefinance/sdk build
pnpm --filter @wafflefinance/sdk test
# Verify subpath exports haven't shrunk:
pnpm validate:manifests
```

- [ ] Build succeeds, all subpath export files present in `dist/`
- [ ] Test suite green
- [ ] `pnpm validate:manifests` passes
- [ ] Bundle size checked (`pnpm --filter @wafflefinance/sdk build:analyze`) — warn if > 10 MB

**SDK change impact on consumers:** after changing the SDK, run a build for
every consuming package before considering the SDK release ready:

```bash
pnpm --filter @wafflefinance/coordinator build
pnpm --filter @wafflefinance/relayer build
pnpm --filter @wafflefinance/resolver build
pnpm --filter @wafflefinance/frontend build
```

---

### `packages/config`

```bash
pnpm --filter @wafflefinance/config build
pnpm --filter @wafflefinance/config test
```

- [ ] Build succeeds
- [ ] Test suite green
- [ ] All consumers (SDK, coordinator, relayer, resolver, frontend) rebuild cleanly

---

### `contracts/` (EVM — Hardhat + Foundry)

```bash
pnpm --filter @wafflefinance/contracts compile   # Hardhat
forge build                                       # run from contracts/
pnpm --filter @wafflefinance/contracts test       # Hardhat suite
forge test                                        # Foundry fuzz/invariant
```

- [ ] Hardhat compile clean; artifacts present for `HTLCEscrow.sol` and `ResolverRegistry.sol`
- [ ] Foundry compile clean; bytecode consistency with Hardhat confirmed
- [ ] All Hardhat tests green
- [ ] All Foundry tests green (including fuzz/invariant)
- [ ] If ABI changed: relayer's `index.ts` ABI constants updated; SDK ABI imports updated
- [ ] If a new deployment was made: `deployments.testnet.json` updated; `env.example` contract-address section updated; `pnpm validate:deployments` passes

---

### `soroban/` (Rust — Stellar/Soroban contracts)

```bash
# Run from soroban/
stellar contract build --package wafflefinance-htlc
stellar contract build --package wafflefinance-resolver-registry
cargo test --workspace --locked
```

- [ ] Both contracts build to WASM without errors
- [ ] `cargo test` green (unit + state-machine harness + property fuzz)
- [ ] If deployed to a new address: TS bindings regenerated (`stellar contract bindings typescript`), SDK rebuilt, `SOROBAN_HTLC_TESTNET` in `env.example` updated
- [ ] Soroban admin key is not a single EOA on mainnet (pre-mainnet checklist item, TD-021)

---

### `coordinator/`

```bash
pnpm --filter @wafflefinance/coordinator build
pnpm --filter @wafflefinance/coordinator test
# Postgres-backed test path (if schema changed):
TEST_WITH_POSTGRES=true pnpm --filter @wafflefinance/coordinator test
```

- [ ] Build (`tsc`) succeeds; `dist/index.js` present
- [ ] Test suite green
- [ ] If a migration was added: `coordinator/migrations/` contains the new file; DB backup step noted in release notes (`pnpm --filter @wafflefinance/coordinator db:backup`)
- [ ] `SECRET_STORAGE_KEY` is set in deployment environment (TD-041 — plaintext secrets if unset)
- [ ] REST API contract unchanged for relayer and frontend consumers; or breakage documented with migration notes
- [ ] Health endpoint still matches `docs/HEALTH_DASHBOARD.md` (port 3001, `/health`, `/readyz`)

---

### `relayer/`

```bash
pnpm --filter @wafflefinance/relayer build
pnpm --filter @wafflefinance/relayer test
```

- [ ] Build (`tsc`) succeeds; `dist/index.js` present
- [ ] Test suite green
- [ ] Docker image builds if container artifact is expected: `docker build -f relayer/Dockerfile .`
- [ ] All env vars used in code are documented in `env.example` (cross-check against quality gate finding #1 — several relayer vars were missing)
- [ ] Health endpoint still matches `docs/HEALTH_DASHBOARD.md`

---

### `resolver/`

```bash
pnpm --filter @wafflefinance/resolver build
pnpm --filter @wafflefinance/resolver test
```

- [ ] Build (`tsc`) succeeds; `dist/index.js` present
- [ ] Test suite green
- [ ] Docker image builds: `docker build -f resolver/Dockerfile .`
- [ ] `RESOLVER_HEALTH_PORT` and `RESOLVER_METRICS_PORT` are documented in `env.example`

---

### `frontend/`

```bash
pnpm --filter @wafflefinance/frontend build   # tsc + vite build
pnpm --filter @wafflefinance/frontend test    # vitest run
pnpm --filter @wafflefinance/frontend lint
```

- [ ] Build succeeds; `frontend/dist/` populated
- [ ] Test suite green — **both** testnet-only and mainnet-enabled runs
  (matches what `frontend.yml` CI does; run manually with
  `VITE_MAINNET_ENABLED=true pnpm --filter @wafflefinance/frontend test`)
- [ ] Lint clean (zero warnings — frontend uses `--max-warnings 0`)
- [ ] `VITE_ENABLE_MOCK_DATA` documented in `env.example` if used

---

### `e2e/`

```bash
pnpm --filter @wafflefinance/e2e test
# or from root:
pnpm test:e2e
```

- [ ] Cross-package E2E suite green against a locally running stack
- [ ] If Solana devnet tests are enabled (`RUN_DEVNET_E2E=true`): devnet round-trip passes

---

## Part 3 — Shared release gates (all packages)

These checks apply regardless of which packages changed.

### Quality gate scripts

```bash
pnpm validate:commands    # enforces docs/COMMANDS.md script contract
pnpm validate:manifests   # names, versions, export paths in sync
pnpm validate:deployments # deployments.testnet.json consistency
pnpm validate:deps        # dep version alignment per DEPENDENCY_POLICY.md
pnpm validate:docs        # broken markdown links + stale pnpm command refs
```

- [ ] All five `validate:*` scripts pass with no errors

### Version synchronisation

Per `RELEASE_POLICY.md`, all published packages must move together:

| Package | Published to | Must bump together? |
|---|---|---|
| `@wafflefinance/sdk` | npm | Yes |
| `@wafflefinance/contracts` | npm | Yes |
| `@wafflefinance/frontend` | Vercel (not npm) | Yes — version in `package.json` must match |
| `@wafflefinance/relayer` | Docker / GHCR | Yes |
| `@wafflefinance/resolver` | Docker / GHCR | Yes |
| `@wafflefinance/coordinator` | private | Independent — but note the major version in release notes if changed |
| `soroban/Cargo.toml` | — | Independent; Rust crate version is not locked to npm version |

- [ ] `pnpm version X.Y.Z -ws` applied; all npm package versions match
- [ ] `soroban/Cargo.toml` version updated if Soroban contracts changed

### Documentation

- [ ] `docs/TECHNICAL_DEBT.md` — resolved items marked ✅; new items added
- [ ] `docs/DOC_MAP.md` — new documents added to index; archival notices added to retired docs
- [ ] `env.example` — all new env vars added with comments; removed vars deleted
- [ ] `deployments.testnet.json` — updated if new contract deployed

---

## Part 4 — Risk scoring

Use this to decide how much review and validation is required before merging
and tagging.

| Risk level | Criteria | Required validation |
|---|---|---|
| **Low** | Docs-only, config comments, test additions with no logic change | `pnpm validate:docs`; one reviewer |
| **Medium** | Single-package change with no API or contract surface change | Per-package verification (Part 2) + all quality gate scripts (Part 3); one reviewer |
| **High** | SDK change, config schema change, EVM/Soroban contract change, breaking API change, new env var | Full Part 2 for all affected packages + Part 3 + `verify-release-locally.sh`; two reviewers |
| **Critical** | Security-relevant change (auth, key handling, contract funds), mainnet-path change | All of High + security review from a second engineer familiar with the affected subsystem; no time pressure — take extra time |

Changes that touch `contracts/contracts/HTLCEscrow.sol`,
`soroban/contracts/htlc/`, `coordinator/src/services/secret-service.ts`,
`relayer/src/index.ts` (ABI or key handling sections), or anything under
`packages/sdk/src/secrets/` are always **Critical** risk regardless of the
apparent size of the diff.

---

## Quick reference — which command, which package

| Changed area | Fastest targeted test | Full verification |
|---|---|---|
| `contracts/` | `pnpm --filter @wafflefinance/contracts test` | + `forge test` + `verify-release-locally.sh` |
| `soroban/` | `cargo test` (from `soroban/`) | + `stellar contract build` both packages |
| `packages/sdk` | `pnpm --filter @wafflefinance/sdk build && pnpm --filter @wafflefinance/sdk test` | + build all 4 consumers |
| `packages/config` | `pnpm --filter @wafflefinance/config build` | + build all consumers |
| `coordinator/` | `pnpm --filter @wafflefinance/coordinator test` | + `TEST_WITH_POSTGRES=true` variant |
| `relayer/` | `pnpm --filter @wafflefinance/relayer test` | + Docker build |
| `resolver/` | `pnpm --filter @wafflefinance/resolver test` | + Docker build |
| `frontend/` | `pnpm --filter @wafflefinance/frontend test` | + `VITE_MAINNET_ENABLED=true` variant + lint |
| Any cross-package | `pnpm build && pnpm test` | + `pnpm validate` + `verify-release-locally.sh` |
