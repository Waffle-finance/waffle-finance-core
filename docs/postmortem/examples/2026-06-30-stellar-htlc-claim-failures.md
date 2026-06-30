# Incident Postmortem — 2026-06-30: Stellar HTLC Claim Failures After Soroban RPC Timeout

## Incident overview

| Field | Value |
|---|---|
| **Title** | Stellar HTLC `claim_order` calls reverted for ~2 h due to Soroban RPC endpoint returning stale ledger state |
| **Date** | 2026-06-30 |
| **Detection time** | 07:14 UTC |
| **Resolution time** | 09:28 UTC |
| **Duration** | 2 h 14 min |
| **Severity** | SEV-2 |
| **Affected systems** | Relayer (Stellar secret relay), Coordinator (order state machine), Stellar HTLC contract |
| **Affected chains** | Stellar (Ethereum leg unaffected) |
| **Incident commander** | @alice |
| **Authors** | @alice, @bob |
| **Status** | Final |

---

## Summary

From 07:00 to 09:28 UTC on 2026-06-30, the Soroban RPC endpoint (`soroban-testnet.stellar.org`) returned stale ledger data following a brief network partition. The relayer's Stellar HTLC client submitted `claim_order` transactions referencing outdated ledger entries, causing them to revert with `CONTRACT_CALL_FAILED`. During the window, 11 ETH-to-XLM swaps were unable to complete their destination claim. All 11 orders had valid HTLCs on both chains; no funds were lost. Eight orders self-resolved once the RPC recovered; three required manual relayer restart to re-process the claim.

---

## Impact

- **Users affected:** 11 users (all ETH-to-XLM swaps initiated between 06:45 and 07:15 UTC)
- **Orders affected:** 11 orders stuck in `dst_locked`; 0 orders lost or permanently failed
- **Funds at risk:** None — source-chain HTLCs (Ethereum) were not at risk; destination-chain HTLCs (Stellar) had unexpired timelocks and refunded permissionlessly had the relayer not recovered
- **Chains affected:** Stellar (Soroban RPC stale); Ethereum unaffected
- **Downtime:** Stellar swap completion path degraded for 2 h 14 min; ETH-to-XLM swaps did not settle during window; XLM-to-ETH swaps unaffected
- **Data loss:** None

---

## Timeline

| Time (UTC) | Event |
|---|---|
| 06:45 | Soroban testnet experiences brief network partition (detected retrospectively from ledger gap in explorer) |
| 07:00 | Relayer begins receiving `CONTRACT_CALL_FAILED` errors from Stellar HTLC claim calls |
| 07:00 | Relayer retries with exponential back-off; errors persist |
| 07:14 | Health check alert fires: `stellar_claim_errors_total > 5/min` |
| 07:16 | On-call engineer (@alice) acknowledges alert |
| 07:21 | @alice confirms claims are failing; identifies stale ledger entries in Soroban RPC responses |
| 07:35 | @alice attempts to switch `SOROBAN_RPC_URL` to backup endpoint (`soroban-rpc.stellar.expert`); backup also shows stale state |
| 07:48 | @alice escalates to @bob (Stellar contracts); determines stale state is network-wide, not endpoint-specific |
| 08:05 | Soroban testnet recovers — ledger gap closes (confirmed on Stellar Expert) |
| 08:10 | Primary RPC endpoint returns current ledger data |
| 08:14 | Relayer retries queued claims; 8 of 11 succeed automatically within 4 minutes |
| 08:18 | 3 claims remain stuck — relayer has exceeded retry budget and marked them `failed` internally |
| 08:45 | @bob identifies 3 stuck orders; manually requeues via coordinator `POST /orders/:id/retry` endpoint |
| 09:22 | All 3 remaining claims confirm on-chain |
| 09:28 | All 11 orders in `completed` state; incident declared resolved |

---

## Root cause

### Immediate cause

The Soroban RPC endpoint returned stale ledger entries following a ~15-minute network partition on the Stellar testnet. The relayer's `StellarHTLCClient` constructed `claim_order` transactions using a cached ledger sequence number that referenced a ledger entry that no longer existed after the partition resolved and the network replayed. Soroban contracts treat references to non-existent ledger entries as `CONTRACT_CALL_FAILED`.

