# Documentation Map

> **Owner:** Engineering team  
> **Last audited:** 2026-09-25  
> **Purpose:** Single index of every documentation file in the repository.
> Use this to find the canonical reference for any topic and to understand
> which docs are actively maintained versus archived.

Every document in this map has:
- **Status** — `current` (actively maintained, reflects the live codebase) or
  `archival` (preserved for history but may not reflect current reality — read
  the note in the file itself before acting on it).
- **Owner** — the team or role responsible for keeping it accurate.
- **Subject** — one-line scope statement so you know whether to read it.

If you add a new document, add a row here in the same PR.

---

## Root-level docs

| File | Status | Owner | Subject |
|------|--------|-------|---------|
| `README.md` | current | Engineering | Project overview, prerequisites, quick-start |
| `RELEASE_POLICY.md` | current | Engineering | SemVer policy, publish mechanics, pre-release checklist |
| `CHANGES.md` | **archival** | — | Historical change log describing the June 2026 release-workflow enhancement. The `.github/workflows/release.yml` it documents does not exist. See note at top of file. |
| `RELEASE_IMPROVEMENTS_SUMMARY.md` | **archival** | — | Summary of the same phantom release-workflow work. See note at top of file. |
| `GAS_REGRESSION_GUIDE.md` | **archival** | — | Implementation guide for the gas regression harness written at initial creation. The test file described (`contracts/test/gas-regression.test.ts`) is the live reference; this guide is a one-time setup record. |

---

## `docs/` — shared engineering docs

| File | Status | Owner | Subject |
|------|--------|-------|---------|
| `docs/DOC_MAP.md` | current | Engineering | **This file** — canonical index of all documentation |
| `docs/ARCHITECTURE.md` | current | Engineering | System architecture: package topology, chain integrations, order lifecycle, runtime assumptions, event replay, service restart behavior, cross-chain invariants, degraded network behavior |
| `docs/DEBUGGING_GUIDE.md` | current | Engineering | **Incident triage guide** — per-service debugging paths, diagnostic matrix for network failure, DB drift, and stuck orders; log and telemetry reference |
| `docs/TECHNICAL_DEBT_MAINTENANCE.md` | current | Engineering | **Debt maintenance strategy** — triage rubric, category definitions, priority model, sprint integration, and full mapping of existing TD items |
| `docs/RELEASE_AUTHORITY_MAP.md` | current | Engineering | **Release doc authority map** — canonical source per release topic, document inventory, resolved contradictions, cross-reference rules |
| `docs/COMMANDS.md` | current | Engineering | **Canonical command map** — which command belongs to which package and what it validates; CI-enforced |
| `docs/QUALITY_GATE.md` | current | Engineering | Repo-wide quality gate spec: alignment checks, known drift, contributor contract |
| `docs/TECHNICAL_DEBT.md` | current | Engineering | Technical debt register (TD-000 through TD-080) with severity ratings |
| `docs/RELEASE_CONTRACT.md` | current | Engineering | Per-package build target, artifact, environment assumptions, and verification gaps |
| `docs/DEVELOPMENT.md` | current | Engineering | Local development setup, env vars, troubleshooting |
| `docs/OPERATIONS.md` | current | Operations | Production operations: deployment topology, health endpoints, runbook pointers |
| `docs/HEALTH_DASHBOARD.md` | current | Operations | Health and readiness endpoint reference for all services |
| `docs/CONTRIBUTOR_HANDBOOK.md` | current | Engineering | Contribution guidelines, code review norms, branch strategy |
| `docs/DEPENDENCY_POLICY.md` | current | Engineering | Dependency pinning policy, upgrade procedure, audit-critical packages |
| `docs/DEPENDENCY_UPDATES.md` | current | Engineering | Process for routine dependency updates and major-upgrade checklist |
| `docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md` | current | Operations | Step-by-step rollback procedures for each service |
| `docs/SMOKE_TEST_CONTRACT.md` | current | Engineering | Smoke-test definitions and acceptance criteria per service |
| `docs/FEATURE_FLAGS.md` | current | Engineering | Feature flag registry and lifecycle policy |
| `docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md` | current | Engineering | **Multi-package release gate** — cross-package impact matrix and checklist |
| `docs/ORDER_IDS.md` | current | Engineering | Order ID format, generation, and uniqueness guarantees |
| `docs/BUG_TRIAGE.md` | current | Engineering | Bug severity definitions and triage workflow |
| `docs/PERFORMANCE_BASELINE.md` | current | Engineering | Latency and throughput baselines per service |
| `docs/RPC_DEGRADATION_TEST_MATRIX.md` | current | Engineering | RPC failure modes and expected service behaviour |
| `docs/postmortem/` | current | Engineering | Post-mortem reports; each file is a permanent record of a specific incident |

---

## `.github/` — process and workflow docs

| File | Status | Owner | Subject |
|------|--------|-------|---------|
| `.github/PULL_REQUEST_TEMPLATE.md` | current | Engineering | PR checklist template |
| `.github/RELEASE_CHECKLIST.md` | current | Engineering | Release checklist (pre/during/post); **references the 4 real CI workflows** |
| `.github/RELEASE_PROCESS.md` | **archival** | — | Detailed description of a `release.yml` CI workflow that does not exist. Preserved for design reference. See note at top of file. |
| `.github/RELEASE_QUICK_REFERENCE.md` | **archival** | — | Quick reference for the same phantom `release.yml`. See note at top of file. |
| `.github/RELEASE_ENHANCEMENTS.md` | **archival** | — | Implementation summary for the same phantom `release.yml`. See note at top of file. |

