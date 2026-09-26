# Release Authority Map

> **Owner:** Engineering team  
> **Last updated:** 2026-09-25  
> **Purpose:** Single reference for which document owns each release topic.
> When docs conflict, this file determines which one is correct.

The repository has grown enough release-related documentation that contributors
routinely ask "which doc do I follow?" This map answers that question directly.
It also records which docs are authoritative, which are archival (preserved but
not current), and where contradictions have been intentionally resolved.

If you are touching any part of the release process, read the relevant row in
the authority table first. If you are adding a new release document, add a row
here in the same PR and mark the authority relationship explicitly.

---

## Table of Contents

- [How to read this map](#how-to-read-this-map)
- [Authority table by topic](#authority-table-by-topic)
- [Document inventory and status](#document-inventory-and-status)
- [Resolved contradictions](#resolved-contradictions)
- [Cross-reference rules](#cross-reference-rules)
- [Maintaining this map](#maintaining-this-map)

---

## How to read this map

Each row in the authority table has:

- **Topic** — what release question or activity the row covers.
- **Canonical document** — the one file you should follow. When in doubt, this
  file wins over all others on its topic.
- **Supporting documents** — files that provide additional depth, step-by-step
  detail, or package-specific expansion. They defer to the canonical document if
  they contradict it.
- **Archival / superseded** — files that previously covered this topic but are
  no longer authoritative. They carry `ARCHIVAL NOTICE` blocks. Do not follow
  their procedures.

---

## Authority table by topic

### Versioning and publish mechanics

| Topic | Canonical | Supporting | Archival |
|---|---|---|---|
| SemVer policy, when to bump MAJOR/MINOR/PATCH | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § Versioning Policy | — | — |
| Which packages are published where (npm / Vercel / Docker / private) | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § Publishing Packages | [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) per-package rows | — |
| Version synchronization — which packages must move together | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § Version Synchronization | [`docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md`](./RELEASE_CHECKLIST_MULTI_PACKAGE.md) Part 3 version table | — |
| npm publish command and token requirements | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § CI/CD Integration — Publish step | — | `.github/RELEASE_QUICK_REFERENCE.md` ⚠ archival |

---

### Build targets and artifact definitions

| Topic | Canonical | Supporting | Archival |
|---|---|---|---|
| Per-package build command, artifact location, and environment assumptions | [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) | [`docs/COMMANDS.md`](./COMMANDS.md) per-package contract tables | — |
| Which packages are covered by `verify-release-locally.sh` vs. not | [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) § Coverage gap | — | — |
| Soroban WASM build and deploy procedure | [`soroban/README.md`](../soroban/README.md) | [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) Soroban row | — |
| Docker image build for relayer and resolver | [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) relayer/resolver rows | [`relayer/README.md`](../relayer/README.md), [`resolver/README.md`](../resolver/README.md) | — |

---

### Pre-release verification and cross-package impact

| Topic | Canonical | Supporting | Archival |
|---|---|---|---|
| Cross-package impact matrix — which packages to verify per change type | [`docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md`](./RELEASE_CHECKLIST_MULTI_PACKAGE.md) Part 1 | — | — |
| Per-package verification steps before tagging | [`docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md`](./RELEASE_CHECKLIST_MULTI_PACKAGE.md) Part 2 | [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) | — |
| Risk scoring — how much review is required | [`docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md`](./RELEASE_CHECKLIST_MULTI_PACKAGE.md) Part 4 | — | — |
| Quality gate scripts (`validate:manifests`, `validate:deps`, `validate:docs`) | [`docs/QUALITY_GATE.md`](./QUALITY_GATE.md) § Where this plugs into the existing workflow | [`docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md`](./RELEASE_CHECKLIST_MULTI_PACKAGE.md) Part 3 | — |
| Local verification script (`verify-release-locally.sh` / `.ps1`) | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § Pre-Release Checklist step 5 | `.github/RELEASE_PROCESS.md` ⚠ archival | `.github/RELEASE_QUICK_REFERENCE.md` ⚠ archival |

---

### Operational release gate (step-by-step checklist)

| Topic | Canonical | Supporting | Archival |
|---|---|---|---|
| Step-by-step checklist: CI verification, local verification, tagging, post-release | [`.github/RELEASE_CHECKLIST.md`](../.github/RELEASE_CHECKLIST.md) | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § Release Process | `.github/RELEASE_PROCESS.md` ⚠ archival |
| Which CI workflows actually exist and what they check | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § CI/CD Integration | [`docs/DOC_MAP.md`](./DOC_MAP.md) § .github/workflows/ table | `.github/RELEASE_PROCESS.md` ⚠ archival, `.github/RELEASE_ENHANCEMENTS.md` ⚠ archival |

---

### Deployment and rollback

| Topic | Canonical | Supporting | Archival |
|---|---|---|---|
| Rollback-first deployment procedure for coordinator and relayer | [`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](./DEPLOYMENT_ROLLBACK_RUNBOOK.md) | [`docs/OPERATIONS.md`](./OPERATIONS.md) § Rollback Procedures | — |
| Contract deployment procedure (EVM) | [`contracts/README.md`](../contracts/README.md) | [`docs/OPERATIONS.md`](./OPERATIONS.md) § Deployment Checklist | — |
| Contract deployment procedure (Soroban) | [`soroban/README.md`](../soroban/README.md) | — | — |
| Post-deploy health verification | [`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](./DEPLOYMENT_ROLLBACK_RUNBOOK.md) § Post-deploy checks | [`docs/MAINTENANCE_CALENDAR.md`](./MAINTENANCE_CALENDAR.md) § D-01 | — |
| Pre-mainnet deployment checklist (EVM contracts) | [`contracts/docs/mainnet-deployment-checklist.md`](../contracts/docs/mainnet-deployment-checklist.md) | [`docs/OPERATIONS.md`](./OPERATIONS.md) | — |

---

### Release notes and change documentation

| Topic | Canonical | Supporting | Archival |
|---|---|---|---|
| How to write release notes, what categories to cover | [`docs/RELEASE_NOTES_PROCESS.md`](./RELEASE_NOTES_PROCESS.md) | — | — |
| Release notes fill-in template | [`.github/RELEASE_NOTES_TEMPLATE.md`](../.github/RELEASE_NOTES_TEMPLATE.md) | [`docs/RELEASE_NOTES_PROCESS.md`](./RELEASE_NOTES_PROCESS.md) | `CHANGES.md` ⚠ archival, `RELEASE_IMPROVEMENTS_SUMMARY.md` ⚠ archival |

---

### Commands, scripts, and toolchain

| Topic | Canonical | Supporting | Archival |
|---|---|---|---|
| Which `pnpm` command to run per package | [`docs/COMMANDS.md`](./COMMANDS.md) | — | — |
| Root aggregate commands and what they cover | [`docs/COMMANDS.md`](./COMMANDS.md) § Root aggregate commands | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § Pre-Release Checklist | — |

---

## Document inventory and status

Every release-related document in the repository, its current status, and its
designated authority scope.

### Authoritative and current

| Document | Owns | Last confirmed current |
|---|---|---|
| [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) | Versioning policy, publish mechanics, which CI workflows exist | 2026-09-24 |
| [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) | Per-package build targets, artifact definitions, coverage gaps in local verification | 2026-09-25 |
| [`docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md`](./RELEASE_CHECKLIST_MULTI_PACKAGE.md) | Cross-package impact matrix, per-package verification steps, risk scoring | 2026-09-25 |
| [`.github/RELEASE_CHECKLIST.md`](../.github/RELEASE_CHECKLIST.md) | Step-by-step operational release gate | 2026-09-24 |
| [`docs/RELEASE_NOTES_PROCESS.md`](./RELEASE_NOTES_PROCESS.md) | How to write and publish release notes | 2026-09-24 |
| [`.github/RELEASE_NOTES_TEMPLATE.md`](../.github/RELEASE_NOTES_TEMPLATE.md) | Release notes fill-in template | 2026-09-24 |
| [`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](./DEPLOYMENT_ROLLBACK_RUNBOOK.md) | Coordinator/relayer rollback procedure | 2026-09-24 |
| [`docs/COMMANDS.md`](./COMMANDS.md) | Canonical pnpm command map (CI-enforced) | 2026-09-24 |

### Archival — do not follow procedures

These files are preserved for history and reference but are not authoritative.
Each carries an `ARCHIVAL NOTICE` block at the top.

| Document | Why archival | Current reference instead |
|---|---|---|
| [`CHANGES.md`](../CHANGES.md) | Describes a `release.yml` CI workflow that does not exist. | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § CI/CD Integration |
| [`RELEASE_IMPROVEMENTS_SUMMARY.md`](../RELEASE_IMPROVEMENTS_SUMMARY.md) | Summary of the same phantom release workflow work. | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) |
| [`.github/RELEASE_PROCESS.md`](../.github/RELEASE_PROCESS.md) | Describes a `release.yml` workflow that does not exist; describes a `resolver-docker` CI job that does not run. | [`.github/RELEASE_CHECKLIST.md`](../.github/RELEASE_CHECKLIST.md) + [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md) |
| [`.github/RELEASE_QUICK_REFERENCE.md`](../.github/RELEASE_QUICK_REFERENCE.md) | Quick reference for the same phantom `release.yml`. | [`RELEASE_POLICY.md`](../RELEASE_POLICY.md) § Pre-Release Checklist |
| [`.github/RELEASE_ENHANCEMENTS.md`](../.github/RELEASE_ENHANCEMENTS.md) | Implementation summary for the phantom release workflow. | N/A — historical only |
| [`GAS_REGRESSION_GUIDE.md`](../GAS_REGRESSION_GUIDE.md) | One-time setup guide written at initial creation. The live reference is `contracts/test/gas-regression.test.ts`. | The test file itself |

---

## Resolved contradictions

The following contradictions between documents have been identified and resolved.
Each entry records what conflicted, which document was chosen as authoritative,
and what happened to the other document.

### Contradiction 1 — Phantom CI workflows

**What conflicted:** Five documents (`.github/RELEASE_PROCESS.md`,
`.github/RELEASE_QUICK_REFERENCE.md`, `.github/RELEASE_ENHANCEMENTS.md`,
`CHANGES.md`, `RELEASE_IMPROVEMENTS_SUMMARY.md`) described
`.github/workflows/release.yml`, `ci.yml`, and `contracts.yml` as if they
existed and ran automatically. No such workflows exist in the repository.

**Resolution:** `RELEASE_POLICY.md` is authoritative. It explicitly documents
the four real workflows (`command-contract.yml`, `dep-review.yml`,
`frontend.yml`, `soroban-contracts.yml`) and states there is no
`release.yml`. All five conflicting documents are now marked archival in
[`docs/DOC_MAP.md`](./DOC_MAP.md) with ARCHIVAL NOTICE blocks.

**Do not:** Follow any release procedure in the archival docs that depends on
pushing a git tag triggering automated publishing — no such automation exists.
Publishing is a manual step after local verification passes.

---

### Contradiction 2 — Coordinator port 3000 vs. 3001

**What conflicted:** `coordinator/ops/RUNBOOK.md`, `coordinator/ops/README.md`,
and `coordinator/ops/QUICK_REFERENCE.md` hardcoded port `3000` in curl commands,
Prometheus scrape targets, and Docker Compose service definitions. The actual
configured default is `3001` (set in `packages/config/src/node.ts`, confirmed by
`env.example` and `docs/OPERATIONS.md`).

**Resolution:** Port `3001` is correct. The ops runbook files use port 3000
because they were written before the port default was standardized. Until those
files are updated, treat `docs/OPERATIONS.md` and `docs/HEALTH_DASHBOARD.md`
as authoritative for all port references. When running the coordinator locally,
verify the actual port with:

```bash
echo "${COORDINATOR_PORT:-3001}"
```

**Tracked as:** Finding #3 in [`docs/QUALITY_GATE.md`](./QUALITY_GATE.md).

---

### Contradiction 3 — `verify-release-locally.sh` scope vs. reality

**What conflicted:** `.github/RELEASE_PROCESS.md` and `RELEASE_POLICY.md` (before
the 2026-09-24 update) implied that `verify-release-locally.sh` covered all packages.
`docs/RELEASE_CONTRACT.md` audited the script and found that the relayer has no
coverage at all, and the coordinator/resolver/frontend are typecheck-only (not
build + test).

**Resolution:** `docs/RELEASE_CONTRACT.md` § "Coverage gap" is authoritative on
what the script actually checks. The script is not a complete release verification
tool — it is a partial check. `docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md` Part 2
documents the full per-package verification steps that the script does not cover.
Running the script alone is not sufficient to confirm release readiness.

---

### Contradiction 4 — Soroban `Cargo.toml` repository URL

**What conflicted:** `soroban/Cargo.toml` sets
`repository = "https://github.com/karagozemin/wafflefinance"`, which points to a
different GitHub account than the rest of the repository's metadata
(`https://github.com/Waffle-finance/waffle-finance-core`).

**Resolution:** The Waffle-finance organization URL is correct. The `Cargo.toml`
value is a typo/legacy entry that should be corrected the next time `soroban/Cargo.toml`
is touched. Tracked in [`docs/RELEASE_CONTRACT.md`](./RELEASE_CONTRACT.md)
§ Metadata inconsistency.

---

## Cross-reference rules

When a release document needs to reference another release document, follow these
rules to avoid creating new contradictions:

1. **Link to the canonical document, not a supporting one, for any procedure a
   contributor must follow.** If `RELEASE_CHECKLIST_MULTI_PACKAGE.md` is canonical
   for the cross-package impact matrix, link there — not to a summary in a supporting
   doc that might drift.

2. **If two documents must both describe the same fact** (e.g., the publish command
   appears in both `RELEASE_POLICY.md` and `.github/RELEASE_CHECKLIST.md`), one of them
   must explicitly defer to the other. Use the pattern:
   > "For the authoritative procedure, see [canonical doc]. The steps below are a summary."

3. **Archival documents must not be linked from active procedures.** It is acceptable
   for an archival document to link forward to its replacement ("for current procedure,
   see X"), but no current document should send a contributor into an archival doc as
   part of a release workflow.

4. **When `docs/DOC_MAP.md` and this file disagree on a document's status**, this file
   takes precedence for release-related documents. `DOC_MAP.md` covers the full
   repository; this file has narrower scope and higher resolution for the release topic.

---

## Maintaining this map

**When to update this file:**

| Event | Update required |
|---|---|
| A new release-related document is created | Add a row to the authority table and inventory |
| An existing release document changes scope or is retired | Update the relevant authority table row; move inventory entry to archival if needed |
| A contradiction between documents is discovered and resolved | Add an entry to [Resolved contradictions](#resolved-contradictions) |
| A document that was archival is updated and made current again | Remove the archival notice from the document; move it back to the authoritative inventory; note the restoration date |

**Who updates this file:** Any engineer making a release-related documentation
change. It is not the sole responsibility of the release engineer — if you add a
new doc or retire an old one without updating this map, the next person to ask
"which doc do I follow?" has the same problem again.

**Review cadence:** This map is reviewed as part of the bi-weekly docs validation
task (BW-02 in [`docs/MAINTENANCE_CALENDAR.md`](./MAINTENANCE_CALENDAR.md)). If a
row's canonical document has drifted from what the row claims, update the row or
file an issue.