### Contributing factors

1. **No RPC health pre-check before claim submission.** The relayer submits transactions without first verifying that the RPC's reported ledger height matches a live node. A stale RPC is indistinguishable from a live one until a transaction fails.

2. **Retry budget too conservative.** The relayer gives up after 5 retries with a 60-second max delay. The Soroban network partition lasted ~15 minutes, so the retry window expired before the network recovered. All 3 permanently-stuck orders hit the retry budget during the partition.

3. **No automatic re-queue after retry exhaustion.** Orders that exhaust the retry budget are marked `failed` in the relayer's internal state but remain `dst_locked` in the coordinator. There is no automated path to re-process them; an engineer must trigger the retry manually.

4. **Backup RPC endpoint is on the same network segment.** The fallback `SOROBAN_RPC_URL` points to a node that is also part of the testnet, so it experienced the same partition. A geographically or topologically diverse fallback would have caught this sooner.

---

## Detection

- **First signal:** `stellar_claim_errors_total > 5/min` alert at 07:14 UTC
- **Detection lag:** 14 minutes after the first failed claim (07:00 onset, 07:14 detection)
- **Detector:** Prometheus alert rule on the coordinator `/metrics` endpoint, routed to PagerDuty

Detection was reasonably fast. The 14-minute lag was acceptable given that timelocks provided a hard safety backstop during the window.

---

## Response

1. @alice acknowledged the alert and checked the coordinator health endpoint — all services reported healthy.
2. @alice checked relayer logs and found repeated `CONTRACT_CALL_FAILED` responses from Soroban RPC.
3. @alice compared the ledger sequence numbers in the failed transactions against the Stellar Expert block explorer and observed a gap — the RPC was behind by approximately 200 ledgers.
4. @alice updated `SOROBAN_RPC_URL` to the backup endpoint and restarted the relayer. The backup also returned stale data.
5. @alice escalated to @bob, who confirmed the stale state was network-wide based on Stellar's status page.
6. The team decided to wait for network recovery rather than attempt manual on-chain intervention.
7. Once the network recovered (08:05), @alice monitored relayer logs until 8 of 11 claims confirmed.
8. @bob identified the 3 stuck orders via coordinator query and manually triggered retry via the REST API.
9. All 3 confirmed on-chain within 40 minutes of the manual retry.

---

## Resolution

Network recovery at 08:05 UTC restored the RPC to current ledger state. The remaining 3 stuck orders were re-queued manually:

```bash
# Re-queue 3 stuck orders via coordinator API
curl -X POST http://localhost:3001/orders/ord_abc123/retry
curl -X POST http://localhost:3001/orders/ord_def456/retry
curl -X POST http://localhost:3001/orders/ord_ghi789/retry

# Confirm status
curl http://localhost:3001/orders/ord_abc123 | jq '.status'
# → "completed"
```

---

## What went well

- The `stellar_claim_errors_total` alert fired quickly (14-minute lag) and paged the right person.
- The HTLC safety model held: no funds were at risk at any point. Source-chain timelocks (Ethereum) were 24 h; destination-chain timelocks (Stellar) were 12 h. Neither came close to expiring.
- The coordinator `POST /orders/:id/retry` endpoint made manual recovery straightforward once the network recovered.
- @alice and @bob coordinated effectively — the escalation from primary to secondary on-call took under 30 minutes.

---

## What went wrong

- **No RPC liveness check before claim submission** — the relayer did not verify that the RPC was serving current ledger data, so it continued submitting doomed transactions for 14 minutes.
- **Retry budget expired before network recovered** — 5 retries × 60-second max delay = 5 minutes maximum coverage. The 15-minute partition exceeded this by 3×.
- **No automated re-queue after retry exhaustion** — manual intervention was required for 3 orders; this does not scale if a larger number of orders are affected.
- **Backup RPC not on a diverse topology** — the fallback endpoint was on the same network, making it useless for exactly the kind of failure that triggered this incident.

---

## Action items

