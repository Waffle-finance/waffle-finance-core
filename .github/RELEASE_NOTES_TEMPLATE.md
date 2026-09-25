# Release Notes: v<!-- VERSION -->

> **Release date:** <!-- YYYY-MM-DD -->
> **Release type:** <!-- patch / minor / major / hotfix -->
> **Release engineer:** <!-- GitHub handle -->
> **Reviewer(s):** <!-- GitHub handle(s) — required for minor and major releases -->

---

## Risk summary

**Overall risk level:** <!-- LOW / MEDIUM / HIGH -->

<!-- One paragraph explaining the overall risk. Include: what changed at the
     protocol or service level, why the risk level was assigned, and whether
     any HIGH-risk individual changes are present. -->

**High-risk individual changes:**

<!-- List each HIGH-risk change here (e.g. contract redeployment, settlement
     logic change, SECRET_STORAGE_KEY handling change). If none, write "None". -->

- <!-- Description + affected service + rollback consequence -->

---

## Changes

### 1. Protocol changes (contracts / Soroban / Solana)

<!-- On-chain contract changes: new functions, changed parameters, events,
     invariants. State whether a redeploy is required and whether existing
     orders are affected. If none, write "None". -->

| Change | Contract | Chain | Breaking? | Redeploy required? |
|---|---|---|---|---|
| <!-- description --> | <!-- contract name --> | <!-- ethereum / stellar / solana --> | <!-- yes / no --> | <!-- yes / no --> |

**Details:**

<!-- For each row above, one paragraph or bullet list explaining the change,
     why it was made, and what operators need to do. -->

---

### 2. Coordinator changes

<!-- API routes, schema migrations, listener behavior, reconciliation,
     health/readiness checks. If none, write "None". -->

| Change | Component | Migration? | Restart required? |
|---|---|---|---|
| <!-- description --> | <!-- orders / secrets / listeners / reconciler / etc. --> | <!-- yes: <filename> / no --> | <!-- yes / no --> |

**Details:**

<!-- For each row above, describe the change. If a migration is required,
     name the file and state whether it is backward-compatible. -->

---

### 3. Relayer changes

<!-- Settlement logic, ABI paths, refund watchdog, safety deposit, logging.
     If none, write "None". -->

| Change | Component | Affects settlement? | Restart required? |
|---|---|---|---|
| <!-- description --> | <!-- escrow-creation / watchdog / pricing / etc. --> | <!-- yes / no --> | <!-- yes / no --> |

**Details:**

---

### 4. Resolver changes

<!-- Listener behavior, registry interaction, supervision, health/metrics.
     If none, write "None". -->

| Change | Component | Restart required? |
|---|---|---|
| <!-- description --> | <!-- eth-listener / soroban-listener / supervisor / etc. --> | <!-- yes / no --> |

**Details:**

---

### 5. Frontend changes

<!-- New routes, UI behavior, wallet integration, SSE, feature flag changes.
     If none, write "None". -->

| Change | Component | Feature flag affected? |
|---|---|---|
| <!-- description --> | <!-- BridgeForm / OrderHistory / hooks / etc. --> | <!-- VITE_MAINNET_ENABLED / VITE_ENABLE_MOCK_DATA / none --> |

**Details:**

---

### 6. SDK changes (`@wafflefinance/sdk`)

<!-- New/changed/removed exports, type changes, chain client methods.
     State stability tier (stable / transport-specific / internal).
     If none, write "None". -->

| Change | Export path | Stability tier | Breaking? |
|---|---|---|---|
| <!-- description --> | <!-- e.g. @wafflefinance/sdk/ethereum --> | <!-- stable / transport-specific / internal --> | <!-- yes / no --> |

**Migration guidance** (for breaking changes):

<!-- If any change is breaking, provide the before/after API and migration steps. -->

---

### 7. Dependency changes

<!-- Significant upgrades to external dependencies, especially audit-critical
     packages. Include CVE IDs for security patches. If none, write "None". -->

| Package | From | To | Reason | CVE (if any) |
|---|---|---|---|---|
| <!-- package name --> | <!-- old version --> | <!-- new version --> | <!-- security / feature / deprecation --> | <!-- GHSA-xxxx / none --> |

---

### 8. Docs and operational changes

<!-- Runbooks, env.example, CI workflows, deployment procedures.
     If none, write "None". -->

| Change | File(s) affected | Reason |
|---|---|---|
| <!-- description --> | <!-- path --> | <!-- drift correction / new runbook / etc. --> |

---

## Validation

<!-- Confirm which checks were run. Mark skipped checks with the reason.
     Do not mark a check as passing if it was not run. -->

| Check | Status | Notes |
|---|---|---|
| `pnpm test` (all packages) | <!-- ✅ Passed / ❌ Failed / ⏭ Skipped --> | |
| `./scripts/verify-release-locally.sh` | <!-- ✅ Passed / ❌ Failed / ⏭ Skipped --> | |
| Hardhat contract tests | <!-- ✅ / ❌ / ⏭ --> | |
| Foundry invariant / fuzz tests | <!-- ✅ / ❌ / ⏭ --> | |
| Mainnet-fork tests | <!-- ✅ / ❌ / ⏭ --> | Required for relayer or contract changes |
| Soroban devnet smoke test | <!-- ✅ / ❌ / ⏭ --> | Required for Soroban changes |
| Solana devnet E2E | <!-- ✅ / ❌ / ⏭ --> | Required for Solana changes |
| TypeScript type checks (`tsc --noEmit`) | <!-- ✅ / ❌ / ⏭ --> | |
| Drift detection checks (pre-release sweep) | <!-- ✅ / ❌ / ⏭ --> | See docs/DRIFT_DETECTION_RUNBOOK.md |
| Package version synchronization | <!-- ✅ / ❌ / ⏭ --> | All published packages at same version |

