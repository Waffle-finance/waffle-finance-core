# Core Service Health

Operators can use the dashboard package to aggregate health for the core
services:

- `GET /dashboard/health` summarizes coordinator, relayer, and resolver state.
- `GET /dashboard/liveness` checks whether each process is reachable.
- `GET /dashboard/readiness` checks dependency readiness across services.

Each service exposes the same basic contract:

- `GET /health` returns an operator summary. It is `healthy`, `degraded`, or
  `unhealthy`.
- `GET /healthz` returns process liveness. It does not fail because a database,
  RPC, or listener dependency is down.
- `GET /readyz` returns dependency checks and uses HTTP 503 when the service is
  live but not ready to do useful work.

## Dependency Failure Behavior

Coordinator readiness covers the database, Ethereum RPC, Soroban RPC, Solana
RPC, and reconciliation status. Failed dependencies produce `status:
"degraded"` with per-check details.

Relayer readiness covers Ethereum and Stellar network connectivity reported by
the uptime monitor, plus registered internal services. Failed dependencies
produce `status: "degraded"` while `/healthz` remains `ok`.

Resolver readiness covers required Ethereum and Soroban runtime configuration
and supervisor state. Missing chain configuration or a stopped supervisor marks
readiness degraded.

The dashboard treats unreachable services as `unhealthy`, live services with
failing readiness as `degraded`, and `status: "ok"` from service endpoints as
`healthy`.
