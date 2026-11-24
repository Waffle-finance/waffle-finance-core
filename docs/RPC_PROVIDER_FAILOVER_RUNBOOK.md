<!-- owner: Operations; subject: chain-specific RPC provider failover, verification and rollback -->
# RPC provider failover runbook

This runbook covers switching an Ethereum, Soroban, or Solana RPC provider
without changing chain identity or durable listener cursors. Treat an endpoint
switch as a change of transport, never as a reason to reset a cursor. If the
chain identity check fails, stop: the replacement is a different network.

RPC outages affect listener progress and transaction submission differently:

| Service | RPC configuration | Restart behavior |
| --- | --- | --- |
| Coordinator (listeners) | `SEPOLIA_RPC_URL` / `MAINNET_RPC_URL` / `ETHEREUM_RPC_URL`, `SOROBAN_RPC_URL`, `SOLANA_RPC_URL` | Listener clients are built from the process environment at startup. A provider change requires a rolling restart of the coordinator; `/readyz` probes current configuration on each request. |
| Relayer (transaction submission) | `ETHEREUM_RPC_URL`, `SOROBAN_RPC_URL`, `SOLANA_RPC_URL` | Signing/submission clients and chain IDs are initialised at startup. Restart the relayer after changing URLs; `/readyz` probes the current environment per request. |
| Resolver (listeners) | Chain RPC environment from its service configuration | Listener and retry state are process-local. Restart after switching URL; `/telemetry` is the progress signal (it deliberately does not live-probe RPC). |

Never edit a live process environment in place and assume the switch took
effect. Rotate credentials by adding a new secret/endpoint, verifying it,
then removing the old credential only after rollback windows have passed. Do
not put API keys in shell history, tickets, logs, or health output.

## 1. Pre-switch baseline (all chains)

Set only non-secret base URLs in your shell (for example from your secret
manager's `print` command); never echo the resulting value:

```bash
export COORD=http://localhost:3001
export RELAYER=http://localhost:3002
export RESOLVER=http://localhost:3003

curl -fsS "$COORD/readyz" > /tmp/coord-ready-before.json
curl -fsS "$RELAYER/readyz" > /tmp/relayer-ready-before.json
curl -fsS "$RESOLVER/health" > /tmp/resolver-health-before.json
curl -fsS "$COORD/metrics" | grep -E 'coordinator_(listener_last_block|listener_head_block|listener_cursor_resets_total|reconciliation_cursor_lag)' > /tmp/cursors-before.txt
```

Record the chain values shown by `/readyz` and the per-chain cursor values in
`/tmp/cursors-before.txt`. `/telemetry` on the resolver shows
`connected|degraded|stale|inactive` plus last-progress/failure state; capture
it before switching as well:

```bash
curl -fsS "$RESOLVER/telemetry" > /tmp/resolver-telemetry-before.json
```

## 2. Verify replacement endpoint identity (before switching)

Use a secret-manager-injected URL variable (`$NEW_ETH_RPC_URL`,
`$NEW_SOROBAN_RPC_URL`, `$NEW_SOLANA_RPC_URL`) so the full credential-bearing
URL is never printed. Compare with the value recorded in step 1 or the
configured deployment chain/network.

Ethereum — `eth_chainId` must match the expected decimal chain ID (1 for
mainnet, 11155111 for Sepolia):

```bash
curl -fsS -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "$NEW_ETH_RPC_URL"
```

Soroban — `getNetwork` must return the expected network passphrase (never
accept a passphrase that differs by even one character), and the response must
not be a JSON-RPC `error` envelope:

```bash
curl -fsS -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork","params":[]}' \
  "$NEW_SOROBAN_RPC_URL"
```

Solana — `getGenesisHash` must match the expected genesis hash for mainnet,
devnet, or the local validator in use:

```bash
curl -fsS -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash","params":[]}' \
  "$NEW_SOLANA_RPC_URL"
```

Endpoint compatibility checks: confirm the endpoint serves JSON-RPC 2.0, is
not an HTTP 200 error envelope, supports the event/transaction methods the
service uses, and is not a rate-limited shared tier that cannot sustain our
poll rate. Keep the old endpoint warm and available for rollback. If a
provider requires key rotation, issue the new key first and verify identity
with it; revoke the old key only after step 5 succeeds.

## 3. Switch

1. Deploy the new endpoint URL/credential via the normal secret/config rollout.
2. Restart the affected service(s) with the new environment (coordinator and
   relayer first; resolver listeners after their config is updated). Do not
   clear database cursors, checkpoint tables, or listener state directories.
3. If using local provider stubs to rehearse, see
   [`RPC_DEGRADATION_TEST_MATRIX.md`](RPC_DEGRADATION_TEST_MATRIX.md#provider-failover-stub-rehearsal).

## 4. Post-switch health and cursor verification

```bash
curl -fsS "$COORD/readyz" > /tmp/coord-ready-after.json
curl -fsS "$RELAYER/readyz" > /tmp/relayer-ready-after.json
curl -fsS "$RESOLVER/health" > /tmp/resolver-health-after.json
curl -fsS "$RESOLVER/telemetry" > /tmp/resolver-telemetry-after.json
curl -fsS "$COORD/metrics" | grep -E 'coordinator_(listener_last_block|listener_head_block|listener_cursor_resets_total|reconciliation_cursor_lag)' > /tmp/cursors-after.txt
```

Checks that must pass:

- Every chain entry in both `/readyz` payloads has `ok: true` and the same
  chain identity checked in step 2. The aggregate status must not be
  `degraded`.
- `/metrics` shows each listener's last processed block/ledger/slot at or
  above the pre-switch baseline, with `listener_lag_blocks` and
  `reconciliation_cursor_lag` stable or falling. A brief replay-window
  increase after restart is expected; it must settle.
- `coordinator_listener_cursor_resets_total` and Soroban
  `stale_cursor`/`ledger_gap` resets must not increase. If they do, the
  endpoint is inconsistent: roll back.
- Resolver `/telemetry` returns to the pre-switch state (normally
  `connected`) and its last-progress timestamp advances. Do not reset its
  listener state to force this.
- Transaction submission succeeds on a canary order for each affected chain.

## 5. Rollback

If identity, health, or cursor checks fail: restore the previous
endpoint/credential from the secret manager, restart the affected services
again **without touching durable cursors**, and re-run section 4. A cursor that
moved backwards is not itself a reason to reset it — the reconciler and
replay path will catch up from the durable high-water mark. Report the
offending metric name and failing chain (not the endpoint URL) in the incident
ticket.
