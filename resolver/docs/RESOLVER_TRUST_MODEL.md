# Resolver Trust Model — Blocking vs Non-Blocking Responsibilities

> Issue #768  
> Last updated: 2026-09-26  
> Maintainer: Engineering team  
> Related: `docs/ARCHITECTURE.md`, `resolver/src/supervisor.ts`, `resolver/src/health.ts`, `resolver/src/telemetry.ts`

This document defines exactly what the WaffleFinance resolver **does**, what it
**does not do**, and why the distinction matters to operators who run it.  The
core message is this: **the resolver is a non-custodial, non-authoritative
observer and relay assistant.  It can never steal funds, block settlement, or
unilaterally decide the outcome of a swap.**

---

## Table of contents

- [What the resolver is](#what-the-resolver-is)
- [Non-blocking responsibilities](#non-blocking-responsibilities)
- [Blocking responsibilities](#blocking-responsibilities)
- [What the resolver can never do](#what-the-resolver-can-never-do)
- [Trust model diagram](#trust-model-diagram)
- [Health and telemetry alignment](#health-and-telemetry-alignment)
- [Operational guidance](#operational-guidance)
- [Relationship to the protocol trust model](#relationship-to-the-protocol-trust-model)

---

## What the resolver is

The resolver is a **stateless listener-and-relay daemon**.  It has two jobs:

1. **Observe** on-chain HTLC events on the chains it is configured for
   (Ethereum, Stellar/Soroban, Solana).
2. **Relay** settlement data — primarily the revealed preimage — from the chain
   where it first appears to any chain that still needs it.

The resolver holds no order database, no user funds, and no veto over
settlement.  It is one of potentially many relayers that could carry out the
same relay step.  If the resolver is offline, a user can claim and refund
directly from their own wallet without resolver involvement.

---

## Non-blocking responsibilities

Non-blocking work is **observational and informational**.  A failure, crash, or
long pause in non-blocking work does not prevent any swap from settling
correctly.  At worst it delays progress until the resolver recovers or another
actor steps in.

| Responsibility | Description | Code location |
|----------------|-------------|---------------|
| **Event listening** | Subscribes to `OrderCreated`, `OrderClaimed`, `OrderRefunded` events on each configured chain. Advances the local cursor after every successful batch. | `src/listeners/ethereum.ts`, `src/listeners/soroban.ts`, `src/listeners/solana.ts` |
| **Preimage relay** | When a destination-leg `OrderClaimed` event reveals a preimage, the resolver submits a `claimOrder` transaction on the source chain using that preimage. This is advisory — the on-chain contract makes the final decision. | Driven by the `onOrderClaimed` callback in `src/commands/run.ts` |
| **Cursor persistence** | Saves the last-processed ledger/block cursor to disk so a restart can resume without replaying the full chain history. | `src/utils/cursor-store.ts` |
| **Deduplication** | Tracks a bounded window of recently-processed event keys to avoid double-dispatching after a restart-overlap. | `src/listeners/soroban.ts` (`dedupSet`) |
| **Registry status monitoring** | Polls `ResolverRegistry` to report whether this resolver's on-chain stake is active, low, or slashed. | `src/registry-status.ts` |
| **Metrics emission** | Publishes Prometheus counters and gauges for events observed, claims attempted, retry depth, staleness, and supervisor lifecycle state. | `src/metrics.ts` |
| **Telemetry classification** | Derives a coarse `connected / degraded / stale / inactive` state from raw metrics and exposes it on `GET /telemetry`. | `src/telemetry.ts` |
| **Health reporting** | Exposes `/healthz`, `/readyz`, `/health`, `/telemetry`, `/support` for orchestration systems. Readiness reflects config presence, not live RPC probe. | `src/health.ts` |
| **Support policy** | At startup, derives and logs the set of routes and actions this deployment can carry based on configured keys and addresses. Aborts if no route is actionable. | `src/support.ts` |

**Key property:** All non-blocking work is best-effort with respect to
settlement outcome.  The HTLC contracts enforce settlement purely through
hashlock verification and timelock expiry.  The resolver is a convenience, not
a requirement.

---

## Blocking responsibilities

Blocking work is **operationally critical** — it gates whether the resolver
starts at all, or whether a specific runtime path is attempted.  A blocking
failure is intentional and protects operators from silent misconfiguration.

| Responsibility | Description | Code location | Failure behaviour |
|----------------|-------------|---------------|-------------------|
| **Config validation** | Validates private key format and derives the signer address before any listener starts. Validates Ethereum chain ID and Soroban network passphrase against the live RPC endpoints. | `src/validation.ts`, called in `src/commands/run.ts` | `process.exit(1)` — resolver does not start |
| **Support policy assertion** | After config validation, builds the support policy and calls `assertSupportPolicy()`. If the deployment cannot carry any single route (no HTLC address, no signing key, wrong network), startup is aborted. | `src/support.ts`, `@wafflefinance/config` | `process.exit(1)` — resolver does not start |
| **Port conflict check** | Rejects equal `RESOLVER_METRICS_PORT` and `RESOLVER_HEALTH_PORT` before either HTTP server is created, preventing a silent half-bind. | `src/commands/run.ts` | `process.exit(1)` — resolver does not start |
| **Supervisor restart ceiling** | After `maxRestarts` consecutive listener crashes the supervisor transitions to `failed` state and the process exits. This is a blocking stop — the resolver will not self-recover and requires operator intervention. | `src/supervisor.ts` | `process.exit(1)` |
| **Signal-triggered shutdown** | `SIGTERM` / `SIGINT` / `SIGHUP` trigger a graceful teardown that stops listeners, drains in-flight work, closes HTTP servers, and exits cleanly within `SHUTDOWN_TIMEOUT_MS` (15 s). After the timeout the process force-exits. | `src/commands/run.ts` | `process.exit(0)` (clean) or `process.exit(1)` (timeout) |
| **Fatal listener error** | A `FatalError` thrown from a listener bypasses the restart logic and terminates the process immediately. Used for unrecoverable states (e.g. a private key that cannot sign any transaction). | `src/supervisor.ts` `FatalError` class | `process.exit(1)` |

**Key property:** Every blocking action either prevents a misconfigured process
from running at all, or stops a process that has exhausted its ability to recover
safely.  No blocking action touches user funds or reverts an on-chain
transaction.

---

## What the resolver can never do

This section is the most important for operators integrating a resolver into
a settlement pipeline.  These constraints are protocol-level, not
implementation choices — they hold even if the resolver code is replaced
entirely.

### 1. The resolver cannot steal funds

The resolver's signing key can submit `claimOrder` transactions, but `claimOrder`
only succeeds when the caller provides the correct sha256 preimage.  The resolver
learns the preimage by observing it on-chain (it was revealed in public by the
user when they claimed the destination leg).  The resolver cannot invent a
preimage, and a `claimOrder` call with a wrong preimage is reverted by the
contract.

### 2. The resolver cannot block settlement

If the resolver is offline, misconfigured, or intentionally ignoring an order:

- The **user can claim the destination leg** directly from any wallet using the
  correct preimage — no resolver involvement needed.
- The **user can refund the source leg** directly from any wallet once the
  timelock expires — no resolver involvement needed.
- Any **third party** (coordinator, relayer, or another resolver) can submit the
  same relay transactions the resolver would have submitted.  All actions are
  permissionless.

### 3. The resolver cannot slash itself or other resolvers

Slashing is an owner-only action on `ResolverRegistry`.  The resolver's signing
key is not the registry owner and has no slash capability.

### 4. The resolver cannot modify a timelock or hashlock

Timelocks and hashlocks are set at `createOrder` time and are immutable on-chain.
The resolver has no write path that touches either field.

### 5. The resolver cannot extend its claim window

The resolver observes when a destination leg is claimed and then submits a source
claim.  If the source timelock has already expired by the time the resolver
attempts the source claim, the `claimOrder` transaction is reverted by the
contract (`NotClaimable` / `Expired`).  The resolver cannot override this.

### 6. The resolver cannot read private keys from other resolvers

The resolver's config holds its own signing keys only.  The protocol has no
shared-key or multi-party setup between resolvers.

### 7. The resolver cannot prevent a user from refunding after timelock expiry

`refundOrder` is permissionless.  Once the timelock has passed, any caller can
submit it.  The resolver has no mechanism to delay or block a refund.

---

## Trust model diagram

```
                         ┌──────────────────────────────┐
                         │        On-chain HTLCs          │
                         │  (immutable settlement rules)  │
                         │                                │
                         │  claimOrder: sha256 check      │
                         │  refundOrder: timelock check   │
                         │  No resolver privilege here    │
                         └─────────────┬────────────────-─┘
                                       │ public read / write
           ┌──────────────────────┬────┴──────────────────┐
           │                      │                        │
    ┌──────▼──────┐     ┌─────────▼────────┐    ┌─────────▼────────┐
    │  User wallet │     │     Resolver      │    │    Any 3rd party  │
    │              │     │  (observer+relay) │    │  (permissionless) │
    │  Can claim   │     │                   │    │                   │
    │  Can refund  │     │  NON-BLOCKING:    │    │  Can claim        │
    │  No resolver │     │  • Listen events  │    │  Can refund       │
    │  needed      │     │  • Relay preimage │    │  No resolver      │
    └──────────────┘     │  • Emit metrics   │    │  needed           │
                         │                   │    └───────────────────┘
                         │  BLOCKING (self): │
                         │  • Config valid.  │
                         │  • Supervisor max │
                         │    restarts       │
                         │  • Fatal errors   │
                         │                   │
                         │  CANNOT:          │
                         │  • Steal funds    │
                         │  • Block refund   │
                         │  • Slash others   │
                         │  • Extend locks   │
                         └───────────────────┘
```

---

## Health and telemetry alignment

The distinction between blocking and non-blocking work is encoded in the health
endpoints:

| Endpoint | What it checks | Blocking signal |
|----------|---------------|-----------------|
| `GET /healthz` | Is the process alive? | Never 503 while alive — not a blocking check |
| `GET /readyz` | Is config present and supervisor healthy? | 503 when supervisor `failed` or `stopped`, or when a required chain config is missing |
| `GET /health` | Full supervisor + dependency payload | Reports `unhealthy` when supervisor is `failed` |
| `GET /telemetry` | Is the resolver actually making progress? | 503 only when `inactive` (supervisor not running) |
| `GET /support` | What can this deployment carry? | 503 when no route is actionable |

**Readiness (`/readyz`) is a blocking signal**: a `503` tells the orchestrator
to stop routing new work to this pod.  It does not mean settlement is broken —
the contracts continue to function independently.

**Telemetry (`/telemetry`) is a non-blocking signal**: `stale` or `degraded`
means the resolver is having trouble making progress, but funds are not at risk.
Operators should alert on `stale` but it does not require an emergency response.

The telemetry state machine (`src/telemetry.ts`) maps to operational urgency as
follows:

| State | Meaning | Operator action |
|-------|---------|-----------------|
| `connected` | All chains live, no elevated failures | None |
| `degraded` | Supervisor restarting or elevated failure count | Investigate logs; check RPC health |
| `stale` | One or more chains have gone quiet | Check RPC connectivity; verify chain is producing blocks |
| `inactive` | Supervisor not running | Check supervisor state; inspect for config errors or max-restarts exhaustion |

---

## Operational guidance

### Starting the resolver

The resolver performs blocking config validation on startup.  If it exits with
code 1 immediately, check:

1. `NETWORK_MODE` is `testnet` or `mainnet`.
2. `RESOLVER_ETH_PRIVATE_KEY` is a valid 0x-prefixed 32-byte hex key.
3. `RESOLVER_STELLAR_SECRET` is a valid `S...` Stellar secret.
4. `ETH_RPC_URL` is reachable and returns the correct chain ID for `NETWORK_MODE`.
5. `SOROBAN_RPC_URL` is reachable and returns the correct network passphrase.
6. `ETH_HTLC_ESCROW` and `SOROBAN_HTLC` are set (otherwise no route is actionable
   and `assertSupportPolicy` aborts startup).

### Interpreting supervisor exit

| Exit reason | Meaning | Recovery |
|-------------|---------|----------|
| Max restarts exceeded | RPC or listener crashed 5 consecutive times | Check RPC health; increase `RESOLVER_MAX_RESTARTS` or wait for RPC recovery |
| `FatalError` | Unrecoverable config/state error | Fix the underlying issue; restart the process |
| Clean shutdown (SIGTERM) | Intentional stop by orchestrator | None — orchestrator will restart per its policy |

### Key rotation

The resolver's signing key can be rotated by stopping the process, updating the
environment, and restarting.  Orders that arrived during the restart window are
not lost — any actor with the correct preimage can relay them, and the user can
always refund after the timelock.  See TD-062 in `docs/TECHNICAL_DEBT.md` for
the planned hot-rotation protocol.

### Slashing

Slashing the resolver's stake in `ResolverRegistry` has no effect on in-flight
HTLCs.  Slashed resolvers can still claim orders they hold the preimage for.
The only effect is that a slashed resolver's `active` flag is cleared, preventing
it from being assigned new orders by the coordinator.

---

## Relationship to the protocol trust model

The WaffleFinance protocol is designed so that **no single off-chain actor is
required for settlement correctness**.  The resolver is one of several actors
that can advance an order — the user, the coordinator, the relayer, and any
third-party can all perform the same permissionless on-chain actions.

This design means:

- Operators can run a resolver to earn relay fees without being a custodian of
  user funds.
- A resolver outage degrades performance (orders may settle more slowly) but
  never endangers funds.
- Operators should monitor `/telemetry` for `stale` / `inactive` states to
  catch outages promptly, but the correct urgency level for a resolver outage is
  **operational** (missed fee opportunities, user experience impact), not
  **security** (funds at risk).

The only security boundary the resolver touches is its own signing key: if the
key is compromised, an attacker can claim source-leg orders that the resolver is
tracking, collecting the source funds before the legitimate resolver does.  User
funds on the destination leg are unaffected.  This is why key material must be
stored securely (HSM or secrets manager) and why TD-062 tracks hot-key rotation.
