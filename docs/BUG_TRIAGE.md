# Bug Triage Guide

This guide explains how to classify, prioritise, and route bug reports for WaffleFinance. It applies to issues filed on GitHub, reports surfaced in Discord, and anomalies detected by the on-call engineer. For incidents that have already resolved, follow the postmortem process in [docs/postmortem/WORKFLOW.md](postmortem/WORKFLOW.md).

---

## Table of contents

- [Severity levels](#severity-levels)
- [Triage workflow](#triage-workflow)
- [Routing by component](#routing-by-component)
- [Labels](#labels)
- [Escalation path](#escalation-path)
- [Funds-at-risk checklist](#funds-at-risk-checklist)

---

## Severity levels

Severity determines response time and escalation, not feature priority.

| Severity | Criteria | Initial response | Escalation |
|---|---|---|---|
| **SEV-1** | Funds at risk or inaccessible; all refund layers down; active data loss | Immediate — page on-call | Incident commander within 15 min |
| **SEV-2** | Core swap path broken; coordinator or relayer down; one refund layer non-functional | Within 1 hour | Team lead within 30 min |
| **SEV-3** | Partial degradation; single chain affected; non-critical service errors | Within 1 business day | Assigned engineer |
| **SEV-4** | Minor issue; cosmetic bug; monitoring / tooling failure; no user impact | Within 1 week | Normal backlog |

When in doubt, assign the **higher** severity and downgrade after investigation.

---

## Triage workflow

### Step 1 — Receive and acknowledge

When a new bug report arrives:

1. Add the `needs-triage` label immediately.
2. Post an acknowledgement comment within the SLA window for its estimated severity.
3. Do **not** close or dismiss reports without investigation, even if they seem unlikely.

### Step 2 — Reproduce

Before assigning severity, attempt to reproduce the issue:

```bash
# Check coordinator health
curl http://localhost:3001/health

# Check chain monitoring status
curl http://localhost:3001/api/debug/chain-monitor | jq

# Check relayer health
curl http://localhost:3001/api/health
```

- If the report includes an order ID, look it up in the coordinator.
- If the report includes a transaction hash, check the block explorer.
- If you cannot reproduce, ask the reporter for logs, wallet address, or order ID before assigning severity.

### Step 3 — Apply the funds-at-risk checklist

For any report that might involve locked funds, work through the [funds-at-risk checklist](#funds-at-risk-checklist) before assigning severity.

### Step 4 — Assign severity and owner

- Assign the appropriate `sev-1` through `sev-4` label.
- Remove `needs-triage`.
- Assign an owner. Unowned issues do not get resolved.
- For SEV-1 and SEV-2: open a dedicated incident Slack thread or GitHub discussion immediately.

### Step 5 — Track to resolution

- Update the issue with findings as investigation progresses.
- If the issue escalates in severity, re-label and page accordingly.
- Close only when the fix is merged, deployed, and verified.

### Step 6 — Trigger postmortem (SEV-1 and SEV-2)

Any SEV-1 or SEV-2 incident that has resolved must have a postmortem opened within 24 hours. See [Postmortem workflow](postmortem/WORKFLOW.md).

---

## Routing by component

| Symptom | Component | Who to notify |
|---|---|---|
| Swap stuck in `src_locked` | Coordinator, Relayer | Relayer on-call |
| Secret not relayed between chains | Relayer / SecretService | Relayer on-call |
| On-chain HTLC claim fails | Smart contracts (Ethereum / Stellar / Solana) | Contracts team |
| `refundOrder` reverts | Smart contracts | Contracts team |
| Frontend showing wrong state | Frontend, SDK state machine | Frontend team |
| Coordinator API returning 5xx | Coordinator, Database | Backend on-call |
| Resolver not filling orders | Resolver, ResolverRegistry | Resolver team |
| RPC errors (Infura / Alchemy) | External dependency | RPC provider + Backend on-call |
| Monitoring / metrics broken | Observability | Platform team |

---

## Labels

Apply these labels when triaging. Add them to the issue; do not rely on the title alone.

| Label | Meaning |
|---|---|
| `needs-triage` | Newly filed; not yet reviewed |
| `sev-1` | Funds at risk or inaccessible |
| `sev-2` | Core path broken |
| `sev-3` | Partial degradation |
| `sev-4` | Minor / cosmetic |
| `bug` | Confirmed defect |
| `regression` | Worked before; broken by a recent change |
| `contracts` | Affects Solidity or Soroban contracts |
| `coordinator` | Affects the coordinator service |
| `relayer` | Affects the relayer service |
| `resolver` | Affects the resolver |
| `frontend` | Affects the frontend dApp |
| `sdk` | Affects `@wafflefinance/sdk` |
| `funds-at-risk` | Confirmed or suspected user funds at risk |
| `postmortem-required` | Incident resolved; postmortem must be filed |

---

## Escalation path

```
Reporter (Discord / GitHub)
        │
        ▼
  On-call engineer
  ├─ SEV-1/SEV-2 ──▶ Team lead (page immediately)
  │                         │
  │                         ▼
  │               Incident commander assigned
  │               (coordinates response via WORKFLOW.md)
  │
  └─ SEV-3/SEV-4 ──▶ Assigned engineer (normal sprint cycle)
```

For SEV-1, if the on-call engineer cannot be reached within 15 minutes, escalate to the team lead directly. Do not wait.

---

## Funds-at-risk checklist

Run this checklist for any report that could involve locked user funds. Answer every question before assigning severity.

- [ ] Is there an open order that cannot be claimed or refunded?
- [ ] Has the HTLC timelock expired? (If yes, anyone can call `refundOrder` directly.)
- [ ] Is the on-chain HTLC claim function reverting?
- [ ] Is the `refundOrder` function reverting?
- [ ] Is the pull-payment `withdraw()` balance non-zero and inaccessible?
- [ ] Are all four refund layers non-functional simultaneously? (See [README — Refund layers](../README.md#refund-layers))
- [ ] Has the user tried calling `refundOrder` directly from their wallet?

If any of the first five questions is "yes" and the user cannot self-serve a refund, classify as **SEV-1** and escalate immediately.

If the HTLC timelock has not yet expired, the user is not yet at risk — the timelock provides a hard backstop. Document the expiry time and monitor.

---

## Related documents

- [Postmortem workflow](postmortem/WORKFLOW.md) — process for writing a postmortem after a resolved incident
- [Postmortem template](postmortem/TEMPLATE.md) — fill-in-the-blank template for postmortems
- [Incident response runbooks](OPERATIONS.md#incident-response) — step-by-step remediation for known failure modes
- [Health Dashboard](HEALTH_DASHBOARD.md) — system health indicators
