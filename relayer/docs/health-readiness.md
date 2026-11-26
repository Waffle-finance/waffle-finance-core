# Relayer health and readiness

This document explains how to read the relayer's `/healthz`, `/readyz`, and
`/health` endpoints, and how to tell a degraded chain node apart from a
degraded order-processing service.

## Endpoints

| Endpoint  | Purpose                         | HTTP status                                   |
|-----------|--------------------------------|-----------------------------------------------|
| `/healthz`| Liveness — process is alive    | Always 200 while the event loop runs           |
| `/readyz` | Readiness — dependencies up    | 200 when all configured deps pass, else 503   |
| `/health` | Detailed health for dashboards | 200 (healthy/degraded) or 503 (unhealthy)     |

`/healthz` and `/readyz` are the orchestrator (K8s/ECS) probes. `/health` is
for operators and dashboards.

## Per-chain dependency details (`/readyz`)

Each `/readyz` check is enriched with per-dependency fields so a single
aggregate status does not hide which provider or chain is degraded (#1084):

```jsonc
{
  "status": "degraded",
  "checks": [
    {
      "name": "ethereum_rpc",
      "ok": false,
      "detail": "connection_error",
      "latencyMs": 12,
      "kind": "rpc_connectivity",      // chain RPC vs order-processing
      "lastSuccessAt": 1700000000000,   // last healthy probe (ms)
      "lastSuccessAgeMs": 5400,         // age of the last healthy probe
      "lastFailureReason": "connection_error",  // bounded, redacted
      "consecutiveFailures": 1
    },
    {
      "name": "stellar_rpc",
      "ok": true,
      "detail": "ok",
      "kind": "rpc_connectivity",
      "lastSuccessAt": 1700000005400,
      "lastSuccessAgeMs": 0,
      "lastFailureReason": null,
      "consecutiveFailures": 0
    },
    {
      "name": "coordinator",
      "ok": true,
      "detail": "ok",
      "kind": "order_processing",
      "staleness_seconds": 0,
      "safe_mode": false
    }
  ]
}
```

### `kind`

- `rpc_connectivity` — the check probes a chain node (Ethereum, Stellar
  Horizon, Soroban, Solana). A failure here means the relayer cannot observe
  or submit to that chain.
- `order_processing` — the check probes the coordinator, which owns the order
  book and dispatch decisions. A failure here means settlement actions should
  be blocked even if every chain node is reachable.

### `lastSuccessAt` / `lastSuccessAgeMs`

When a dependency is currently failing, `lastSuccessAt` reports the last time
it was healthy. Use this to answer "how long has this chain been degraded?"
without re-reading logs. A `503` service is **not** idle: `lastSuccessAgeMs`
tells you when it last worked.

### `lastFailureReason`

A bounded, redacted category (`connection_error`, `timeout`, `http_503`,
`not_configured`, `disabled_placeholder`, `unreachable`, or the coordinator
safe-mode reason). Long hex strings and URL credentials are stripped so no
secret is ever disclosed in a health response.

## Probes are read-only

Every readiness probe issues a read-only call:

- Ethereum / Soroban / Solana → `eth_blockNumber` / `getHealth` / `getHealth`
  (JSON-RPC reads).
- Stellar → `GET /` on the Horizon root.
- Coordinator → `GET /healthz`.

No probe issues `eth_sendTransaction` or any state-changing call, so hitting
`/readyz` repeatedly cannot move funds or change on-chain state.

## Dashboards and runbooks

- Alert on `ok=false` **and** `consecutiveFailures >= N` for a dependency,
  not on the aggregate `/readyz` 503 alone — the aggregate hides which chain
  is down.
- Use `kind` to route the alert: `rpc_connectivity` → on-call for that chain;
  `order_processing` → coordinator on-call.
- Use `lastSuccessAgeMs` in the alert text ("Ethereum RPC degraded for 9m")
  so operators know the impact before paging.

## Secrets

No health response includes private keys, secrets, or `RELAYER_*` values.
`lastFailureReason` is redacted and capped at 200 characters.
