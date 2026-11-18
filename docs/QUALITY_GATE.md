# Quality Gate: Code / Docs / Config Synchronization

This document defines the repo-wide quality gate for keeping runtime configuration,
source code, and documentation in sync. It is the contract referenced by
[docs/DEVELOPMENT.md](DEVELOPMENT.md), [docs/OPERATIONS.md](OPERATIONS.md), and
[RELEASE_POLICY.md](../RELEASE_POLICY.md) whenever those documents say "keep this
in sync with the code."

## Why this exists

WaffleFinance is a multi-service, multi-chain bridge (`coordinator`, `relayer`,
`resolver`, `frontend`, `packages/sdk`, `contracts`, `soroban`). A change in one
package routinely invalidates an assumption documented elsewhere — an env var
gets renamed in code but not in `env.example`, a metric gets renamed in the
coordinator but not in `coordinator/ops/RUNBOOK.md`, or a doc keeps referencing a
CI workflow file that was never committed. None of these are caught by `pnpm test`
or `pnpm build`, because they are not code bugs — they are **contract drift**
between three surfaces that are edited independently:

1. **Code** — what environment variables are actually read, which HTTP routes and
   metrics actually exist, which npm scripts actually exist.
2. **Runtime configuration** — `env.example`, `deployments.testnet.json`,
   `coordinator/ops/prometheus.yml`, `coordinator/ops/coordinator-alerts.yml`,
   `coordinator/ops/docker-compose.yml`.
3. **Docs** — everything in `docs/`, `coordinator/docs/`, `coordinator/ops/`,
   `.github/*.md`, and the package `README.md` files that describes operational
   or configuration behavior.

## Audit updates since initial audit

### 2026-09-24 — documentation hygiene pass

The following items from the initial audit were closed or partially closed
during this pass:

- **Finding #2 (phantom workflow files):** All docs that referenced
  `.github/workflows/release.yml`, `ci.yml`, and `contracts.yml` have been
  updated with ARCHIVAL NOTICE blocks. `RELEASE_POLICY.md`, `.github/RELEASE_CHECKLIST.md`,
  and `.github/RELEASE_QUICK_REFERENCE.md` now accurately describe the 4 real
  workflows. See [docs/DOC_MAP.md](DOC_MAP.md) for the complete doc status map.

- **TD-000 (Solana activation):** Marked ✅ RESOLVED in `docs/TECHNICAL_DEBT.md`
  as of 2026-07-30. The Solana Anchor HTLC program is deployed on devnet;
  simulation mode is retained as fallback only.

- **TD-071 (mainnet frontend flows untested):** Closed by `.github/workflows/frontend.yml`,
  which now runs a two-leg matrix — `testnet-only` and `mainnet-enabled` —
  on every push and PR touching the frontend, SDK, or config packages. Both
  legs must be green to merge.