| # | Action | Owner | Due | Issue |
|---|---|---|---|---|
| 1 | Add RPC liveness check (compare reported ledger height against a secondary source) before submitting Stellar HTLC transactions | @bob | 2026-07-14 | #183 |
| 2 | Increase relayer retry budget for Stellar claims to 30 min with jittered back-off | @alice | 2026-07-07 | #184 |
| 3 | Implement automatic re-queue in the relayer for orders that exhaust the retry budget — transition to a `pending_retry` state and re-attempt on next relayer restart | @alice | 2026-07-21 | #185 |
| 4 | Replace backup Soroban RPC with a geographically diverse endpoint (e.g., QuickNode or a self-hosted node on a different AS) | @charlie | 2026-07-14 | #186 |
| 5 | Add runbook entry to OPERATIONS.md for Stellar RPC stale-state recovery | @alice | 2026-07-07 | #187 |

---

## Lessons learned

The HTLC trust model performed exactly as designed — no funds were ever at risk, and all 11 orders eventually settled. The incident revealed that our operational resilience around the Stellar RPC layer is thin: a single RPC provider's 15-minute degradation cascaded into a 2-hour manual recovery window. The highest-leverage fixes are increasing the retry budget (immediately reduces blast radius for short outages) and adding automated re-queue (eliminates the need for manual intervention entirely). We should treat the Stellar RPC as an unreliable external dependency with its own failure budget and design the relayer accordingly.

---

## Appendix

### Relevant logs

```
# Relayer log excerpt — 07:00-07:14 UTC
{"time":"2026-06-30T07:00:12Z","level":"warn","component":"StellarHTLCClient","msg":"claim_order failed","orderId":"ord_abc123","error":"CONTRACT_CALL_FAILED","attempt":1}
{"time":"2026-06-30T07:01:22Z","level":"warn","component":"StellarHTLCClient","msg":"claim_order failed","orderId":"ord_abc123","error":"CONTRACT_CALL_FAILED","attempt":2}
{"time":"2026-06-30T07:03:40Z","level":"warn","component":"StellarHTLCClient","msg":"claim_order failed","orderId":"ord_def456","error":"CONTRACT_CALL_FAILED","attempt":1}
{"time":"2026-06-30T07:08:55Z","level":"error","component":"StellarHTLCClient","msg":"claim_order retry budget exhausted","orderId":"ord_abc123","attempts":5}
{"time":"2026-06-30T07:14:02Z","level":"error","component":"Metrics","msg":"stellar_claim_errors_total threshold exceeded","value":7,"threshold":5}

# Relayer log excerpt — 08:10-08:22 UTC (recovery)
{"time":"2026-06-30T08:10:30Z","level":"info","component":"StellarHTLCClient","msg":"claim_order succeeded","orderId":"ord_jkl012","txHash":"<hash>"}
{"time":"2026-06-30T08:14:07Z","level":"info","component":"StellarHTLCClient","msg":"claim_order succeeded","orderId":"ord_mno345","txHash":"<hash>"}
```

### Relevant transactions / contract calls

| Chain | Transaction | Notes |
|---|---|---|
| Stellar | `<ledger-gap-tx-hash>` | First failed claim at 07:00 UTC |
| Stellar | `<recovery-tx-hash-1>` | First successful claim post-recovery at 08:10 UTC |
| Stellar | `<manual-retry-tx-hash>` | Manually retried claim for ord_abc123 at 09:22 UTC |

### References

- [GitHub issue #183 — Add Soroban RPC liveness check](https://github.com/Waffle-finance/waffle-finance-core/issues/183)
- [GitHub issue #184 — Increase Stellar claim retry budget](https://github.com/Waffle-finance/waffle-finance-core/issues/184)
- [GitHub issue #185 — Automatic re-queue after retry exhaustion](https://github.com/Waffle-finance/waffle-finance-core/issues/185)
- [GitHub issue #186 — Diverse Soroban RPC fallback](https://github.com/Waffle-finance/waffle-finance-core/issues/186)
- [GitHub issue #187 — OPERATIONS.md runbook: Stellar RPC stale state](https://github.com/Waffle-finance/waffle-finance-core/issues/187)
- [Stellar Expert testnet explorer — ledger gap](https://stellar.expert/explorer/testnet)
- [HTLC refund layers — README](../../README.md#refund-layers)
- [Incident response runbooks — OPERATIONS.md](../../docs/OPERATIONS.md#incident-response)
