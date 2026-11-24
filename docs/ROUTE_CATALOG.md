# Route Catalog

> **This file is generated.** Do not edit it directly.
> To update it, edit `scripts/route-catalog-meta.mjs` and run:
> ```bash
> node scripts/generate-route-catalog.mjs
> ```
> To validate without writing, run:
> ```bash
> node scripts/generate-route-catalog.mjs --check
> ```
> Adding a route without an entry in `route-catalog-meta.mjs` will cause
> `pnpm validate:routes` to fail.

_Generated at 2026-11-19T03:37:34.345Z_

---

## Table of contents

- [Authorization classes](#authorization-classes)
- [Health semantics](#health-semantics)
- [Coordinator](#coordinator)
- [Relayer](#relayer)
- [Resolver](#resolver)

---

## Authorization classes

| Class | Meaning |
|---|---|
| `public` | No authentication required; accessible to any caller. |
| `operator` | Requires a valid operator bearer token (`COORDINATOR_OPERATOR_KEYS` or `RELAYER_ADMIN_KEY`). |
| `rate-limited` | No token required, but subject to per-IP rate limiting. Resolvers with API keys bypass the limit. |
| `internal` | Intended for service-to-service calls; not exposed to end users. No token but should be firewalled. |

---

## Health semantics

| Value | Meaning |
|---|---|
| `liveness` | Container-orchestrator liveness probe; always returns 200 when the process is alive. |
| `readiness` | Readiness probe; returns 503 when any configured dependency is not ready. |
| `metrics` | Prometheus scrape endpoint. |
| `none` | Not a health endpoint. |

---

## Coordinator

| Method | Path | Auth | Health | Summary |
|---|---|---|---|---|
| `GET` | `/health` | Public | Liveness | Returns service status, reconciliation state, and Soroban listener staleness. |
| `GET` | `/healthz` | Public | Liveness | Lightweight liveness probe for load balancers; always 200 when the process is alive. |
| `GET` | `/readyz` | Public | Readiness | Readiness probe; returns 503 when any configured dependency check fails. |
| `GET` | `/metrics` | Operator token | Metrics | Prometheus metrics scrape endpoint; requires operator bearer token. |
| `POST` | `/api/orders/announce` | Rate-limited | — | Create a new coordinator order after validating the announce payload. |
| `GET` | `/api/orders/history` | Rate-limited | — | Paginated order history for a wallet address (cursor- or offset-based). |
| `GET` | `/api/orders/:id` | Rate-limited | — | Fetch a single order by its public ID. |
| `POST` | `/api/orders/:id/src-locked` | Operator token | — | Record that the source-chain HTLC has been locked; requires operator token. |
| `POST` | `/api/orders/:id/dst-locked` | Operator token | — | Record that the destination-chain HTLC has been locked; requires operator token. |
| `GET` | `/api/orders/:id/events` | Public | — | Server-Sent Events stream; pushes order state transitions to the client in real time. |
| `POST` | `/api/secrets/reveal` | Rate-limited | — | Record the revealed HTLC preimage for a completed order. |
| `GET` | `/api/secrets/:publicId` | Rate-limited | — | Retrieve the revealed preimage for an order by its public ID. |
| `GET` | `/api/quotes/eth-xlm` | Public | — | ETH/XLM exchange rate from the SWR price cache. |
| `GET` | `/api/quotes/eth-sol` | Public | — | ETH/SOL exchange rate from the SWR price cache. |
| `GET` | `/api/prices` | Public | — | Aggregated price feed (ETH, XLM, SOL) consumed by the BridgeForm frontend. |
| `POST` | `/admin/reconcile` | Operator token | — | Trigger an immediate chain-event reconciliation run outside the normal schedule. |
| `POST` | `/admin/stale-cleanup` | Operator token | — | Trigger an immediate stale-order cleanup run; archives orders past the retention window. |
| `POST` | `/admin/expire-now` | Operator token | — | Trigger an on-demand expiry scan; marks all timelock-elapsed orders as expired. |
| `GET` | `/admin/reconciliation-cursors` | Operator token | — | Return chain-level and per-order reconciler cursor state for operator observability. |
| `GET` | `/api/audit` | Public | — | Paginated query of the audit event stream with optional filters. |
| `GET` | `/api/audit/orders/:orderId` | Public | — | Full audit event timeline for a specific order, oldest-first. |
| `GET` | `/api/audit/orders/:orderId/timeline` | Public | — | Unified mutation timeline merging audit_log and order_events rows for one order. |
| `GET` | `/api/audit/orders/:orderId/validate` | Public | — | Validate that the stored audit sequence is consistent with the order state machine. |
| `GET` | `/api/audit/tail` | Public | — | Most recent N audit entries; useful for live monitoring dashboards. |
| `GET` | `/api/audit/export` | Public | — | Stream the full audit log as NDJSON with optional filters and incremental cursor. |
| `GET` | `/api/export/orders/:orderId` | Operator token | — | Export a single order's full lifecycle in structured JSON. |
| `POST` | `/api/export/orders` | Operator token | — | Bulk export multiple orders matching supplied filters. |
| `GET` | `/api/orders/export` | Operator token | — | User-facing download endpoint; returns JSON or CSV attachment with optional date/status filters. |

_Source: see `coordinator/src/` routes directory_

---

## Relayer

| Method | Path | Auth | Health | Summary |
|---|---|---|---|---|
| `GET` | `/healthz` | Public | Liveness | Liveness probe; always 200 when the relayer process is alive. |
| `GET` | `/readyz` | Public | Readiness | Readiness probe; probes Ethereum RPC, Stellar Horizon, Soroban RPC, Solana RPC, and coordinator. |
| `GET` | `/health` | Public | Liveness | Detailed health payload from the UptimeMonitor for dashboards; 503 when unhealthy. |
| `GET` | `/metrics` | Public | Metrics | Prometheus metrics scrape endpoint (no auth — restrict at the network layer). |
| `POST` | `/api/wake` | Public | — | Mark a visitor as present to keep site-presence cache alive; returns 204. |
| `GET` | `/api/wake` | Public | — | Mark a visitor as present (GET variant); returns 204. |
| `GET` | `/api/prices` | Public | — | Real-time ETH/XLM price snapshot from the relayer pricing service. |
| `GET` | `/api/support` | Public | — | Returns the current support policy (which swap routes are enabled). |
| `POST` | `/api/transactions/history` | Public | — | Returns in-memory order history filtered by ETH or Stellar address. |
| `POST` | `/api/orders/create` | Public | — | Create a new bridge order (ETH→XLM or XLM→ETH); returns approval transaction data. |
| `POST` | `/api/orders/process` | Public | — | Process an approved bridge order; verifies Stellar payment and releases ETH. |
| `POST` | `/api/orders/xlm-to-eth` | Public | — | Complete an XLM→ETH swap by verifying Stellar TX and sending ETH to the user. |
| `POST` | `/api/orders/manual-refund` | Public | — | Manually trigger an XLM refund for a failed or stuck order. |
| `GET` | `/api/escrow/info` | Public | — | Returns escrow factory address and method info for the current network. |
| `GET` | `/api/debug/chain-monitor` | Internal | — | Debug: returns chain-monitor state and active order status counts. |
| `GET` | `/api/settlement/status` | Public | — | Returns a snapshot of all settlement records and per-state counts. |
| `GET` | `/api/settlement/status/:orderId` | Public | — | Returns the settlement record for a specific order. |
| `POST` | `/api/settlement/recover/:orderId` | Operator token | — | Manually trigger reconciliation for a specific order; operator-only in production. |
| `POST` | `/api/settlement/reconcile` | Operator token | — | Trigger a full reconciliation sweep across all non-terminal settlement records. |
| `POST` | `/api/admin/authorize-relayer` | Operator token | — | Authorize the relayer address as a resolver in the EscrowFactory contract. |
| `GET` | `/api/admin/relayer-status` | Operator token | — | Check whether the relayer address is currently authorized as a resolver. |
| `GET` | `/api/admin/resolvers` | Operator token | — | List all known resolver addresses and their authorization status. |
| `GET` | `/api/admin/settlement-failures` | Operator token | — | List settlement failure records with optional status filter and limit. |
| `GET` | `/api/admin/settlement-failures/:orderId` | Operator token | — | Return the full failure record for a specific order. |

_Source: see `relayer/src/` routes directory_

---

## Resolver

| Method | Path | Auth | Health | Summary |
|---|---|---|---|---|
| `GET` | `/metrics` | Public | Metrics | Prometheus metrics scrape endpoint for the resolver (no auth — restrict at network layer). |

_Source: see `resolver/src/` routes directory_

---

## Related documentation

- [API Versioning Guide](../coordinator/docs/API_VERSIONING.md) — Accept-header versioning strategy and v1/v2 migration guide
- [Integration Guide](../coordinator/docs/INTEGRATION_GUIDE.md) — Full request/response schemas and typical integration flow
- [Operations Guide](OPERATIONS.md) — Deployment, runbooks, and incident response
