# Incident Response Checklist

This checklist guides the first responder through the active response window for
a suspected funds-at-risk incident. It covers the first 60 minutes: determine
whether funds are actually at risk, preserve evidence, limit scope, and direct
users safely — without touching user contracts or requesting credentials.

Use [docs/BUG_TRIAGE.md](BUG_TRIAGE.md) to classify and route an incoming
report before this checklist. Use [docs/postmortem/WORKFLOW.md](postmortem/WORKFLOW.md)
after the incident is resolved.

> **Hard prohibitions (never do these):**
> - Do not ask a user for their wallet private key, seed phrase, or HTLC preimage.
> - Do not reveal a preimage to anyone who does not already hold the funds the
>   preimage unlocks.
> - Do not modify, pause, or upgrade a live HTLC contract as a containment step —
>   the contracts have no admin escape hatch and existing orders are unaffected
>   by contract upgrades. Any attempt will fail and wastes response time.
> - Do not ask users to send funds to a "recovery address."

---

## Table of contents

- [Step 1 — Acknowledge and classify](#step-1--acknowledge-and-classify)
- [Step 2 — Distinguish service outage from on-chain funds risk](#step-2--distinguish-service-outage-from-on-chain-funds-risk)
- [Step 3 — Verify chain state](#step-3--verify-chain-state)
- [Step 4 — Assess refund layer availability](#step-4--assess-refund-layer-availability)
- [Step 5 — Preserve evidence](#step-5--preserve-evidence)
- [Step 6 — Contain the incident](#step-6--contain-the-incident)
- [Step 7 — Direct users](#step-7--direct-users)
- [Step 8 — Escalation and communication](#step-8--escalation-and-communication)
- [Step 9 — Resolution and postmortem trigger](#step-9--resolution-and-postmortem-trigger)
- [Periodic validation](#periodic-validation)
- [Related documents](#related-documents)

---

## Step 1 — Acknowledge and classify

**Time target: within 5 minutes of alert or report.**

- [ ] Acknowledge the alert or report. Post in the incident Slack thread (or open
      one) so the team knows someone is responding.
- [ ] Record the detection time in UTC: `____-__-__T__:__Z`
- [ ] Add the `needs-triage` label to the GitHub issue if one exists.
- [ ] Identify the initial signal:
  - [ ] Monitoring alert (name: ___________________________)
  - [ ] User report (platform: ___________________________)
  - [ ] On-call engineer observation
- [ ] Confirm the reporter's order ID or transaction hash if provided:
      `Order ID / TX: ___________________________`

Do not close or dismiss at this step. Even unlikely-sounding reports must be
investigated before severity is assigned.

---

## Step 2 — Distinguish service outage from on-chain funds risk

This is the critical decision. A service outage (coordinator or relayer down)
looks alarming but does not put funds at risk as long as at least one refund
layer is functional. Work through both sub-checks before assigning severity.

### 2a. Service health

```bash
# Coordinator liveness
curl -sf https://<coordinator-url>/healthz | jq '.status'

# Coordinator readiness (dependency checks)
curl -sf https://<coordinator-url>/readyz | jq '{status, checks}'

# Relayer liveness
curl -sf https://<relayer-url>/healthz | jq '.status'

# Relayer readiness (RPC connectivity)
curl -sf https://<relayer-url>/readyz | jq '{status, checks}'
```

- [ ] Coordinator `/healthz` returns `ok` → process is alive
- [ ] Coordinator `/readyz` returns `ok` → dependencies connected
- [ ] Relayer `/healthz` returns `ok`
- [ ] Relayer `/readyz` returns `ok`

If all four pass: **this is likely a service outage, not a funds-at-risk
incident.** Continue to verify any specific order ID, then assign SEV-2 or
SEV-3 as appropriate and skip to [Step 8](#step-8--escalation-and-communication).

If any fail: continue.

### 2b. Order-level funds check

If a specific order ID is known:

```bash
curl -sf https://<coordinator-url>/api/orders/<ORDER_ID> \
  | jq '{status, isRefundable, "src.timelock": .src.timelock, "dst.timelock": .dst.timelock}'
```

- [ ] `status` is one of `src_locked`, `dst_locked`, `expired`, or `failed`
      AND `isRefundable` is `true` → funds are locked on-chain
- [ ] `status` is `completed` or `refunded` → funds already moved; no risk
- [ ] `status` is `announced` → no on-chain funds locked yet; no risk

**Decision rule:**

| Service health | isRefundable | Severity |
|---|---|---|
| All OK | false / no order | SEV-3 or SEV-4 — service issue, no funds at risk |
| All OK | true | SEV-2 — funds locked, refund layers intact |
| Any degraded | true | SEV-1 — funds at risk, refund path may be impaired |
| Any degraded | unknown | SEV-1 — treat as funds at risk until proven otherwise |

Record your determination: `Severity assigned: ____` `Funds at risk: Y / N`

---

## Step 3 — Verify chain state

**Only run this step when funds are confirmed or suspected at risk.**

Look up the on-chain order ID (`src.orderId` from the coordinator record) on
the relevant chain's block explorer.

### Ethereum

```bash
# Read order state directly from the contract
cast call <HTLC_CONTRACT_ADDRESS> \
  "getOrder(uint256)((address,address,address,address,uint256,uint256,bytes32,uint64,uint64,uint64,uint8,bytes32))" \
  <ON_CHAIN_ORDER_ID> \
  --rpc-url <ETH_RPC_URL>
```

- [ ] `status` field: `0` = Funded (at risk), `1` = Claimed, `2` = Refunded
- [ ] `timelock` field: Unix timestamp after which refund is permissionless
- [ ] `timelock` vs `block.timestamp`:
  ```bash
  cast block latest --rpc-url <ETH_RPC_URL> | grep timestamp
  ```
  - [ ] `block.timestamp > timelock` → refund available now
  - [ ] `block.timestamp ≤ timelock` → still within claim window; note expiry time

Record: `On-chain status: ____` `Timelock expires: ____-__-__T__:__Z`

### Stellar

```bash
# Get latest ledger timestamp
curl "https://soroban-testnet.stellar.org" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | jq '{sequence, closeTime}'
```

- [ ] Retrieve order entry via `getLedgerEntries` and confirm `status`
- [ ] Compare `timelock` in order against `closeTime` from above
  - [ ] `closeTime > timelock` → refund available
  - [ ] `closeTime ≤ timelock` → still within claim window

Record: `Stellar order status: ____` `Timelock expires (ledger closeTime): ____`

### Solana

- [ ] Look up the order PDA on `explorer.solana.com` using the program ID
- [ ] Confirm order account exists and decode the `timelock` field
- [ ] Check current slot time: `solana block-time <SLOT> --url <RPC_URL>`

---

## Step 4 — Assess refund layer availability

WaffleFinance has four independent refund layers. Document which are functional.

| Layer | How to check | Status |
|---|---|---|
| **1. Automatic** — relayer watchdog detects expiry and submits refund | `GET /readyz` on relayer; check `coordinator` check is `ok` | OK / Degraded |
| **2. Coordinator-triggered** — coordinator's expiry scan marks orders and notifies relayer | `GET /health` on coordinator; `reconciliation` field not null | OK / Degraded |
| **3. User self-service** — user calls `refundOrder` / `refund_order` directly from their wallet | On-chain contract is callable; timelock has passed | OK / Blocked |
| **4. Manual operator** — operator calls `POST /api/orders/manual-refund` on relayer or submits on-chain tx | Relayer `/healthz` OK; relayer `stellar_rpc` check OK | OK / Degraded |

- [ ] At least one layer is functional → funds are not permanently at risk
- [ ] All four layers degraded simultaneously → **SEV-1; escalate immediately**

If Layer 3 (user self-service) is functional and the timelock has passed, the
user can recover without any service involvement. Direct them to
[docs/SAFE_RECOVERY_GUIDE.md](SAFE_RECOVERY_GUIDE.md) immediately.

---

## Step 5 — Preserve evidence

Capture this evidence before taking any containment action. Evidence taken after
remediation is harder to trust.

- [ ] **Service logs** — capture the coordinator and relayer logs for the full
      incident window plus 30 minutes before:
  ```bash
  # Coordinator (adjust to your log source — file, Docker, or platform)
  jq 'select(.time >= "<INCIDENT_START_UTC>" and .time <= "<NOW_UTC>")' \
    coordinator.log > incident-coordinator-$(date +%Y%m%d%H%M).log

  # Relayer
  jq 'select(.time >= "<INCIDENT_START_UTC>" and .time <= "<NOW_UTC>")' \
    relayer.log > incident-relayer-$(date +%Y%m%d%H%M).log
  ```

- [ ] **Affected orders** — export the order records from the coordinator:
  ```bash
  curl -sf "https://<coordinator-url>/api/audit/orders/<ORDER_ID>/timeline" \
    > incident-order-timeline-<ORDER_ID>.json

  # For bulk export (operator token required)
  curl -sf "https://<coordinator-url>/api/export/orders" \
    -H "Authorization: Bearer $COORDINATOR_OPERATOR_KEY" \
    > incident-orders-export.json
  ```

- [ ] **On-chain transactions** — record all relevant transaction hashes and
      paste block-explorer links into the incident thread:
  - Lock TX: `___________________________`
  - Claim TX (if any): `___________________________`
  - Refund TX (if any): `___________________________`

- [ ] **Metrics snapshot** — capture Prometheus metrics at the time of incident:
  ```bash
  curl -sf "https://<coordinator-url>/metrics" \
    > incident-metrics-$(date +%Y%m%d%H%M).txt
  ```

- [ ] **Settlement failure records** (if relayer is accessible):
  ```bash
  curl -sf "https://<relayer-url>/api/admin/settlement-failures" \
    -H "Authorization: Bearer $RELAYER_ADMIN_KEY" \
    > incident-settlement-failures.json
  ```

- [ ] Store all captured files in a named folder: `incident-<YYYY-MM-DD>/`
- [ ] Attach or link evidence in the GitHub incident issue before proceeding.

---

## Step 6 — Contain the incident

Containment actions depend on severity. Take the minimum action necessary to
stop the incident from worsening; do not attempt a full fix under time pressure.

### Service outage (SEV-2 — no on-chain funds risk)

- [ ] Restart the degraded service following
      [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md) §2–3.
- [ ] Verify `/readyz` returns `ok` after restart.
- [ ] Check `coordinator_reconciliation_last_run_timestamp_seconds` advanced past
      the restart time (reconciliation caught up on the downtime window).

### On-chain funds at risk (SEV-1)

- [ ] Do **not** restart services as the first action — restart cannot un-lock
      on-chain funds and wastes time. Verify chain state first (Step 3).
- [ ] If the timelock has passed and the relayer is accessible, trigger a manual
      refund:
  ```bash
  curl -X POST "https://<relayer-url>/api/orders/manual-refund" \
    -H "Content-Type: application/json" \
    -d '{"orderId":"<ORDER_ID>","stellarAddress":"<USER_STELLAR_ADDR>","stellarTxHash":"<TX_HASH>"}'
  ```
- [ ] If the relayer is not accessible but the timelock has passed, instruct the
      user to call `refundOrder` directly from their wallet (see Step 7).
- [ ] If the relayer settlement-reconcile endpoint is accessible, trigger a sweep:
  ```bash
  curl -X POST "https://<relayer-url>/api/settlement/reconcile" \
    -H "Authorization: Bearer $RELAYER_ADMIN_KEY" \
    -d '{"trigger":"manual"}'
  ```
- [ ] If the coordinator is accessible, trigger an expiry scan:
  ```bash
  curl -X POST "https://<coordinator-url>/admin/expire-now" \
    -H "Authorization: Bearer $COORDINATOR_OPERATOR_KEY"
  ```

---

## Step 7 — Direct users

When communicating with affected users, follow these rules:

- [ ] Send the user to [docs/SAFE_RECOVERY_GUIDE.md](SAFE_RECOVERY_GUIDE.md) for
      self-service refund steps. It covers Ethereum, Stellar, and Solana without
      requiring any service to be online.
- [ ] Confirm the **correct chain** for their swap direction before giving
      any instruction. ETH→XLM funds are locked on Ethereum first; XLM→ETH
      funds are locked on Stellar first.
- [ ] Confirm whether the **timelock has passed** before suggesting a refund.
      If not, the refund call will revert and waste gas.
- [ ] Do not ask for or accept the user's private key, seed phrase, or preimage.
- [ ] Do not direct users to any wallet address not documented as an official
      contract address.
- [ ] If you need to look up their order: ask for the **order ID** or their
      **wallet address** only. Do not ask for transaction hashes unless the
      coordinator is unavailable.

**Message template for users (copy-paste into Discord/support):**

> Hi — we can see your order. Here are the steps to check eligibility and
> recover your funds directly on-chain, without needing our services to be
> online: [docs/SAFE_RECOVERY_GUIDE.md](SAFE_RECOVERY_GUIDE.md).
>
> Your funds are locked on **[Ethereum / Stellar / Solana]**. The timelock
> expires at **[UTC time]**. After that time you can call `refundOrder` (or
> `refund_order` on Stellar) from your own wallet — no one else needs to be
> involved.
>
> Do not share your wallet password, seed phrase, or any secret value with
> anyone, including us.

---

## Step 8 — Escalation and communication

### SEV-1 (funds at risk or inaccessible)

- [ ] Page the incident commander within 15 minutes of classification.
      If unreachable, page the team lead directly.
- [ ] Open a dedicated incident Slack thread named
      `#incident-<YYYY-MM-DD>-<short-slug>`. Post a one-line summary and a
      link to the GitHub issue every 30 minutes until resolved.
- [ ] Apply `sev-1` and `funds-at-risk` labels to the GitHub issue.
- [ ] Do not post specific order IDs, wallet addresses, or amounts publicly.
      Use the private incident channel for details.

### SEV-2 (core path broken; one refund layer down)

- [ ] Notify the team lead within 30 minutes.
- [ ] Apply `sev-2` label.
- [ ] Update the GitHub issue every hour until resolved.

### External communications

- [ ] Only the incident commander or designated communications lead posts
      public-facing updates (Discord announcements, status page).
- [ ] Do not confirm or deny specific order details in public channels.
- [ ] Do not state that "funds are safe" until on-chain state has been
      independently verified in Step 3.

---

## Step 9 — Resolution and postmortem trigger

**When the incident is resolved:**

- [ ] Verify resolution on-chain: the affected order(s) show `Claimed` or
      `Refunded` status in the contract, not just in the coordinator.
- [ ] Verify service health: both coordinator and relayer `/readyz` return `ok`.
- [ ] Record the resolution time in UTC: `____-__-__T__:__Z`
- [ ] Post a resolution summary in the incident Slack thread and close it.
- [ ] Update the GitHub issue to `resolved`; remove `needs-triage`.
- [ ] Apply `postmortem-required` label if severity was SEV-1 or SEV-2.
- [ ] Close the GitHub issue only after the postmortem tracking issue is opened
      (see [postmortem/WORKFLOW.md § Phase 1](postmortem/WORKFLOW.md#phase-1--trigger)).

**Postmortem deadlines (from resolution time):**

| Milestone | Deadline |
|---|---|
| Postmortem tracking issue opened | Within 24 hours |
| Draft completed | Within 5 business days |
| PR reviewed and merged | Within 8 business days |

---

## Periodic validation

This checklist and the runbooks it references must stay accurate. Assign an
owner and schedule review at a regular cadence.

| Item | Frequency | Owner |
|---|---|---|
| Verify all command examples in this file still work against the current deployment | Monthly | On-call rotation lead |
| Confirm contract addresses in Step 3 match production deployment records | On every contract deployment | Contracts team |
| Review this checklist against any new refund layer or service change | On every SEV-1/SEV-2 postmortem merge | Incident commander |
| Confirm links to SAFE_RECOVERY_GUIDE, BUG_TRIAGE, DEPLOYMENT_ROLLBACK_RUNBOOK are not broken | Quarterly | Platform team |

---

## Related documents

- [Bug Triage Guide](BUG_TRIAGE.md) — classify and route a report before this checklist
- [Safe Recovery Guide](SAFE_RECOVERY_GUIDE.md) — user-facing on-chain refund and claim steps
- [Deployment Rollback Runbook](DEPLOYMENT_ROLLBACK_RUNBOOK.md) — service restart and rollback procedures
- [Postmortem Workflow](postmortem/WORKFLOW.md) — what to do after the incident is resolved
- [Postmortem Template](postmortem/TEMPLATE.md) — fill-in-the-blank postmortem document
- [Operations Guide](OPERATIONS.md) — full operator reference including chain-specific runbooks
- [Health Dashboard](HEALTH_DASHBOARD.md) — system health indicators and alert thresholds
