# Release Notes Process

> **Last updated:** 2026-09-23
> **Maintainer:** Release engineer
> **Related docs:** [RELEASE_POLICY.md](../RELEASE_POLICY.md), [.github/RELEASE_CHECKLIST.md](../.github/RELEASE_CHECKLIST.md), [.github/RELEASE_PROCESS.md](../.github/RELEASE_PROCESS.md), [.github/RELEASE_NOTES_TEMPLATE.md](../.github/RELEASE_NOTES_TEMPLATE.md), [docs/MAINTENANCE_CALENDAR.md](MAINTENANCE_CALENDAR.md)

Every release of WaffleFinance must be accompanied by clear, usable notes that
summarize what changed, what risk was introduced or reduced, and what validation
was performed. This document defines how to produce those notes, what categories
to cover, and what the notes must contain so that operations and support teams
can consume them without reading raw diffs.

---

## Table of Contents

- [Who writes release notes](#who-writes-release-notes)
- [When to write release notes](#when-to-write-release-notes)
- [How to write release notes](#how-to-write-release-notes)
- [Required categories](#required-categories)
- [Risk classification](#risk-classification)
- [Validation record](#validation-record)
- [Cross-package dependency changes](#cross-package-dependency-changes)
- [Deployment and rollback consequences](#deployment-and-rollback-consequences)
- [Known limitations](#known-limitations)
- [Release notes workflow](#release-notes-workflow)
- [Updating CHANGES.md](#updating-changesmd)

---

## Who writes release notes

The **release engineer** (the person who creates the release tag) owns the
release notes. For patch releases, the release engineer writes notes alone.
For minor and major releases, at least one additional reviewer must approve
the notes before the tag is pushed.

If a release touches a service you did not implement, coordinate with the
service owner to confirm the notes accurately describe the change.

---

## When to write release notes

| Release type | When to write | Reviewer required |
|---|---|---|
| Patch (1.0.X) — bug fixes, docs | Before pushing the tag | No (but recommended) |
| Minor (1.X.0) — new features | Before pushing the tag | Yes (1 reviewer) |
| Major (X.0.0) — breaking changes | At least 24h before pushing the tag | Yes (2 reviewers) |
| Emergency / hotfix | After the hotfix tag, within 4h | No (document promptly) |

Do not push a release tag without draft notes at minimum. Notes may be refined
after tagging but must be complete before the release is announced.

---

## How to write release notes

1. Copy `.github/RELEASE_NOTES_TEMPLATE.md` to a new file named
   `releases/v<version>.md` (create the `releases/` directory at the repo root
   if it does not exist).
2. Fill in every required section. Mark sections as `None` if there is nothing to
   report in that category — do not delete empty sections.
3. Open a PR with the release notes file. The PR title should be:
   `chore: release notes for v<version>`
4. Get the required reviews (see table above).
5. Merge the notes PR **before** pushing the release tag.
6. After the release tag CI passes, update `CHANGES.md` at the repo root with
   a one-line summary entry (see [Updating CHANGES.md](#updating-changesmd)).

---

## Required categories

Every release note must cover all eight categories. If a category has no
entries for this release, write `None` rather than omitting the section.

### 1. Protocol changes (contracts, Soroban, Solana Anchor)

Changes to any on-chain contract: new functions, changed parameters, events,
or invariants. This category has the highest risk — any protocol change affects
deployed state.

Required fields per change:
- Which contract and chain (e.g. `HTLCEscrow.sol` on Ethereum, Soroban HTLC)
- What changed (function signature, parameter, event, storage layout)
- Whether the change is backward-compatible with existing on-chain orders
- Whether a migration or redeploy is required

### 2. Coordinator changes

Changes to the coordinator service: API routes, database schema, listener
behavior, reconciliation logic, secret storage, health/readiness checks.

Required fields per change:
- Endpoint or component affected
- Whether the change requires a database migration (list migration file name)
- Whether the change requires a coordinator restart to take effect
- Whether the API shape changed (new fields, renamed fields, removed fields)

### 3. Relayer changes

Changes to the relayer service: settlement logic, ABI paths, refund watchdog,
safety deposit calculation, logging.

Required fields per change:
- Component affected
- Whether the change affects settlement (escrow creation, claim, refund)
- Whether a relayer restart is required

### 4. Resolver changes

Changes to the resolver service: listener behavior, registry interaction,
supervision, health/metrics endpoints.

### 5. Frontend changes

Changes to the dApp: new routes, UI behavior, wallet integration, SSE
integration, feature flag changes.

Required fields per change:
- Page or component affected
- Whether any feature flag (`VITE_MAINNET_ENABLED`, `VITE_ENABLE_MOCK_DATA`) changed

### 6. SDK changes (`@wafflefinance/sdk`)

Changes to the shared SDK: new exports, changed types, removed exports,
new chain client methods. The SDK stability tiers (stable / transport-specific
/ internal) determine the impact of each change.

Required fields per change:
- Export path affected (e.g. `@wafflefinance/sdk/ethereum`)
- Whether the change is breaking (removed export, changed type signature)
- Migration guidance if breaking

### 7. Dependency changes

Significant upgrades to external dependencies, particularly
audit-critical packages (`@solana/web3.js`, `@stellar/stellar-sdk`,
`viem`, `ethers`, `@openzeppelin/contracts`) and security patches.

Required fields per change:
- Package name and version range (from → to)
- Reason for the upgrade (security advisory, feature requirement, deprecation)
- CVE ID if applicable

### 8. Docs and operational changes

Changes to runbooks, deployment procedures, environment configuration (`env.example`),
CI workflows, or release process.

Required fields per change:
- File(s) affected
- Why the change was made (e.g. correcting drift, adding a new runbook)

---

## Risk classification

Every release note must include a **risk summary** that classifies the overall
release risk and lists any individual high-risk changes.

### Risk levels

| Level | Definition |
|---|---|
| **LOW** | Bug fixes, docs updates, dependency patches for non-critical packages. No on-chain changes. Rollback is a process restart. |
| **MEDIUM** | New features with database migrations, new API routes, SDK minor version bump, dependency upgrade for an audit-critical package. Rollback requires a DB restore or API version rollback. |
| **HIGH** | Protocol changes (contract redeployment or upgrade), breaking SDK changes, mainnet-gated flag changes, security patches for critical vulnerabilities. Rollback may require coordinating on-chain state. |

### When to escalate risk

Any release that includes a change in categories 1–3 (protocol, coordinator schema,
or settlement logic) is at least **MEDIUM** risk, even if the individual changes
are small.

Any release that requires a contract redeployment, changes the HTLC settlement
rule, or modifies `SECRET_STORAGE_KEY` handling is always **HIGH** risk.

---

## Validation record

Every release note must include a validation record that states, for each
changed component:

- Whether the full test suite passed (`pnpm test`)
- Whether the local verification script passed (`./scripts/verify-release-locally.sh`)
- Whether a mainnet-fork test was run (required for any relayer or contract change)
- Whether a devnet smoke test was run (required for any Soroban or Solana change)
- Any checks that were **not** run, with the reason

This is not aspirational — if a check was not run, say so. Operators and support
teams need to know the actual coverage, not the ideal coverage.

Example validation record:

```markdown
## Validation

| Check | Status | Notes |
|---|---|---|
| `pnpm test` (all packages) | ✅ Passed | |
| `./scripts/verify-release-locally.sh` | ✅ Passed | Artifact checksums in PR |
| Hardhat contract tests | ✅ Passed | 15/15 passing |
| Foundry invariant tests | ✅ Passed | |
| Mainnet-fork tests | ✅ Passed | Ran against Sepolia fork |
| Soroban devnet smoke test | ⏭ Skipped | No Soroban changes in this release |
| Solana devnet E2E | ⏭ Skipped | Solana not touched |
| TypeScript type checks | ✅ Passed | All packages clean |
```

---

## Cross-package dependency changes

When a release changes how packages depend on each other (e.g. coordinator
depends on a new SDK export, frontend requires a new coordinator API field),
document this explicitly in the release notes.

Required information:
- Which packages have a new or changed dependency
- Whether the dependency requires a version bump in `package.json`
- Whether both the producer and the consumer of the change are included in this release
- Whether any dependent service (relayer, resolver, frontend) must be
  restarted or rebuilt as a result

**Version synchronization rule:** Per [RELEASE_POLICY.md](../RELEASE_POLICY.md),
all published packages must be released together with the same version number.
The release notes must confirm this or explicitly document any exception.

---

## Deployment and rollback consequences

For any release with MEDIUM or HIGH risk, include an explicit deployment and
rollback section that answers:

1. **In what order must services be deployed?** (See service dependency order
   in [docs/OPERATIONS.md](OPERATIONS.md#service-dependencies).)
2. **Is there a database migration?** If yes: name the migration file, state
   whether it is backward-compatible (can the old code still run against the
   new schema?), and reference the backup procedure in
   [coordinator/docs/backup-restore.md](../coordinator/docs/backup-restore.md).
3. **Can the deployment be paused mid-way?** Describe any state where a partial
   deployment leaves the system in an inconsistent state.
4. **What is the rollback path if the deployment fails?** Reference
   [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md) §6
   and add any release-specific steps.
5. **Are there any in-flight orders that could be affected?** If the coordinator
   or relayer changes settlement logic, describe how existing orders are handled.

---

## Known limitations

Document any known limitations or deferred issues in the release notes. This
prevents support escalations from users who discover a known behavior.

Examples:
- "Solana listener starts in simulation mode if `SOLANA_HTLC_PROGRAM` is unset"
- "`SECRET_STORAGE_KEY` defaults to unencrypted if not set (TD-041 — open)"
- "Relayer safety deposit uses hardcoded ETH/USD = $3500 (TD-052 — open)"

Reference the technical debt entry (`TD-XXX`) if the limitation is tracked
in `docs/TECHNICAL_DEBT.md`.

---

## Release notes workflow

```
1. Engineer opens a PR with the version bump (pnpm version X.Y.Z -ws)
   └─ PR description includes draft notes or a link to the notes file

2. Release engineer copies .github/RELEASE_NOTES_TEMPLATE.md
   → releases/vX.Y.Z.md

3. Release engineer fills in all required sections

4. PR reviewed (1 reviewer for minor, 2 for major)
   └─ Reviewers confirm: accuracy of changes, risk level, validation record,
      deployment/rollback guidance

5. Notes PR merged

6. Release tag pushed: git tag -a vX.Y.Z -m "Release vX.Y.Z"
   └─ Tag message should link to or quote the risk summary from notes

7. Verify CI artifacts:
   - Contract artifacts checksum
   - SDK build checksum
   - Release verification report

8. Update CHANGES.md with one-line summary (see below)

9. Announce release per RELEASE_POLICY.md §Post-Release
```

---

## Updating CHANGES.md

After every release, add a one-line entry to the top of `CHANGES.md` in the
format:

```markdown
## vX.Y.Z — YYYY-MM-DD

[One sentence summary of what the release contains and its overall risk level.]

See [releases/vX.Y.Z.md](releases/vX.Y.Z.md) for full release notes.
```

Keep `CHANGES.md` as a running index. Full notes live in `releases/`. This
keeps the changelog scannable and the detailed notes navigable.