**Artifact checksums:**

```
Contract artifacts SHA-256: <!-- paste from verify-release-locally output -->
SDK build SHA-256:          <!-- paste from verify-release-locally output -->
Workflow run URL:           <!-- link to GitHub Actions run -->
```

---

## Cross-package dependencies

<!-- If this release changes how packages depend on each other, document it here.
     If no cross-package dependency changes, write "None". -->

| Producer package | Consumer package | Change | Both included in this release? |
|---|---|---|---|
| <!-- e.g. @wafflefinance/sdk --> | <!-- e.g. coordinator --> | <!-- new export added --> | <!-- yes / no --> |

**Version synchronization:**
<!-- Confirm all published packages are at the same version, or document any exception. -->

All published packages (`@wafflefinance/sdk`, `@wafflefinance/frontend`,
`@wafflefinance/contracts`, `@wafflefinance/relayer`, `@wafflefinance/resolver`)
are at version <!-- vX.Y.Z -->.

---

## Deployment guide

<!-- Required for MEDIUM and HIGH risk releases.
     For LOW risk releases with no database migrations or config changes,
     write "Standard restart — no special steps required." -->

### Deployment order

<!-- Per docs/OPERATIONS.md#service-dependencies, services must be deployed
     in a specific order. List the order for this release. -->

1. <!-- e.g. Database migration (if required) -->
2. <!-- e.g. Coordinator -->
3. <!-- e.g. Relayer -->
4. <!-- e.g. Resolver -->
5. <!-- e.g. Frontend -->

### Database migration

<!-- If a migration is required, name the file and state whether it is
     backward-compatible (old coordinator can run against new schema). -->

- Migration file: <!-- coordinator/migrations/XXX_description.sql -->
- Backward-compatible: <!-- yes / no — if no, coordinator must be taken offline during migration -->
- Backup required: <!-- yes (always for production) / no (dev only) -->

```bash
# Take a backup before running migrations on production
pnpm --filter @wafflefinance/coordinator db:backup -- \
  --database-url "$DATABASE_URL" \
  --out ./backups/pre-vX.Y.Z-$(date +%Y%m%d).db
```

### Config changes

<!-- List any new, renamed, or removed environment variables in this release.
     Reference env.example for current values. -->

| Variable | Change | Required? | Default |
|---|---|---|---|
| <!-- VAR_NAME --> | <!-- added / renamed from X / removed --> | <!-- yes / no --> | <!-- default value or "none" --> |

### Pause-safety

<!-- Is there any state between step N and step N+1 in the deployment order
     where a partial deployment leaves the system in an inconsistent state?
     If yes, describe it and what to do. -->

### Contract deployment (if applicable)

<!-- If a contract was redeployed, record the addresses here. -->

| Contract | Chain | New address | Replaces |
|---|---|---|---|
| <!-- contract name --> | <!-- chain --> | <!-- address --> | <!-- old address or "new deployment" --> |

Post-deployment:
```bash
# Confirm contract is live
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/validate-deployment.ts --network <network>
```

---

## Rollback plan

<!-- Reference the standard rollback runbook and add any release-specific steps. -->

Standard rollback procedure: [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](../docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md) §6

**Release-specific rollback notes:**

<!-- Are there any steps specific to this release? E.g.:
     - If coordinator was migrated to a new schema, restore from the pre-deploy backup
     - If contract was redeployed, point ETH_HTLC_ESCROW_TESTNET back to the previous address
     - If SECRET_STORAGE_KEY was rotated, restore the previous key to decrypt existing preimages -->

**In-flight order impact:**

<!-- How are orders that were in-flight at the time of deployment affected
     by a rollback? Are any settlement windows at risk? -->

---

## Known limitations in this release

<!-- Document any known gaps, deferred fixes, or technical debt items that are
     still open after this release. Reference TD-XXX entries where applicable.
     If none, write "None". -->

- <!-- TD-XXX: description of known limitation -->

---

## Checklist

Before finalising this document:

- [ ] All eight change categories filled in (or explicitly marked "None")
- [ ] Risk level assigned and justified
- [ ] Validation table complete — no check silently omitted
- [ ] Artifact checksums recorded
- [ ] Cross-package dependency changes documented
- [ ] Deployment guide complete (MEDIUM/HIGH risk) or "standard restart" confirmed (LOW risk)
- [ ] Rollback plan references the standard runbook
- [ ] Known limitations section current
- [ ] CHANGES.md will be updated after release tag CI passes
- [ ] For minor/major: at least one reviewer has approved this document

---

*Template version: 1.0 · See [docs/RELEASE_NOTES_PROCESS.md](../docs/RELEASE_NOTES_PROCESS.md) for usage instructions.*
