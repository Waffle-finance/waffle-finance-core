# Dependency updates

**Scope:** covers the rules and operating procedure for automated dependency-update pull requests in this repository. Closes #177.

## Goals

1. Keep dependencies current so we pick up bug fixes, performance improvements, and security patches without manual chore work.
2. Keep the review burden **predictable** — no PR floods, no surprise major bumps, no silent upgrades to security-critical packages.
3. Make failures and conflicts **visible** — every Renovate PR goes through the same CI as a human-authored PR; the dependency-dashboard issue exposes abandoned updates that need a nudge.

## Tooling choice

We run [**Renovate**](https://github.com/renovatebot/renovate) (the Mend Renovate GitHub App). It was selected over Dependabot because:

- Native `pnpm-lock.yaml` support keeps lockfile drift out of CI.
- `packageRules` lets us group dozens of dev deps into a single PR instead of 30.
- The **[Dependency Dashboard](https://docs.renovatebot.com/dependency-dashboard/)** is a single searchable issue we can act on per-update.
- Per-manager config (`npm`, `cargo`, `github-actions`) is contiguous in one file.
- Vulnerability alerts and OSV alerts are first-class.

The configuration lives at [`renovate.json5`](../renovate.json5) at the repository root. The file is JSON5 so we can leave the rationale inline as comments.

Renovate is **not** enabled to auto-merge any PR — every update is reviewed by a human and validated by the existing CI.

## What Renovate watches

| Manager | What it tracks | Grouping |
|---|---|---|
| `npm` (pnpm workspace) | Application dependencies in `contracts/`, `coordinator/`, `relayer/`, `resolver/`, `frontend/`, `packages/sdk/`, `packages/config/`, `e2e/` | Per package or per dep-type — see [Grouping rules](#grouping-rules) |
| `cargo` | Every `Cargo.toml` under `soroban/` (workspace root + per-crate) | One weekly PR |
| `github-actions` | `uses:` pins in `.github/workflows/*.yml` | One weekly PR |
| Lockfiles | `pnpm-lock.yaml`, `Cargo.lock` | Weekly lockfile-maintenance PR |

## Grouping rules

The schedule is `before 6am on Monday (UTC)` for every non-security update. On a typical Monday we expect to see roughly:

| PR | Scope | Why it is grouped |
|---|---|---|
| `Lockfile Maintenance (Weekly)` | Lockfile churn from intermediate versions | Keeps `main` deterministic even when no deps changed |
| `Solidity Toolchain (Weekly)` | Hardhat, foundry, solhint, typechain, OZ-deps *not* in the pinned list | Touches bytecode; PR **does not open** until a maintainer approves it in the dependency dashboard |
| `Soroban Rust Dependencies (Weekly)` | Crate updates for Soroban SDK + helpers | Touches WASM bytecode; PR **does not open** until a maintainer approves it in the dependency dashboard |
| `SDK Runtime (Weekly)` | Direct deps of `@wafflefinance/sdk` | SDK is consumed by 4 other services |
| `Service Runtime (Weekly)` | Coordinator / relayer / resolver runtime deps | Smaller blast radius — group is still small |
| `Frontend Runtime (Weekly)` | Frontend-only runtime deps | Lets UI owners review one PR |
| `DevDependencies (Weekly)` | **All** devDependencies across the workspace | Largest noise reduction — one PR per week instead of ~30 |
| `GitHub Actions (Weekly)` | `actions/checkout@vN` and similar | One diff to scan |
| `Major` | Anything that bumps a major version | **Standalone** PR with `breaking` label — never grouped |

### Pinned / isolated deps

These are not eligible for automated updates and must be bumped by hand:

| Package | Why it is pinned | Where to bump |
|---|---|---|
| `@openzeppelin/contracts` (and all sub-packages) | Every major release has shipped storage-layout changes; current audits cover **v5.x**. Bumping requires re-audit. | `contracts/package.json` + a new audit cycle |

If you need to *remove* a pin (for example, to adopt a security fix in a future OpenZeppelin major), update the `matchPackagePatterns` list at the top of `packageRules` in `renovate.json5`, then open a PR that explains the change. The PR is a code-reviewed signal — it will not be auto-merged.

## Security alerts (out of band)

Renovate's `vulnerabilityAlerts` and `osvVulnerabilityAlerts` blocks are configured to **bypass** the weekly schedule:

- They open PRs immediately, any day, any time.
- They are **never grouped** with other updates — each CVE is its own PR with a `security` label and PR priority 10.
- They bypass lockfile-maintenance so a fix lands without waiting on Monday.

Reviewer for a security PR: the same person who reviews the package it touches (see the table above). If it touches a pinned dependency, treat it as a manual upgrade and follow the pin's procedure.

## What CI runs on every Renovate PR

Every Renovate PR goes through the existing [`ci.yml`](../.github/workflows/ci.yml) and, when relevant, [`contracts.yml`](../.github/workflows/contracts.yml):

- TypeScript build + tests across all packages
- Hardhat compile + Hardhat tests (`HTLCEscrow`, `ResolverRegistry`)
- Foundry fuzz + invariant tests (`contracts/test/foundry/*`)
- Slither static analysis on v2 contracts
- Soroban `cargo build` (workspace)
- Manifest validation (`pnpm run validate:manifests`)
- Deployment-artifact validation (`pnpm run validate:deployments`)

A Renovate PR is mergeable only when **all** of the above are green. There is no fast lane for Renovate.

## Monitoring the dependency dashboard

Renovate creates (and keeps open) an issue called **"Renovate Dependency Dashboard"**. It lists every package that has:

- an open PR,
- a PR closed/abandoned and pending retry,
- an update that has been rate-limited.

Use it as the first place to look when an update is missing. The dashboard accepts checkbox commands (`<dependency>`, `<branch>`, `<repo>`) that re-order, retry, or pause updates without editing `renovate.json5`.

## How to pause or adjust the workflow

Three escape hatches, in order of granularity:

### 1. Pause a single update (most common)

In the dependency-dashboard issue, check the box next to the package. Renovate stops trying to update it until you uncheck the box. Use this when:

- An upstream version is broken or incompatible.
- A package is deprecated and you are mid-migration.
- You need to gate the upgrade behind a manual code change.

### 2. Pause all updates globally (incident response)

Set `"enabled": false` at the root of `renovate.json5` and merge the change. Renovate creates no new PRs but still updates the dashboard. Useful when there is an unrelated incident and you do not want Renovate noise on `main`.

To resume: revert the `enabled` flag.

### 3. Adjust scopes without code changes

For deeper adjustments (different schedule, new groups, new pinned dep), edit `renovate.json5` and open a PR. The change itself is a code-reviewed signal. Common triggers:

- Adoption of a new package manager → add it to the top-level `matchManagers` rule or a new `packageRules` entry.
- New sensitive package directory → add a `matchFileNames` rule with a `groupName` and explanatory `description`.
- Quarantine of a misbehaving package → add a `packageRules` entry with `matchPackagePatterns` and `enabled: false` (the same pattern we use for `@openzeppelin/contracts` at the top of the file).

## What this workflow does **not** do

- It does not auto-merge anything.
- It does not bypass CI.
- It does not bypass code review — every Renovate PR is reviewed by a human with package context.
- It does not replace the discipline required to review changes to the packages that move user funds.

## Acceptance criteria (issue #177)

| Criterion | Where this is satisfied |
|---|---|
| Dependency updates are easier to manage | Daily/weekly grouping + dependency dashboard |
| Review remains practical | Per-package / per-dep-type groups + `prConcurrentLimit: 5` |
| The workflow does not introduce excessive noise | Lockfile + DevDependencies grouping + weekly cadence |
| Failures or conflicts are visible | Renovate dashboard + standard CI + rebase label |
| Workflow can be paused or adjusted for sensitive packages | Per-update dashboard toggles, `enabled: false`, pinned package list (see `packageRules` block in `renovate.json5`) |

## Followups not in scope

- Pinning Renovate's own app version (managed by Mend, not in this repo).
- Auto-merge for vetted low-risk groups after ≥ 90 days of clean Renovate CI history (revisit via a separate change).
- SBOM generation on every release (tracked under the release-workflow roadmap).
