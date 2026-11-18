# Relayer External Dependency Boundaries

This document traces every runtime dependency the relayer service has on
external providers and internal services, covering: the environment variable
that configures it, criticality, fallback behaviour, and what happens when
the dependency degrades.

For the full startup procedure see [`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](DEPLOYMENT_ROLLBACK_RUNBOOK.md).
For the smoke-test checklist see [`docs/SMOKE_TEST_CONTRACT.md`](SMOKE_TEST_CONTRACT.md).

---

## Startup validation

The relayer performs two levels of validation before accepting any traffic:

1. **Static env-var validation** (`relayer/src/config-validator.ts`): validates
   format and presence of all required variables at process startup.  Fails
   fast with a human-readable error list when any required variable is absent or
   placeholder.

2. **Live dependency health-check** (`relayer/src/startup-health-check.ts`):
   issues HTTP probe requests to the coordinator and (optionally) the resolver
   registry before the HTTP server opens.  Uses exponential back-off with
   configurable max retries and exits gracefully if dependencies are
   unavailable.

---

## Dependency table

| Dependency | Env var | Criticality | Startup behaviour | Runtime degradation |
|---|---|---|---|---|
| Ethereum JSON-RPC | `ETHEREUM_RPC_URL` | **Critical** | Validated at startup (format + placeholder check). Fails fast if absent. Chain monitoring is lazy — RPC is not contacted until the first swap order arrives. | Swap orders that require on-chain writes fail individually. Inflight orders are retried. The `/readyz` endpoint probes `eth_blockNumber` and returns 503 if RPC is unreachable. |
| Stellar Horizon REST | `STELLAR_HORIZON_URL` | **Critical** | Validated at startup (format + placeholder check). | XLM payment operations fail and are retried via `refundXlmToUser` with exponential back-off. The `/readyz` endpoint probes `GET /` on Horizon. |
| Coordinator (order-book) | `COORDINATOR_URL` | **Critical** | Validated at startup (format + placeholder check). Live HTTP probe (`GET /readyz`) before the relayer opens for traffic. Retries with exponential back-off (configurable via `RELAYER_STARTUP_MAX_RETRIES`, `RELAYER_STARTUP_BACKOFF_BASE_MS`, `RELAYER_STARTUP_BACKOFF_MAX_MS`). Exits gracefully if max retries exceeded. | Orders cannot be announced or confirmed. The refund watchdog continues to operate on locally-known orders. |
| Resolver registry | `RESOLVER_REGISTRY_URL` | **Optional** | If set, probed via `GET /healthz` at startup (same back-off retry as coordinator). If not set, check is skipped. | Without a registered resolver, bridge orders are accepted but may not be settled by a counterparty. The relayer itself does not require a resolver to function. |
| CoinGecko price API | `https://api.coingecko.com` | **Optional** | Not checked at startup. | Falls back to hardcoded fallback prices (`xlmUsd=0.12`, `ethUsd=3500`) via a 15 s fresh / 60 s stale-while-revalidate cache. Bridge orders continue to be accepted at the fallback rate. |
| Relayer Ethereum signing key | `RELAYER_PRIVATE_KEY` | **Critical** | Validated at startup (zero-key and placeholder check). | Cannot submit ETH transactions. Settlement failures are returned as HTTP 500 on order-processing endpoints. |
| Relayer Stellar signing secret | `RELAYER_STELLAR_SECRET` | **Critical** | Validated at startup (format and placeholder check). | Cannot submit Stellar transactions. XLM leg of bridge orders fails; the watchdog retries XLM refunds with `refundXlmToUser`. |
| Solana RPC | `SOLANA_RPC_URL` | **Optional** | Checked at startup (`logSolanaStatus`). Emits a warning metric (`solana_placeholder_mode=1`) when not configured or placeholder. | Solana settlement is disabled (simulation mode). ETH↔XLM routes are unaffected. |
| Anchor HTLC program | `SOLANA_HTLC_PROGRAM` | **Optional** | See Solana RPC row above. | See Solana RPC row above. |
| Soroban JSON-RPC | `SOROBAN_RPC_URL` | **Optional** | Not validated at startup (Soroban used by resolver, not directly by relayer). | Affects resolver-side settlement. Relayer `/readyz` probes `getHealth` on the Soroban RPC if configured. |

---

## Startup env-var validation

The following variables are checked by `validateRelayerStartup()` at startup.
Missing or placeholder values produce a collected error list that is printed to
stderr and causes the process to exit before accepting any traffic.

### Required (process exits if missing or placeholder)

| Variable | Format | Notes |
|---|---|---|
| `ETHEREUM_RPC_URL` | `http(s)://...` | Ethereum JSON-RPC endpoint (Sepolia for testnet, mainnet for production) |
| `STELLAR_HORIZON_URL` | `http(s)://...` | Stellar Horizon REST API endpoint |
| `RELAYER_PRIVATE_KEY` | `0x` + 64 hex chars | Ethereum private key for signing relayer transactions |
| `RELAYER_STELLAR_SECRET` | `S` + 55 base32 chars | Stellar secret key for signing Stellar transactions |
| `COORDINATOR_URL` | `http(s)://...` | Base URL of the coordinator order-book service |

### Optional (warning logged if absent)

| Variable | Format | Default / fallback |
|---|---|---|
| `RESOLVER_REGISTRY_URL` | `http(s)://...` | Startup health-check skipped if not set |
| `SOLANA_RPC_URL` | `http(s)://...` | Solana settlement disabled (simulation mode) |
| `SOLANA_HTLC_PROGRAM` | Base58 program ID | Solana settlement disabled (simulation mode) |
| `RELAYER_ADMIN_API_KEY` | Any string | Admin endpoints deny all requests if not set |
| `NETWORK_MODE` | `testnet` \| `mainnet` | Defaults to `testnet` |

---

## Startup back-off configuration

The live dependency health-check loop is configurable via env vars:

| Variable | Type | Default | Description |
|---|---|---|---|
| `RELAYER_STARTUP_MAX_RETRIES` | integer | `10` | Max attempts before giving up |
| `RELAYER_STARTUP_BACKOFF_BASE_MS` | integer | `2000` | Base delay in ms for first retry |
| `RELAYER_STARTUP_BACKOFF_MAX_MS` | integer | `30000` | Maximum delay cap in ms |

The delay grows as `baseMs × 2^attempt` with ±10 % jitter, capped at
`backoffMaxMs`.  After `maxRetries` failed attempts the process exits with a
clear error message listing every failing dependency.

---

## Degradation behaviour at runtime

### Ethereum RPC degraded

The chain monitor (`startAdaptivePoll`) uses exponential back-off on failed
ticks and recovers automatically when the RPC becomes available again.
Inflight orders that required an on-chain write are retried.  The `/readyz`
endpoint returns 503 while the RPC is unreachable so Kubernetes/ECS will stop
routing new traffic.

### Stellar Horizon degraded

`refundXlmToUser` classifies Horizon errors as transient or terminal using
`classifyHorizonError`.  Transient errors (network timeouts, rate limits)
are retried with exponential back-off.  `HorizonTimeoutError` marks the
refund as ambiguous so the watchdog can re-examine it later.  Terminal errors
(bad request, account not found) surface immediately as operational errors and
are not retried.

### Coordinator unreachable at runtime

The relayer accepts orders into its local in-memory store and attempts to
announce them to the coordinator.  If the coordinator is down, the watchdog
continues to operate on locally-known stale orders.  New orders cannot be
discovered or matched until the coordinator recovers.

### CoinGecko degraded

The SWR price cache has two tiers:

- **Fresh** (< 15 s since last fetch): cached price is served directly.
- **Stale** (15 s – 60 s): cached price is served immediately; background
  refresh is triggered.
- **Expired** (> 60 s): the next caller blocks on a new fetch; if CoinGecko
  returns a non-2xx response or times out, the hardcoded fallback price is
  used (`XLM = $0.12`, `ETH = $3 500`).

---

## References

- [`relayer/src/config-validator.ts`](../relayer/src/config-validator.ts) — startup env-var validation
- [`relayer/src/startup-health-check.ts`](../relayer/src/startup-health-check.ts) — live dependency health-check with back-off retry
- [`relayer/src/routes/health.ts`](../relayer/src/routes/health.ts) — `/readyz` runtime probe
- [`relayer/src/services/xlm-refund.ts`](../relayer/src/services/xlm-refund.ts) — Stellar Horizon degradation handling
- [`relayer/src/services/refund-watchdog.ts`](../relayer/src/services/refund-watchdog.ts) — stale-order rescue
- [`docs/RPC_DEGRADATION_TEST_MATRIX.md`](RPC_DEGRADATION_TEST_MATRIX.md) — full RPC degradation test matrix