---

## `.github/workflows/` — CI/CD (the only 4 that exist)

| File | Triggers | What it does |
|------|----------|--------------|
| `command-contract.yml` | push to main, all PRs | Runs `node scripts/validate-commands.mjs` — enforces `docs/COMMANDS.md` |
| `dep-review.yml` | PRs touching `pnpm-lock.yaml` or `package.json` | CVE/licence scan, dep-version alignment, critical-deps labelling |
| `frontend.yml` | push/PR touching `frontend/`, `packages/sdk/`, `packages/config/` | Vitest (testnet + mainnet matrix), TypeScript typecheck, ESLint |
| `soroban-contracts.yml` | push/PR touching `soroban/` | `cargo test` — unit, state-machine harness, property fuzz |

> **There is no `release.yml`, `ci.yml`, or `contracts.yml`.** Several archival
> docs describe these as if they exist. Do not follow instructions in those docs
> that reference those workflow files. The real release gate is
> `scripts/verify-release-locally.sh` run manually before tagging, plus the
> four workflows above running on every push/PR.

---

## Package-level docs

| Location | Status | Owner | Subject |
|----------|--------|-------|---------|
| `contracts/README.md` | current | Engineering | EVM contracts: build, test, deploy |
| `contracts/docs/mainnet-deployment-checklist.md` | current | Engineering | Pre-mainnet deployment checklist for EVM contracts |
| `coordinator/docs/` | current | Engineering | Coordinator internals: event reconciliation, migrations, API |
| `coordinator/ops/` | current | Operations | Ops runbook, Prometheus config, alert rules — **note: port 3001, not 3000** (see `docs/QUALITY_GATE.md` Finding #3) |
| `coordinator/TODO.md` | current | Engineering | Coordinator-specific open items |
| `relayer/README.md` | current | Engineering | Relayer setup, env vars, architecture notes |
| `resolver/docs/` | current | Engineering | Resolver internals and configuration |
| `packages/sdk/README.md` | current | Engineering | SDK usage, subpath exports, build |
| `packages/sdk/ASSET_MAPPING_CONTRACT.md` | current | Engineering | Asset mapping contract between SDK and chain clients |
| `packages/sdk/ROUTE_REGISTRY.md` | current | Engineering | Route registry spec |
| `packages/sdk/TREE_SHAKING.md` | current | Engineering | SDK bundle size and tree-shaking guidance |
| `soroban/README.md` | current | Engineering | Soroban contracts: build, test, deploy, TS bindings |
| `soroban/docs/` | current | Engineering | Soroban-specific design docs |
| `docs/SOROBAN_OPERATOR_GUIDE.md` | current | Operations | Soroban trust model, lifecycle, readiness checks, RPC degradation, recovery |
| `frontend/CACHING_STRATEGY.md` | current | Engineering | Frontend caching approach |
| `frontend/FEATURE_FLAGS.md` | current | Engineering | Frontend feature flag usage |
| `frontend/MAINTAINABILITY.md` | current | Engineering | Frontend code maintainability guidelines |
| `scripts/README.md` | current | Engineering | Verification scripts usage and prerequisites |
| `e2e/` (inline) | current | Engineering | E2E harness docs are inline in source comments |

---

## How to determine canonical reference for a topic

| Topic | Go to |
|-------|-------|
| Which `pnpm` command to run for a package | `docs/COMMANDS.md` |
| Release process, version bumps, publishing | `RELEASE_POLICY.md` + `docs/RELEASE_CONTRACT.md` |
| Which release doc is authoritative for a topic | `docs/RELEASE_AUTHORITY_MAP.md` |
| Cross-package release gate / impact matrix | `docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md` |
| Quality gate and doc drift checks | `docs/QUALITY_GATE.md` |
| Technical debt items (the register) | `docs/TECHNICAL_DEBT.md` |
| Technical debt triage, priority model, sprint planning | `docs/TECHNICAL_DEBT_MAINTENANCE.md` |
| System architecture, runtime assumptions, cross-chain invariants | `docs/ARCHITECTURE.md` |
| Debugging a failing service during an incident | `docs/DEBUGGING_GUIDE.md` |
| Local development setup | `docs/DEVELOPMENT.md` |
| Production operations | `docs/OPERATIONS.md` |
| Health endpoints | `docs/HEALTH_DASHBOARD.md` |
| Dependency upgrade policy | `docs/DEPENDENCY_POLICY.md` |
| All CI workflows that actually run | This file — `.github/workflows/` table above |

---

## Adding a new document

1. Create the file.
2. Add a front-matter block at the top (or a `<!-- owner: ... -->` HTML comment
   at minimum) identifying the owner and subject in one line.
3. Add a row to the appropriate table in this file in the same PR.
4. If the document describes behaviour that the quality gate should enforce
   (new env vars, new commands, new health endpoints), update
   `docs/QUALITY_GATE.md` in the same PR.

## Retiring a document

1. Add an `> **ARCHIVAL NOTICE**` block at the very top of the file explaining
   what is stale and where the current reference lives.
2. Change its row in this file from `current` to `archival`.
3. Do **not** delete it — git history and external links may depend on it.