- **Check #3 (doc-to-file links resolve)** and **Check #6 (npm script references
  in docs):** A `scripts/check-docs-drift.mjs` validator has been implemented
  and wired into `pnpm validate:docs`. See [Status](#status) below.

## Known drift found during the initial audit (2026-07-26)

Running the checks below by hand against the current `main` branch surfaced real,
already-shipped drift. These are the seed backlog for whoever implements the
automated gate (see [Status](#status) below) — fixing them is a good first PR to
validate the gate's design.

### 1. Env vars read in code but missing from `env.example`

`grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]*"` across `coordinator/src`,
`relayer/src`, `resolver/src`, and `packages/sdk/src`, compared against every
`KEY=` line in `env.example`, found **16 variables** referenced in backend code
with no corresponding line in `env.example`:

```
COORDINATOR_API_KEYS
COORDINATOR_TRUSTED_PROXIES
ETHEREUM_RPC_URL
RELAYER_ETH_ADDRESS
RELAYER_PRIVATE_KEY
RELAYER_STELLAR_PUBLIC
RELAYER_STELLAR_SECRET
RELAYER_STELLAR_SECRET_MAINNET
RELAYER_STELLAR_SECRET_TESTNET
RESOLVER_HEALTH_PORT
RESOLVER_METRICS_PORT
SOLANA_HTLC_PROGRAM
SOLANA_HTLC_PROGRAM_MAINNET
SOLANA_HTLC_PROGRAM_TESTNET
SOLANA_RPC_URL
STELLAR_HORIZON_URL_TESTNET
```

Plus one frontend variable read via `import.meta.env` with no `env.example` entry:

```
VITE_ENABLE_MOCK_DATA
```

A new operator copying `env.example` to `.env` has no way to discover these
exist short of reading source. Some are load-bearing for readiness (e.g.
`ETHEREUM_RPC_URL` gates the relayer's `/readyz` `ethereum_rpc` check — see
[relayer/src/routes/health.ts](../relayer/src/routes/health.ts)).

### 2. Docs reference CI workflow files that do not exist in the repo

`.github/RELEASE_PROCESS.md`, `.github/RELEASE_QUICK_REFERENCE.md`,
`.github/RELEASE_ENHANCEMENTS.md`, `docs/DEPENDENCY_UPDATES.md`,
`docs/TECHNICAL_DEBT.md`, `CHANGES.md`, and `RELEASE_IMPROVEMENTS_SUMMARY.md` all
describe or link to `.github/workflows/release.yml`, `.github/workflows/ci.yml`,
and `.github/workflows/contracts.yml` as the mechanism that runs release
verification, contract compilation checks, and tests on every push/tag. **There
is no `.github/workflows/` directory in this repository.** Whatever ran those
checks historically either lived outside this repo or was removed without the
docs being updated. Today, `pnpm validate`, `pnpm test`, and
`scripts/verify-release-locally.sh` only run when a human invokes them locally —
nothing enforces them automatically on push or tag.

This is exactly the class of failure this gate exists to catch: a doc describing
operational/CI behavior that silently stopped being true.

### 3. Coordinator port documented inconsistently with its actual default

`coordinator/ops/RUNBOOK.md`, `coordinator/ops/README.md`, and
`coordinator/ops/QUICK_REFERENCE.md` all hardcode **port 3000** for the
coordinator's `/health` and `/metrics` endpoints (`curl
http://coordinator:3000/metrics`, Prometheus `targets: ["coordinator:3000"]`,
etc.). The actual default, set in
[packages/config/src/node.ts](../packages/config/src/node.ts) (`port:
rawEnv.COORDINATOR_PORT ?? rawEnv.RELAYER_PORT ?? "3001"`) and confirmed by
`env.example` (`COORDINATOR_PORT=3001`) and `docs/OPERATIONS.md`
(`COORDINATOR_URL=${COORDINATOR_URL:-http://localhost:3001}`), is **3001**. An
operator following the ops runbook literally would scrape or curl the wrong
port unless they happen to override `COORDINATOR_PORT=3000` in their
environment. This is check #5 (health/readiness endpoint sync) in the table
below, applied to the port number rather than the route path.

## Alignment checks (minimum enforceable set)

These are the checks identified as worth enforcing automatically, based on the
audit above. Each maps to a concrete, scriptable comparison — no fuzzy judgment
calls.

| # | Check | Source of truth | Target | Catches |
|---|---|---|---|---|
| 1 | Env var coverage | `process.env.X` / `import.meta.env.VITE_X` references in `coordinator/src`, `relayer/src`, `resolver/src`, `packages/sdk/src`, `frontend/src` | `env.example` | A var read by code but undocumented (or renamed on one side only) |
| 2 | Env var staleness | `env.example` keys | code references | A var documented but no longer read anywhere (dead config) |
| 3 | Doc-to-file links resolve | Relative markdown links (`[text](path)`) in every `*.md` file | filesystem | Docs pointing at scripts, workflow files, or other docs that don't exist (see Finding 2 above) |
| 4 | Metric name sync | Metric names registered in `coordinator/src` (via `prom-client`) | Metric names documented in `coordinator/ops/README.md`, `coordinator/ops/RUNBOOK.md`, `coordinator/ops/coordinator-alerts.yml` | A metric renamed in code but stale in the runbook/alert rules (alerts silently stop firing) |
| 5 | Health/readiness endpoint sync | Routes mounted in `coordinator/src/server/routes/health.ts`, `relayer/src/routes/health.ts`, `resolver/src/health.ts` | Endpoints described in `docs/HEALTH_DASHBOARD.md` and `docs/OPERATIONS.md` | A `/readyz` check added/removed in code without the doc's dependency table being updated |
| 6 | npm script references | Commands referenced in `*.md` as `pnpm ...` / `npm run ...` | Actual `scripts` in `package.json`, `coordinator/package.json`, `relayer/package.json`, `resolver/package.json`, `frontend/package.json`, `packages/sdk/package.json` | A doc telling a contributor to run a script that was renamed or removed |
| 7 | Package version sync | `package.json` version at each workspace root | The set the [RELEASE_POLICY.md](../RELEASE_POLICY.md) "Version Synchronization" policy says must move together | A publish where SDK/frontend/contracts versions have drifted apart, contradicting the documented policy |
| 8 | Deployment artifact sync | `deployments.testnet.json` contract addresses | Addresses referenced in `env.example` (`ETH_HTLC_ESCROW_TESTNET`, `SOROBAN_HTLC_TESTNET`, etc.) and `docs/OPERATIONS.md` | A redeploy that updates the artifact file but not the env var docs operators copy from |

Checks 1, 2, 3, 6, and 8 are pure static analysis (no live services needed) and
are the cheapest to implement first. Checks 4 and 5 require either parsing the
`prom-client` registrations or importing the route modules directly.

## Where this plugs into the existing workflow

The repo already has a `pnpm validate` entry point
([package.json](../package.json)) that runs:

- `validate:manifests` → `scripts/validate-workspace.mjs` (package.json version/export sync)
- `validate:deps` → `scripts/check-dep-versions.mjs` (dependency hygiene, per [docs/DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md))

`validate:deployments` → `scripts/validate-deployments.mjs` also exists but is
not wired into `pnpm validate`.

The intended integration point for this gate is a new `validate:docs` script
(`scripts/check-docs-drift.mjs`) added alongside the others:

```jsonc
// package.json (current shape — validate:docs is now implemented)
"scripts": {
  "validate:docs": "node scripts/check-docs-drift.mjs",
  "validate": "pnpm validate:manifests && pnpm validate:deps && pnpm validate:docs"
}
```

Because there is currently no `.github/workflows/` directory (see Finding 2),
`pnpm validate` does not run automatically anywhere today — it must be run by
hand before merging or tagging a release, the same way
`scripts/verify-release-locally.sh` is. Wiring `pnpm validate` (and by
extension this gate) into an actual CI workflow is a prerequisite for the
"catches drift before merges" acceptance bar and is tracked as follow-up work
alongside the gate's implementation.

## Contributor contract

When you touch any of the following, update the paired surface in the same PR:

| If you change... | Also update... |
|---|---|
| A `process.env.X` / `import.meta.env.VITE_X` reference | `env.example` (add/remove/rename the line, with a comment if the var is optional) |
| A Prometheus metric name or label in `coordinator/src` | `coordinator/ops/README.md`, `coordinator/ops/RUNBOOK.md`, `coordinator/ops/coordinator-alerts.yml` |
| A health/readiness check (`/health`, `/healthz`, `/readyz`) in any service | `docs/HEALTH_DASHBOARD.md`, `docs/OPERATIONS.md` (Health Check Endpoints table) |
| A `package.json` script name | Every `*.md` file that tells a contributor to run it (`grep -rn "pnpm <old-name>"` before renaming) |
| A deployed contract address in `deployments.testnet.json` | `env.example` contract-address section and `docs/OPERATIONS.md` |
| A CI workflow file under `.github/workflows/` | The docs that describe it (`.github/RELEASE_PROCESS.md`, `.github/RELEASE_QUICK_REFERENCE.md`) — and vice versa: don't describe a workflow you haven't committed |

## Status

### Checks 3 and 6 — implemented (2026-09-24)

`scripts/check-docs-drift.mjs` now implements two of the eight checks from
the alignment table above:

- **Check 3 (doc-to-file links resolve):** Scans every `*.md` file in the
  repo for relative markdown links (`[text](path)`) and verifies each target
  exists on the filesystem. Fails if any link is broken.

- **Check 6 (npm script references in docs):** Scans every `*.md` file for
  `pnpm <script>`, `pnpm run <script>`, and `pnpm --filter <pkg> <script>`
  invocations and verifies each referenced script actually exists in the
  relevant `package.json`. Fails if a doc tells a contributor to run a script
  that has been renamed or removed.

The script runs via:

```bash
pnpm validate:docs
```

And is wired into `pnpm validate`:

```jsonc
// package.json (current shape)
"validate": "pnpm validate:manifests && pnpm validate:deps && pnpm validate:docs"
```

### Checks 1, 2, 4, 5, 7, 8 — not yet automated

The remaining checks (env var coverage/staleness, metric name sync,
health endpoint sync, package version sync, deployment artifact sync) are
not yet implemented as automated scripts. They remain in the backlog as the
natural next PRs after the initial documentation pass. Checks 1 and 2
(env var coverage) are the highest-priority next items given the 16 missing
`env.example` entries documented in Finding #1 above.

### CI wiring — still manual

There is still no `.github/workflows/` entry that runs `pnpm validate` (or
`pnpm validate:docs`) automatically on every push. Until a general CI workflow
is added, `pnpm validate:docs` must be run locally before merging or tagging.
This is the same constraint that applied to `pnpm validate` before this pass.
Wiring it into CI is the prerequisite for the "catches drift before merges"
acceptance bar.
