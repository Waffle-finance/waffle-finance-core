# Maintenance Calendar

> **Last updated:** 2026-09-23
> **Maintainer:** Engineering / Platform team
> **Related docs:** [docs/OPERATIONS.md](OPERATIONS.md), [docs/DRIFT_DETECTION_RUNBOOK.md](DRIFT_DETECTION_RUNBOOK.md), [docs/DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md), [docs/TECHNICAL_DEBT.md](TECHNICAL_DEBT.md), [coordinator/ops/RUNBOOK.md](../coordinator/ops/RUNBOOK.md)

WaffleFinance is a multi-chain, multi-service protocol with recurring operational
work that, if skipped, accumulates into incidents. This calendar makes that work
explicit, schedulable, and trackable. Each task specifies who owns it, how often
it runs, what outputs are expected, and what to escalate or hand off when
something is wrong.

---

## Table of Contents

- [How to use this calendar](#how-to-use-this-calendar)
- [Weekly tasks](#weekly-tasks)
- [Bi-weekly tasks](#bi-weekly-tasks)
- [Monthly tasks](#monthly-tasks)
- [Quarterly tasks](#quarterly-tasks)
- [Per-release tasks](#per-release-tasks)
- [Per-deployment tasks](#per-deployment-tasks)
- [Ad-hoc tasks (triggered by events)](#ad-hoc-tasks-triggered-by-events)
- [Escalation and handoff](#escalation-and-handoff)
- [Calendar summary table](#calendar-summary-table)

---

## How to use this calendar

Each task has:
- **Cadence** — how often it should run
- **Owner** — which role is responsible (platform engineer, security reviewer, etc.)
- **Input** — what to look at
- **Expected output** — what "done" means
- **Escalation** — what to do if the check fails or can't be completed

**Scheduling:** Add recurring tasks to your team's sprint planning, GitHub Project board, or calendar system. Tasks marked `per-release` or `per-deployment` are gated on those events rather than the clock.

**Tracking:** When a task runs, open a brief GitHub issue or comment in the tracking issue with: date, who ran it, output summary, and any open items found. This creates an audit trail without requiring a full postmortem for routine maintenance.

---

## Weekly tasks

### W-01 · Health and listener lag review

**Cadence:** Weekly (Monday morning, before start of day)
**Owner:** Platform engineer on rotation
**Time estimate:** 15 minutes

**Procedure:**

```bash
# 1. Check coordinator readiness
curl -s "$COORDINATOR_URL/readyz" | jq '.'

# 2. Check listener lag on all chains
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_listener_lag_blocks

# 3. Check reconciliation is running
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_reconciliation_last_run_timestamp_seconds

# 4. Check relayer health
curl -s "$RELAYER_URL/readyz" | jq '.'

# 5. Check resolver readiness (if managed resolver is running)
curl -s "$RESOLVER_HEALTH_URL/readyz" | jq '.'
```

**Expected output:**
- Coordinator `/readyz` returns `startup_phase: "ready"` or `status: "ok"` (not `degraded`)
- Listener lag: all chains ≤ 100 blocks (warning) — escalate if any chain shows > 500 blocks
- Reconciliation last run: within the last 2 hours
- Relayer all RPC checks: `ok: true`

**Escalation:** Any health check failing → follow the relevant runbook in
[coordinator/ops/RUNBOOK.md](../coordinator/ops/RUNBOOK.md). If unable to
resolve within 1 hour, escalate to platform lead.

---

### W-02 · Active order review

**Cadence:** Weekly
**Owner:** Platform engineer on rotation
**Time estimate:** 10 minutes

**Procedure:**

```bash
# Count active (non-terminal) orders
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_active_orders

# Check for orders stuck in intermediate states > 24h
curl -s "$COORDINATOR_URL/orders/history?address=ALL&limit=50" | jq \
  '[.[] | select(.status != "completed" and .status != "refunded" and .status != "failed")]'
```

**Expected output:**
- No individual order stuck in `src_locked`, `dst_locked`, or `secret_revealed`
  for more than 24 hours without a corresponding refund or claim event
- Active order count trending normally (not growing unboundedly)

**Escalation:** Stuck order > 24h → check if the on-chain timelock has expired
and the user can call `refundOrder` directly. If a bug in the coordinator/relayer
prevented normal processing, open a bug issue against the relevant service.

---

## Bi-weekly tasks

### BW-01 · Dependency review window

**Cadence:** Every two weeks (alternating Mondays)
**Owner:** Platform engineer + one reviewer familiar with the affected packages
**Time estimate:** 30–60 minutes

**Procedure:**

```bash
# Check for outdated packages across the workspace
pnpm outdated -r

# Check for known vulnerabilities
pnpm audit --audit-level=high

# Review dep-review workflow results in GitHub Actions
# (Check for any PRs labelled 'critical-deps' merged in the last two weeks)
```

Cross-reference against [docs/DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md) §2
pinned version tables. If a security advisory was published for a pinned
dependency, treat it as a `critical-deps` change and follow §4.3.

**Expected output:**
- No HIGH or CRITICAL severity vulnerabilities unaddressed
- Audit-critical packages (`@solana/web3.js`, `@stellar/stellar-sdk`, `viem`,
  `ethers`, `@openzeppelin/contracts`) reviewed; if updates are available,
  a tracking issue is opened

**Escalation:** Any HIGH/CRITICAL unpatched vulnerability → open a priority issue
with label `security`; assign to platform lead. If a zero-day is actively
exploited, treat as SEV-1 and follow the emergency release procedure in
[RELEASE_POLICY.md](../RELEASE_POLICY.md).

---

### BW-02 · Docs validation

**Cadence:** Every two weeks
**Owner:** Any engineer
**Time estimate:** 20 minutes

**Procedure:**

Run all static drift checks from [docs/DRIFT_DETECTION_RUNBOOK.md](DRIFT_DETECTION_RUNBOOK.md):

1. Doc-to-file link check (check 3 in the runbook)
2. Env var coverage check (check 2)
3. Package version synchronization (check 5)

```bash
# Run doc link check (inline script from DRIFT_DETECTION_RUNBOOK.md §3)
node -e "..." # (see runbook)

# Run env var coverage check
grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]+" coordinator/src relayer/src resolver/src \
  packages/sdk/src packages/config/src | sort -u > /tmp/code_vars.txt
grep -oE "^[A-Z_][A-Z0-9_]+" env.example | sort -u > /tmp/example_vars.txt
comm -23 /tmp/code_vars.txt /tmp/example_vars.txt
```

**Expected output:**
- Zero broken markdown links
- Zero env vars in code but absent from `env.example`
- All published package versions synchronized

**Escalation:** File a GitHub issue for any gap found. Assign it to the
engineer who owns the affected service. Link the issue from
[docs/QUALITY_GATE.md](QUALITY_GATE.md) § "Known drift" table.

---

## Monthly tasks

### M-01 · Full environment parity check (testnet / devnet / local)

**Cadence:** Monthly (first week of month)
**Owner:** Platform engineer
**Time estimate:** 60–90 minutes

Compare all three environments against the expected baseline:

| Layer | Testnet | Devnet (Solana) | Local |
|---|---|---|---|
| Contract addresses | `deployments.testnet.json` | `SOLANA_HTLC_PROGRAM` env var | Same as testnet for EVM/Stellar |
| Chain IDs | Sepolia: 11155111 | Solana devnet | Same |
| NETWORK_MODE | `testnet` | `testnet` | `testnet` |
| RPC URLs | Configured, reachable | `https://api.devnet.solana.com` reachable | As per `env.example` |
| Secret encryption | `SECRET_STORAGE_KEY` set | Same | Set even for local (TD-041) |

**Procedure:**

```bash
# Run full deployment validation script
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/validate-deployment.ts --network sepolia

# Confirm all env var checks pass in coordinator
pnpm --filter @wafflefinance/coordinator validate-env 2>&1 | tail -5

# Confirm Solana listener state
curl -s "$COORDINATOR_URL/health" | jq '.listeners'

# Confirm Soroban bindings are not stale (check IDL hash)
stellar contract info --id "$SOROBAN_HTLC_TESTNET" --rpc-url "$SOROBAN_RPC_URL" \
  2>&1 | grep -i "hash\|version"
```

**Expected output:**
- All three environments pass their validation scripts
- No environment has a contract address pointing at a stale or nonexistent deployment
- Soroban bindings freshness confirmed (or a bindings-regen issue filed)

**Escalation:** Any environment-parity gap → open a `maintenance` issue with
the affected environment and the specific drift found. Block the next release
if the gap is in a contract address or config that affects settlement.

---

### M-02 · Technical debt review

**Cadence:** Monthly (during planning week)
**Owner:** Engineering team lead
**Time estimate:** 45 minutes

Review [docs/TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) with the engineering team:

1. Mark any items resolved since last review with ✅ and the resolution PR
2. Identify any HIGH items that have aged > 60 days without progress
3. Assign owners to HIGH items without owners
4. Prioritise one MEDIUM item for the next sprint if no HIGH items are blocking
5. Add any newly discovered debt as a new entry

**Expected output:**
- No HIGH item older than 90 days without an owner and a planned resolution date
- At least one MEDIUM item moved to the sprint backlog
- Resolved items marked ✅

**Escalation:** HIGH items blocked on external dependency (audit, third-party
deployment) → document the blocker explicitly in the item's "Next steps" and
set a calendar reminder for the expected unblock date.

---

### M-03 · Release validation check

**Cadence:** Monthly (runs even in months with no planned release)
**Owner:** Release engineer
**Time estimate:** 30 minutes

Verify that the local release verification pipeline still works:

```bash
# On macOS / Linux
./scripts/verify-release-locally.sh

# On Windows
.\scripts\verify-release-locally.ps1
```

This exercises the full chain: Hardhat + Foundry compilation, SDK build,
export path validation, TypeScript type checks, and artifact checksums. If it
fails in a no-release month, a regression crept in since the last run.

**Expected output:**
- Script exits 0 with all steps passing
- Artifact checksums generated without error

**Escalation:** Any step failure → open a bug issue with the failing step and
the error output. Do not proceed with any release until the verification script
is green.

---

## Quarterly tasks

### Q-01 · Security and access control audit

**Cadence:** Quarterly (January, April, July, October)
**Owner:** Security reviewer + platform lead
**Time estimate:** Half-day

Review:

1. **Smart contract ownership:** Confirm `ResolverRegistry` owner is still the intended address (multisig on mainnet; single EOA is acceptable on testnet with documented risk). See TD-011.
2. **Soroban admin key:** Confirm the Soroban HTLC `admin` key has not been rotated without a runbook. See TD-021 and `soroban/docs/ADMIN_KEY_ROTATION.md` (when created).
3. **Coordinator operator keys:** Confirm `COORDINATOR_OPERATOR_KEYS` are rotated per your org's key rotation policy and that no old keys remain active.
4. **Relayer/Resolver signing keys:** Confirm `RESOLVER_ETH_PRIVATE_KEY` and `RESOLVER_STELLAR_SECRET` are stored in your secrets manager, not in committed env files.
5. **Secret storage encryption:** Confirm `SECRET_STORAGE_KEY` is set and meets the 32-byte minimum across all coordinator instances.

```bash
# Verify no private keys are committed
git log --all --follow -p -- .env .env.* | grep -E "PRIVATE_KEY|SECRET" | head -5
# Expected: empty output
```

**Expected output:**
- All signing keys are in secrets manager; none committed to the repository
- Contract ownership confirmed
- A brief written summary filed as a GitHub issue comment on the quarterly security issue

**Escalation:** Any key exposure → treat as SEV-1. Rotate immediately. Follow
postmortem process from [docs/OPERATIONS.md](OPERATIONS.md#postmortem-process).

---

### Q-02 · Network health and RPC provider review

**Cadence:** Quarterly
**Owner:** Platform engineer
**Time estimate:** 2 hours

1. Review uptime and rate-limit statistics for all configured RPC providers
   (Infura, Alchemy, public fallbacks) over the past quarter
2. Identify chains where the primary RPC had > 0.1% downtime
3. Review whether fallback RPC URLs are configured and working
4. Check Stellar testnet / Soroban RPC for any announced deprecations
5. Check Solana devnet for any announced breaking changes to the RPC API

**Expected output:**
- Document any RPC providers at or near rate limits
- Open tracking issues for any deprecated or unreliable RPC endpoints
- Confirm fallback RPCs are functional

**Escalation:** A production chain has no working RPC fallback → treat as
operational gap. Provision an alternate provider before the next release.

---

### Q-03 · Mainnet readiness review (until mainnet launch)

**Cadence:** Quarterly (until independent audit completes and mainnet is unlocked)
**Owner:** Engineering lead
**Time estimate:** 1–2 hours

Review the mainnet readiness blockers:

1. **Audit status:** Is the independent smart-contract audit on track for Q1 2027?
2. **Mainnet code paths:** Are `VITE_MAINNET_ENABLED=true` and
   `NETWORK_MODE=mainnet` CI matrix legs passing? (see `frontend.yml`)
3. **1inch EscrowFactory mainnet ABI path:** Is TD-053 (untested mainnet ABI)
   still open? If so, do the mainnet-fork tests cover it?
4. **ResolverRegistry owner:** Is the multisig address ready for mainnet deployment?
5. **SECRET_STORAGE_KEY required:** Is TD-041 (optional key) resolved?

**Expected output:**
- A written status update on the mainnet launch blockers
- Any newly discovered blockers added to the mainnet checklist in
  `contracts/docs/mainnet-deployment-checklist.md`

---

## Per-release tasks

These tasks run for every release, regardless of cadence. They supplement
the [.github/RELEASE_CHECKLIST.md](../.github/RELEASE_CHECKLIST.md).

### R-01 · Drift detection pre-release sweep

Before tagging any release, run all checks from
[docs/DRIFT_DETECTION_RUNBOOK.md](DRIFT_DETECTION_RUNBOOK.md) §
"Required checks before any deployment or upgrade."

Minimum:
- Check 1 (address comparison)
- Check 2 (env var coverage)
- Check 5 (package version sync)
- Check 6 (deployment artifact sync)

**Expected output:** All checks pass, or all failures are documented in the
release PR with a resolution plan.

### R-02 · Release notes draft

Before tagging, draft release notes using the template in
[.github/RELEASE_NOTES_TEMPLATE.md](../.github/RELEASE_NOTES_TEMPLATE.md) and
the process in [docs/RELEASE_NOTES_PROCESS.md](RELEASE_NOTES_PROCESS.md).

**Expected output:** Release notes PR approved by at least one reviewer before
the release tag is pushed.

### R-03 · Verification script run

```bash
./scripts/verify-release-locally.sh   # macOS / Linux
.\scripts\verify-release-locally.ps1  # Windows
```

**Expected output:** Script exits 0. Record the artifact checksums in the
release PR description.

---

## Per-deployment tasks

These tasks run every time a service is deployed or a contract is deployed/upgraded.

### D-01 · Post-deploy health verification

After any deployment (code or contract), run the three post-deploy checks from
[docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md) §3:

```bash
# a. Live
curl -sf "$COORDINATOR_URL/readyz" | jq '.'

# b. Synchronized (listener lag returning to baseline)
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_listener_lag_blocks

# c. No stale event window (reconciliation ran since restart)
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_reconciliation_last_run_timestamp_seconds
```

**Expected output:** All three checks pass within 15 minutes of deploy. If any
check fails after 15 minutes, roll back per the runbook.

### D-02 · Contract deployment artifact update

After any contract deployment or upgrade:

1. Confirm `deployments.<network>.json` was updated by the deploy script
2. Update env var comments in `env.example` if addresses changed
3. Update the "Deployed contracts" table in `README.md`
4. Update `coordinator/docs/INTEGRATION_GUIDE.md` if API behavior changed

**Expected output:** All four layers updated in the same PR as (or immediately
following) the deployment.

### D-03 · Soroban bindings regen

After any Soroban contract deployment:

```bash
stellar contract bindings typescript \
  --contract-id "$SOROBAN_HTLC_TESTNET" \
  --rpc-url "$SOROBAN_RPC_URL" \
  --network-passphrase "Test SDF Network ; September 2015" \
  --output-dir packages/sdk/src/soroban/htlc-bindings/

pnpm --filter @wafflefinance/sdk build
pnpm --filter @wafflefinance/sdk test
```

**Expected output:** Bindings regenerated, SDK builds, tests pass.

---

## Ad-hoc tasks (triggered by events)

### AH-01 · Incident postmortem (after any SEV-1 or SEV-2)

**Trigger:** Any SEV-1 or SEV-2 incident resolved
**Deadline:** Issue opened within 24h; draft completed within 5 business days; merged within 8 business days

Follow [docs/OPERATIONS.md](OPERATIONS.md#postmortem-process) and the template
at [docs/postmortem/TEMPLATE.md](postmortem/TEMPLATE.md).

### AH-02 · RPC provider degradation response

**Trigger:** Any chain's listener lag exceeds 500 blocks for > 30 minutes

```bash
# Check current lag
curl -s "$COORDINATOR_URL/metrics" | grep coordinator_listener_lag_blocks

# Switch to fallback RPC (update .env and restart)
ETHEREUM_RPC_URL="$FALLBACK_RPC_URL" docker restart wafflefinance-coordinator
```

### AH-03 · Secret key rotation

**Trigger:** Key compromise, scheduled rotation, or staff change
**Owner:** Platform lead

Follow [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md) §4
for `SECRET_STORAGE_KEY` rotation. For signing key rotation (relayer/resolver),
follow TD-062 guidance (key rotation protocol not yet fully documented — track
via the tech debt item).

### AH-04 · Dependency security advisory

**Trigger:** A published CVE affects a dependency in the workspace
**Owner:** Platform engineer (triage) → platform lead (if HIGH/CRITICAL)

1. Assess exploitability in the WaffleFinance context
2. If HIGH/CRITICAL and exploitable: treat as `critical-deps` change, follow
   [docs/DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md) §4.3
3. If MODERATE: schedule for next bi-weekly dependency review window
4. Document the decision in a GitHub issue regardless of severity

---

## Escalation and handoff

When a maintenance task cannot be completed (owner unavailable, blocked on
external dependency, time constraint), follow this handoff sequence:

1. **Document the skip:** Add a comment to the tracking issue stating the date,
   the reason for skipping, and the rescheduled date.
2. **Identify the risk:** Classify the uncompleted check as LOW (informational),
   MEDIUM (reliability gap), or HIGH (potential security or data integrity risk).
3. **For HIGH risk:** The task must not be skipped — escalate to the platform
   lead immediately and reassign ownership.
4. **For MEDIUM/LOW risk:** Reschedule within one calendar period
   (e.g., a weekly task skipped this week must run next week).
5. **For per-release and per-deployment tasks:** These cannot be deferred —
   they block the release or deployment until completed, or the specific gap is
   explicitly accepted and documented by the release engineer.

---

## Calendar summary table

| ID | Task | Cadence | Owner | Blocks release? |
|---|---|---|---|---|
| W-01 | Health and listener lag review | Weekly | Platform engineer | No |
| W-02 | Active order review | Weekly | Platform engineer | No |
| BW-01 | Dependency review window | Bi-weekly | Platform engineer + reviewer | If HIGH/CRITICAL CVE found |
| BW-02 | Docs validation | Bi-weekly | Any engineer | No |
| M-01 | Full environment parity check | Monthly | Platform engineer | If address drift found |
| M-02 | Technical debt review | Monthly | Engineering lead | If HIGH item is a release blocker |
| M-03 | Release verification script | Monthly | Release engineer | Yes |
| Q-01 | Security and access control audit | Quarterly | Security reviewer | If key exposure found |
| Q-02 | Network health and RPC review | Quarterly | Platform engineer | No |
| Q-03 | Mainnet readiness review | Quarterly | Engineering lead | If mainnet launch blocker found |
| R-01 | Drift detection pre-release sweep | Per release | Release engineer | Yes |
| R-02 | Release notes draft | Per release | Release engineer | Yes |
| R-03 | Verification script run | Per release | Release engineer | Yes |
| D-01 | Post-deploy health verification | Per deployment | Platform engineer | — (gates "deployment complete") |
| D-02 | Contract artifact update | Per contract deploy | Release engineer | — |
| D-03 | Soroban bindings regen | Per Soroban deploy | SDK engineer | — |
| AH-01 | Postmortem | After SEV-1/SEV-2 | Incident commander | — |
| AH-02 | RPC degradation response | On listener lag alert | Platform engineer | — |
| AH-03 | Secret key rotation | On demand | Platform lead | — |
| AH-04 | Security advisory response | On CVE publication | Platform engineer | If HIGH/CRITICAL |
