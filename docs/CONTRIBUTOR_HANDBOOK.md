# Contributor Handbook

This is the map for making a change safely in a repository where "it works
locally" and "it doesn't break the bridge" are two different questions. It
answers three things a new contributor needs before opening a PR:

1. **Where does my change actually belong?** (package boundaries)
2. **What do I run to prove it, and what does a green run *not* prove?**
   (validation checklist per package)
3. **What's the blast radius if I get it wrong?** (cross-package coupling)

This handbook is deliberately thin on setup steps and command syntax — those
already live in [`DEVELOPMENT.md`](./DEVELOPMENT.md) (environment setup,
per-package commands, troubleshooting) and [`COMMANDS.md`](./COMMANDS.md)
(the CI-enforced command contract). Read this doc first to orient yourself,
then use those two as reference while you work.

---

## Table of contents

- [The one rule](#the-one-rule)
- [Package ownership map](#package-ownership-map)
- [Package boundaries](#package-boundaries)
- [Where do I make this change?](#where-do-i-make-this-change)
- [Per-package validation checklist](#per-package-validation-checklist)
- [Cross-package coupling you can't see from one package](#cross-package-coupling-you-cant-see-from-one-package)
- [Before you open a PR](#before-you-open-a-pr)

---

## Package ownership map

Use this table as the fastest route from a behavior to the package that owns
it, its primary responsibility, and the first command to run after a change.
Every active workspace package is listed once; commands that exist only in
`docs/COMMANDS.md` are cross-referenced, not duplicated.

| Package | Directory | Primary responsibility | Focused test command | Guide |
|---|---|---|---|---|
| `@wafflefinance/contracts` | `contracts/` | Solidity HTLCEscrow + ResolverRegistry (EVM settlement source of truth) | `pnpm --filter @wafflefinance/contracts test` | [contracts/README.md](../contracts/README.md) |
| Soroban contracts | `soroban/` | Rust HTLC + ResolverRegistry (Stellar settlement source of truth). **Not a pnpm package.** | `cd soroban && cargo test` | [soroban/README.md](../soroban/README.md) |
| `@wafflefinance/sdk` | `packages/sdk/` | Chain-agnostic client surface (IHTLCClient adapters, state machine, asset resolution, coordinator REST client). Build before running any service that imports it. | `pnpm --filter @wafflefinance/sdk build && pnpm --filter @wafflefinance/sdk test` | — |
| `@wafflefinance/config` | `packages/config/` | Shared env-var validation and typed config for all TS packages | `pnpm --filter @wafflefinance/config build` | — |
| `@wafflefinance/coordinator` | `coordinator/` | Order book service — REST API, order state machine, per-chain event listeners, reconciliation/replay, stale-order cleanup | `pnpm --filter @wafflefinance/coordinator test` | [coordinator/README.md](../coordinator/README.md) |
| `@wafflefinance/relayer` | `relayer/` | Bridge relay — creates/processes swap orders, refund watchdog, gas tracking, mainnet Stellar signing | `pnpm --filter @wafflefinance/relayer test` | [relayer/README.md](../relayer/README.md) |
| `@wafflefinance/resolver` | `resolver/` | Open-source resolver runner — pure listener + relay, no order store, supervises its own listener lifecycle | `pnpm --filter @wafflefinance/resolver test` | [resolver/README.md](../resolver/README.md) |
| `@wafflefinance/frontend` | `frontend/` | React + Vite dApp — wallet connection, bridge form, client-side order polling | `pnpm --filter @wafflefinance/frontend test` | [frontend/README.md](../frontend/README.md) |
| `@wafflefinance/e2e` | `e2e/` | In-memory cross-chain differential test harness (no real RPCs or running services) | `pnpm test:e2e` (or `pnpm --filter @wafflefinance/e2e test`) | — |
| `@wafflefinance/dashboard` | `packages/dashboard/` | Aggregates `/health`, `/healthz`, `/readyz` across services | `pnpm --filter @wafflefinance/dashboard build` | — |

**Notes:**
- All `pnpm --filter` commands above match the script names in
  [`docs/COMMANDS.md`](./COMMANDS.md); `pnpm validate:commands` enforces
  they remain accurate.
- "Focused" means the smallest meaningful check for that package — it does
  not replace the full suite or cross-package verification. See the
  [Per-package validation checklist](#per-package-validation-checklist)
  below for what each green run proves and does not prove.
- Soroban is a Cargo workspace outside the pnpm workspace; no `pnpm` command
  reaches it. All commands for Soroban run from the `soroban/` directory.

---

## The one rule

**A green test suite in one package tells you nothing about any other
package.** This repo is a bridge: money moves across three independent
blockchains and four Node services plus a browser app, and the order state
machine is *duplicated* (not shared at runtime) between the coordinator and
the SDK. The failure mode this handbook exists to prevent is: you fix
something in `coordinator/`, `pnpm --filter @wafflefinance/coordinator test`
goes green, and you ship a change that silently breaks the relayer's view of
the same order, or a frontend build that no longer type-checks against the
SDK's exported types.

`docs/COMMANDS.md` states this explicitly in its own TL;DR table — this
handbook exists to help you reason about *why*, package by package.

---

## Package boundaries

```
contracts/          Solidity — HTLCEscrow + ResolverRegistry (Ethereum)
                     Source of truth for EVM settlement rules.

soroban/             Rust — Soroban HTLC + ResolverRegistry (Stellar)
                     Source of truth for Stellar settlement rules.
                     NOT in the pnpm workspace — its own Cargo workspace.

packages/sdk/        @wafflefinance/sdk — chain-agnostic client surface.
                     Every other TS package (coordinator, relayer, resolver,
                     frontend, e2e) imports this. It has no server of its
                     own; it wraps each chain's RPC/SDK behind IHTLCClient.

packages/config/     @wafflefinance/config — shared env var validation.
packages/dashboard/  Aggregates /health, /healthz, /readyz across services.

coordinator/         Order book service — REST API, SQLite/Postgres,
                     per-chain event listeners, order state machine,
                     reconciliation/replay, stale-order cleanup.
                     Never holds private keys. Source of truth for order
                     *metadata* — not for settlement (the chains are).

relayer/             Bridge relay — creates/processes swap orders, refund
                     watchdog, gas tracking. Talks to Ethereum + Stellar
                     directly (holds signing keys for the reference flow).

resolver/            Open-source resolver runner. Pure listener + relay:
                     watches Ethereum/Soroban events, has no order store of
                     its own, hands off to the coordinator/relayer.

frontend/            React + Vite dApp. Consumes the SDK's TS *source*
                     directly (no build step in between — see vite.config.ts
                     aliasing), not a published SDK build.

e2e/                 In-memory cross-chain differential test harness. Does
                     NOT start real services or hit real RPCs — it runs
                     EVM/Soroban/Solana HTLC simulators against the SDK's
                     real secret/hashlock logic.
```

If you're not sure which package owns a piece of behavior, use this rule:
**contracts and soroban own settlement truth; coordinator owns order
metadata; the SDK owns the client-side contract for talking to both.**
Everything else (relayer, resolver, frontend) is a consumer of one or more
of those three.

---

## Where do I make this change?

| I want to… | Start here | Then check |
| --- | --- | --- |
| Change settlement/claim/refund rules on Ethereum | [`contracts/contracts/HTLCEscrow.sol`](../contracts/contracts/HTLCEscrow.sol) | `packages/sdk/src/ethereum/adapter.ts` (client must match new ABI), `contracts/test/gas-regression.test.ts` (gas cost is a tracked contract) |
| Change settlement/claim/refund rules on Stellar | [`soroban/contracts/htlc/src/lib.rs`](../soroban/contracts/htlc/src/lib.rs) | `packages/sdk/src/soroban/htlc-bindings` (regenerate via `stellar contract bindings typescript`, see `soroban/README.md`), `docs/HTLC_IDL.md` |
| Add a field to an order / change order state transitions | `packages/sdk/src/state-machine/` **and** `coordinator/src/state-machine/order-machine.ts` — these are two independent implementations of the same lifecycle, not one shared module | `coordinator/src/persistence/schema.sql` + a new migration, `coordinator/src/persistence/orders-repo.ts`, `docs/ORDER_IDS.md` if the ID format changes |
| Add or change a chain listener (new event, new chain) | `coordinator/src/listeners/` (owns order state) and/or `resolver/src/listeners/` (owns event relay) — these are separate listener implementations per service, not shared | `coordinator/src/reconciliation/reconciler.ts` (replay logic must also cover the new event), retry/timeout conventions in `coordinator/src/retry.ts` |
| Change health/readiness reporting | The specific service's own module — `coordinator/src/readiness.ts`, `relayer/src/routes/health.ts`, or `resolver/src/health.ts` (each is independently implemented, no shared package) | [`docs/HEALTH_DASHBOARD.md`](./HEALTH_DASHBOARD.md), `packages/dashboard` if the aggregation contract changes |
| Add a coordinator REST endpoint | `coordinator/src/server/routes/` | `packages/sdk/src/coordinator/client.ts` (the SDK's typed client for that endpoint), `packages/sdk/test/coordinator-client.test.ts` |
| Change wallet connection / bridge form UX | `frontend/src/features/bridge/` and `frontend/src/hooks/` | `packages/sdk` client used under `frontend/src/lib/sdk-context.ts` — the frontend imports SDK source directly, so a broken SDK type breaks the frontend build immediately |
| Add support for a new asset/token pair | `packages/sdk/src/assets/` (`resolve*Asset` functions) | `frontend/src/components/TokenSelector.tsx`, `coordinator` validation in `src/validation/announce.ts` |
| Change refund/recovery behavior (watchdog, auto-refund) | `relayer/src/services/recovery-service.ts`, `refund-watchdog.ts` | `docs/OPERATIONS.md` (incident response section), the four-layer refund table in the root `README.md` |
| Change a `package.json` script or add a new workspace package | The package's `package.json` | `docs/COMMANDS.md` **and** `scripts/validate-commands.mjs` in the same change — CI's Command Contract job fails otherwise |

---

## Per-package validation checklist

Each row is: the command(s) that constitute "done" for a change scoped to
that package, and — critically — what that green run does **not** cover.

### `contracts/` (Solidity)

```bash
pnpm --filter @wafflefinance/contracts exec hardhat test
cd contracts && forge test              # Foundry fuzz/invariant tests
pnpm --filter @wafflefinance/contracts coverage
```

Does not cover: whether the SDK's `EthereumHTLCClient` still matches your
ABI changes (check `packages/sdk/test/htlc-client.test.ts`), or gas-cost
regressions unless you also run `contracts/test/gas-regression.test.ts` (see
[`GAS_REGRESSION_GUIDE.md`](../GAS_REGRESSION_GUIDE.md)).

### `soroban/` (Rust)

```bash
cd soroban && cargo test
stellar contract build      # confirms it still compiles to wasm
```

Does not cover: the SDK's generated TypeScript bindings — if you changed a
contract entrypoint's signature, regenerate bindings
(`stellar contract bindings typescript`) and rebuild the SDK, or the
frontend/coordinator will type-check against a stale interface.

### `packages/sdk/`

```bash
pnpm --filter @wafflefinance/sdk build   # must succeed before anything downstream
pnpm --filter @wafflefinance/sdk test
```

Does not cover: whether frontend or e2e still build against your change —
both import SDK *source* directly (see their Vite/vitest aliases), so a
type error here surfaces there, not in the SDK's own suite. Run
`pnpm --filter @wafflefinance/frontend build` or `pnpm test:e2e` after any
SDK type change.

### `coordinator/`

```bash
pnpm --filter @wafflefinance/coordinator test
TEST_WITH_POSTGRES=true pnpm --filter @wafflefinance/coordinator test  # if you touched persistence/
```

Does not cover: RPC-level failure handling for the relayer or resolver
(each has its own listener and retry implementation), or a live check that
`/readyz` degrades correctly under a real degraded RPC — see
`coordinator/test/rpc-degradation.test.ts` for the injectable-fetcher
pattern used to simulate that deterministically.

### `relayer/`

```bash
pnpm --filter @wafflefinance/relayer test
```

Does not cover: the coordinator's view of the same order — the relayer and
coordinator each maintain independent state about a swap. If your change
affects when/how the relayer reports an order's status, cross-check
`coordinator/src/services/order-service.ts` for divergent assumptions.

### `resolver/`

```bash
pnpm --filter @wafflefinance/resolver test
```

Does not cover: end-to-end settlement — the resolver has no order store, so
its tests only prove listener/telemetry behavior in isolation. Anything
touching how the resolver hands events to the coordinator should also be
exercised via `e2e/`.

### `frontend/`

```bash
pnpm --filter @wafflefinance/frontend test
pnpm --filter @wafflefinance/frontend lint   # --max-warnings 0, strictest in the repo
pnpm --filter @wafflefinance/frontend build  # tsc && vite build — the real production bundle
```

Does not cover: real wallet extensions or a live coordinator — component
tests run under jsdom with mocked hooks. There is no browser/E2E UI layer in
this repo (no Playwright/Cypress); `build` + `preview` is the closest thing
to a UI smoke test.

### `e2e/`

```bash
pnpm test:e2e
```

Covers: cross-chain hashlock/preimage semantics and stuck-order refund
sequencing, purely in-process against SDK logic and chain simulators.
Does not cover: anything involving a real RPC endpoint, a running
coordinator, or timing/network behavior — see the RPC-degradation test
matrix (`*/test/rpc-degradation.test.ts` per service) for that.

### Repo-wide

```bash
pnpm validate:commands     # CI-enforced — package.json scripts match docs/COMMANDS.md
pnpm validate:manifests    # package names/versions/export paths resolve
pnpm validate:deps         # shared-dependency version alignment (viem, stellar-sdk, etc.)
pnpm build && pnpm test    # full monorepo build + test fan-out
```

`pnpm validate:manifests` needs the SDK built first
(`pnpm --filter @wafflefinance/sdk build`) since it resolves `exports` paths
against built output.

---

## Cross-package coupling you can't see from one package

These are the specific ways a change that looks locally correct can still
break the repo's cross-package contract. Each is invisible to the "owning"
package's own test suite:

- **The order state machine is implemented twice.** `packages/sdk/src/state-machine/`
  and `coordinator/src/state-machine/order-machine.ts` encode the same
  lifecycle independently. A transition added to one without the other
  desyncs the coordinator's authoritative state from what the SDK-driven
  frontend/relayer expect.
- **Three independent retry modules.** `coordinator/src/retry.ts`,
  `relayer/src/utils/retry-policy.ts`, and `resolver/src/retry.ts` have
  near-identical but *not identical* APIs and defaults. Don't assume a fix
  to one applies to the others.
- **Three independent readiness implementations, one documented contract.**
  Coordinator and relayer live-probe RPC endpoints in `/readyz`; resolver's
  `/readyz` is config-presence-only (no live RPC calls) — its actual
  degradation signal is the separate `/telemetry` endpoint. If you're
  building anything that depends on "the service reports degraded
  correctly," check which of these three shapes actually applies — see
  [`HEALTH_DASHBOARD.md`](./HEALTH_DASHBOARD.md).
- **The frontend and e2e suite consume SDK source, not a built package.**
  Both alias `@wafflefinance/sdk` straight to `packages/sdk/src/*.ts` (see
  `frontend/vite.config.ts`, `e2e/vitest.config.ts`). A change that breaks
  `pnpm --filter @wafflefinance/sdk build` doesn't necessarily break these —
  but a change that's fine for `tsc` and breaks at the *source* level (e.g.
  an internal-only import that isn't part of the SDK's `exports` map) can
  break them without ever failing the SDK's own build.
- **Deployment addresses are duplicated in three places.** A redeploy needs
  `deployments.<network>.json`, `README.md`'s deployed-contracts table, and
  whatever `.env` values the coordinator/relayer read — `pnpm
  validate:deployments` checks the first two are consistent, but doesn't run
  in CI today (see [`docs/QUALITY_GATE.md`](./QUALITY_GATE.md)).

---

## CI vs local — what a green PR actually proves

CI runs only a subset of the repo's checks. Before opening a PR, understand
which checks are automated and which are local-only.

**Runs on every push and every PR (no path filter):**

| Check | Command |
|---|---|
| Command contract | `pnpm validate:commands` → [`command-contract.yml`](../.github/workflows/command-contract.yml) |

**Runs only when the matching paths are touched:**

| Check | Trigger paths | Command |
|---|---|---|
| Foundry fuzz + invariant tests | `contracts/**` | `cd contracts && forge test` → [`foundry-contracts.yml`](../.github/workflows/foundry-contracts.yml) |
| Soroban cargo test | `soroban/**` | `cd soroban && cargo test` → [`soroban-contracts.yml`](../.github/workflows/soroban-contracts.yml) |
| Frontend Vitest + type-check + lint | `frontend/**`, `packages/sdk/**`, `packages/config/**` | `pnpm --filter @wafflefinance/frontend test` → [`frontend.yml`](../.github/workflows/frontend.yml) |
| Dependency CVE + licence scan | `pnpm-lock.yaml`, any `package.json` | GitHub action → [`dep-review.yml`](../.github/workflows/dep-review.yml) |
| Cross-package dep-version alignment | same as above | `pnpm validate:deps` → [`dep-review.yml`](../.github/workflows/dep-review.yml) |

**Local only — no CI job, must run manually before opening a PR:**

| Check | Command |
|---|---|
| Coordinator tests | `pnpm --filter @wafflefinance/coordinator test` |
| Relayer tests | `pnpm --filter @wafflefinance/relayer test` |
| Resolver tests | `pnpm --filter @wafflefinance/resolver test` |
| SDK build + tests | `pnpm --filter @wafflefinance/sdk build && pnpm --filter @wafflefinance/sdk test` |
| Hardhat contract tests (Node driver) | `pnpm --filter @wafflefinance/contracts test` |
| Deployment manifest validation | `pnpm validate:deployments` |
| Doc-drift + stale links | `pnpm validate:docs` |
| Release verification | `scripts/verify-release-locally.sh` |
| E2E cross-chain suite | `pnpm test:e2e` |

A PR that only touches `coordinator/` or `relayer/` will receive **no
automatic test coverage** — those packages have no dedicated CI job. Always
run their test suites locally before opening the PR.

See [`docs/COMMANDS.md`](./COMMANDS.md) for the full command reference and
the canonical CI vs local table.

---

## Before you open a PR

1. Run the validation checklist for every package you touched, not just the
   one you meant to change — `git diff --stat` against `main` to see the
   real footprint.
2. If you touched anything in the coupling list above, run the *other* side
   of that coupling explicitly (e.g. changed the SDK state machine → also
   run the coordinator's suite).
3. If you added or renamed a `package.json` script, update
   `docs/COMMANDS.md` and `scripts/validate-commands.mjs` together — CI's
   Command Contract job checks this on every PR.
4. If you're not sure whether a doc needs updating alongside your code
   change, check the contributor contract table in
   [`docs/QUALITY_GATE.md`](./QUALITY_GATE.md) — it lists exactly which docs
   go stale for which kinds of changes.
5. For anything touching release artifacts (contract addresses, package
   versions, Docker images), see
   [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) before merging.
