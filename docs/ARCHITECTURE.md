# Architecture

This document describes how the system is actually wired today — the real
module boundaries, the event flow between services, and the relationship
between the on-chain contracts and the off-chain Node services. It exists
because a single README can no longer carry that weight on its own; treat
this as the source of truth over any inference from package names alone,
and update it in the same PR that changes a boundary described here.

For "where do I make change X" and per-package validation, see the
[Contributor Handbook](./CONTRIBUTOR_HANDBOOK.md). This doc is about how the
pieces fit together, not how to work in any one of them.

---

## Table of contents

- [System overview](#system-overview)
- [Settlement layer: the contracts](#settlement-layer-the-contracts)
- [Client layer: the SDK](#client-layer-the-sdk)
- [Order lifecycle and event flow](#order-lifecycle-and-event-flow)
- [Service boundaries](#service-boundaries)
- [Health and readiness model](#health-and-readiness-model)
- [Where the architecture is not yet unified](#where-the-architecture-is-not-yet-unified)
- [Runtime assumptions](#runtime-assumptions)
- [Event replay in depth](#event-replay-in-depth)
- [Service restart behavior](#service-restart-behavior)
- [Degraded network behavior](#degraded-network-behavior)
- [Cross-chain invariants](#cross-chain-invariants)

---

## System overview

```
                    ┌─────────────────────────────────────────────┐
                    │              packages/sdk                    │
                    │  IHTLCClient adapters: ethereum / soroban /   │
                    │  solana · state machine · asset resolution · │
                    │  coordinator REST client · secret helpers     │
                    └───────────────┬───────────────────────────────┘
                                    │ imported by (frontend/e2e: source;
                                    │ coordinator/relayer/resolver: built)
        ┌───────────────┬──────────┼───────────────┬───────────────┐
        ▼               ▼          ▼               ▼               ▼
   frontend/        coordinator/  relayer/      resolver/         e2e/
   React+Vite       order book    relay+refund  listener-only    in-memory
   dApp             (metadata     watchdog      runner            HTLC sims
                     source of                                    (no live
                     truth)                                       RPC/chain)
        │               │              │              │
        │      ┌────────┴───────┐      │              │
        ▼      ▼                ▼      ▼              ▼
   ┌─────────────────────────────────────────────────────────┐
   │         On-chain settlement (source of truth)             │
   │  contracts/  HTLCEscrow.sol + ResolverRegistry.sol (EVM)   │
   │  soroban/    wafflefinance-htlc + resolver-registry (XLM)  │
   │  Anchor HTLC program (Solana — deployed on devnet)            │
   └─────────────────────────────────────────────────────────┘
```

Two things this diagram is trying to make explicit:

1. **The contracts are the only source of truth for settlement.** The
   coordinator's database is a rebuildable cache of order metadata, not an
   authoritative ledger — this is stated directly in
   `coordinator/src/persistence/schema.sql`'s own comments, and is why
   reconciliation/replay exists at all (see below).
2. **The SDK is consumed two different ways.** Server packages
   (coordinator, relayer, resolver) depend on the SDK's *built* output;
   frontend and e2e alias straight to its TypeScript *source*
   (`frontend/vite.config.ts`, `e2e/vitest.config.ts`). A change can pass
   `pnpm --filter @wafflefinance/sdk build` and still break one of these
   source consumers if it relies on something outside the SDK's `exports`
   map.

---

## Settlement layer: the contracts

| Chain | Contract | Language | Settlement rule |
| --- | --- | --- | --- |
| Ethereum | `HTLCEscrow.sol` + `ResolverRegistry.sol` | Solidity 0.8.24 (Hardhat + Foundry) | `sha256(preimage) == hashlock` before `timelock` → pay `beneficiary`; timelock expired → anyone calls `refundOrder` |
| Stellar | `wafflefinance-htlc` + `wafflefinance-resolver-registry` | Rust / Soroban SDK 22.x | Same logical rule; Soroban host functions enforce the SHA-256 check and timelock at the VM level |
| Solana | Anchor HTLC program | Rust / Anchor | Same logical rule; sha256 preimage reveal via Anchor constraint |

There is no cross-chain messaging protocol, validator set, or attester.
Each leg is an independent HTLC; the same `sha256` preimage unlocks both.
`ResolverRegistry` (present on both EVM and Soroban) is the only on-chain
concept that ties a resolver's stake to its behavior — misbehavior is
slashable there, not enforced by the bridge services.

The 12h (destination) vs 24h (source) timelock asymmetry is a protocol
invariant, not a service-level policy: it guarantees the resolver's refund
window on the destination chain always closes before the user's refund
window on the source chain opens, so refund races can't leave either party
stuck. `e2e/cross-chain.test.ts` encodes this asymmetry directly in its
stuck-order-refund test scenarios.

**Where Soroban and EVM runtime semantics diverge** (relevant for operations
and audits — the logical HTLC rules above are the same on all three chains):

| Aspect | Ethereum | Soroban |
| --- | --- | --- |
| **Finality model** | Probabilistic (PoS); the coordinator waits for confirmations before treating an event as final | BFT (Stellar Consensus Protocol); ledgers are immediately final — no reorgs, no confirmation window needed |
| **Out-of-order events** | Can occur during short-lived reorgs; listener handles block hash mismatches | Only possible due to node-level inconsistency (stale cursor, RPC bug), never due to chain state |
| **Event sourcing** | `getLogs` with a block-number range | Cursor-based `getEvents` pagination; cursors expire after ~48 h — a cursor reset triggers a bounded replay |
| **Crypto enforcement** | `sha256` EVM precompile (address 0x02) | `sha256` Soroban host function; semantically identical, different invocation path |
| **State TTL** | No automatic expiry; contract state is permanent | Rent-based TTL; order entries and the contract instance expire unless actively extended |
| **Admin override** | Upgradeability gated by proxy pattern (if used) | Admin can update governance params (min deposit) but cannot move locked HTLC funds; enforced by the Soroban host |

---

## Client layer: the SDK

`packages/sdk` is the only place that knows how to talk to all three
chains and to the coordinator. Its shape (see `packages/sdk/README.md` for
the authoritative stability tiers):

- **`IHTLCClient`** (`htlc-client.ts`) — the chain-agnostic interface;
  `EthereumHTLCClient`, `SorobanHTLCClient`, `SolanaHTLCClient` each
  implement it (`src/ethereum/`, `src/soroban/`, `src/solana/`).
- **`state-machine/`** — order status transition helpers, built on the
  `OrderStatus` union (`announced → src_locked → dst_locked →
  secret_revealed → completed`, with `refunded` / `failed` / `expired` as
  terminal off-ramps). This is a client-side *view* of the lifecycle, not
  the authoritative implementation — see the coupling note below.
- **`coordinator/`** — a typed REST client (`CoordinatorClient`,
  `HistoryClient`, `OrderSubscriber`) for the coordinator's own API. This
  is the only in-repo consumer required to stay in lockstep with
  `coordinator/src/server/routes/`.
- **`assets/`** — cross-chain asset/token resolution, used by both the
  frontend's token selector and the coordinator's announce-validation path.
- **`secrets/`** — preimage/hashlock generation and validation, shared by
  every chain adapter and by `e2e/sim.ts`'s simulators, which is what makes
  the e2e suite a *real* differential test rather than a mock of the SDK.

---

## Order lifecycle and event flow

An order's life, end to end, spans on-chain events on two chains and two
independent off-chain views of its status:

```
1. Announce
   Frontend/relayer → POST /orders/announce (coordinator)
   coordinator/src/server/routes/orders.ts
     → order-service.ts announce()
     → orders-repo.ts announce()   (status: "announced")

2. Source lock (chain event)
   User locks funds on the source chain's HTLC contract.
   Chain listener picks up the event:
     - coordinator/src/listeners/{ethereum,soroban,solana}-listener.ts
     - resolver/src/listeners/{ethereum,soroban}.ts (relay-only, no store)
   → order-service.ts recordSrcLock()             (status: "src_locked")

3. Destination lock (chain event)
   Resolver locks funds on the destination chain's HTLC contract
   (relayer/src/index.ts order-processing routes drive this for the
   reference resolver flow).
   → order-service.ts recordDstLock()              (status: "dst_locked")

4. Secret reveal + claim
   User claims on the destination chain, revealing the sha256 preimage
   on-chain. Whichever listener sees it first:
   → order-service.ts recordSecret()          (status: "secret_revealed")
   Resolver/relayer then use the now-public preimage to claim the source
   leg.                                              (status: "completed")

5. Failure path (either leg)
   Timelock expiry → anyone calls refundOrder on-chain →
   relayer's refund-watchdog / recovery-service detect it
   → order-service.ts rollbackSrcLock()/rollbackDstLock()
                                                      (status: "refunded")
```

Two things make this durable against a service crash or missed event
rather than a naive single-pass listener:

- **Reconciliation/replay** — `coordinator/src/reconciliation/reconciler.ts`
  re-scans a lookback window (14,400 ETH blocks / 34,560 Soroban ledgers /
  equivalent Solana signature window) on startup and periodically, replaying
  any `OrderCreated`/`OrderClaimed`/`OrderRefunded`-equivalent event the live
  listener might have missed. This is why the coordinator's DB is described
  as a rebuildable cache: it can always be reconstructed by replaying chain
  history.
- **Stale-order cleanup** — `coordinator/src/services/stale-cleanup.ts`
  archives orders stuck in `announced` past a retention window (no source
  lock ever arrived), separately from `expireStaleOrders`
  (`order-service.ts`), which handles timelock-based expiry for orders that
  did lock but never completed. These are two different notions of "stale"
  handled by two different code paths — don't conflate them.
- **Backlog priority** — `coordinator/src/backlog/backlog-scheduler.ts`
  orders startup work as `LIVE_EVENT > REPLAY_JOB > SECRET_RECOVERY >
  STALE_CLEANUP`, so a coordinator restarting mid-incident processes live
  events before it burns time on historical replay or cleanup.

---

## Service boundaries

| Service | Owns | Does not own | Talks to |
| --- | --- | --- | --- |
| **coordinator** | Order metadata (SQLite/Postgres), the authoritative `OrderStatus` for API consumers, reconciliation/replay, stale cleanup | Signing keys, settlement truth (the chains own that) | Ethereum RPC, Soroban RPC, Solana RPC (read-only); serves REST to frontend/relayer |
| **relayer** | The reference resolver flow's order creation/processing routes (`src/index.ts`), refund watchdog, gas tracking, recovery/auto-refund | An order store of its own — it drives the same on-chain HTLCs the coordinator is watching, but keeps no independent database (see gap below) | Ethereum (`ethers.JsonRpcProvider`), Stellar Horizon, the coordinator's API |
| **resolver** | Nothing stateful — pure listener + relay. Supervises its own listener lifecycle (`idle/running/restarting/stopping/stopped/failed`) | Any order store, any settlement decision | Ethereum RPC (viem `watchEvent`), Soroban RPC (poll + `retryRpcCall`) |
| **frontend** | Wallet connection, bridge form UX, client-side order status polling/subscription | Any server-side state | The coordinator's REST API via the SDK's `CoordinatorClient`; wallets directly for signing |
| **e2e** | Cross-chain differential correctness (hashlock/preimage semantics, stuck-order refund sequencing) across in-memory chain simulators | Anything about a running service, real RPC, or real timing | Nothing external — pure in-process against `e2e/sim.ts` + the real SDK |

The one boundary worth calling out because it's easy to assume otherwise:
**the relayer does not read from or write to the coordinator's database.**
They are two independent views of the same on-chain reality, kept in sync
only by both listening to the same chain events. This is deliberate (no
service holds a lock the others depend on for correctness) but it means a
relayer-side bug in order processing won't show up as a coordinator test
failure, and vice versa.

---

## Health and readiness model

Every long-running service (coordinator, relayer, resolver) exposes the
same nominal three endpoints — `/health`, `/healthz`, `/readyz` — aggregated
by `packages/dashboard`. But the actual depth of the check differs per
service, and that difference is architectural, not accidental:

- **coordinator** (`src/readiness.ts`) and **relayer**
  (`src/routes/health.ts`) live-probe each chain RPC on every `/readyz` call
  (`eth_blockNumber`, Soroban `getHealth`, Solana `getHealth`/Horizon root),
  with a fixed per-probe timeout and no retry inside the probe itself —
  a single slow or failing RPC call is enough to flip `/readyz` to 503.
- **resolver** (`src/health.ts`) deliberately does **not** live-probe RPC in
  `/readyz` — that check is config-presence only ("has an RPC URL and a
  signing key configured"), explicitly documented as microsecond-fast. Its
  actual RPC-degradation signal lives in a fourth endpoint, `/telemetry`
  (`src/telemetry.ts`), which classifies each configured chain as
  `connected | degraded | stale | inactive` based on how recently its
  listener last made progress — a staleness model, not a per-call probe.

See [`HEALTH_DASHBOARD.md`](./HEALTH_DASHBOARD.md) for the endpoint
contract as documented for operators, and the RPC-degradation test files
(`*/test/rpc-degradation.test.ts` per service) for how each of these three
distinct models is exercised deterministically without a real network.

---

## Where the architecture is not yet unified

Documenting this honestly is the point of this file. These are real
duplications today, not aspirational — see
[`docs/TECHNICAL_DEBT.md`](./TECHNICAL_DEBT.md) for the tracked items:

- **The order state machine is implemented independently twice** —
  `packages/sdk/src/state-machine/` and
  `coordinator/src/state-machine/order-machine.ts` encode the same
  `OrderStatus` transitions in two places with no shared module between
  them.
- **Retry/backoff logic is implemented independently three times** —
  `coordinator/src/retry.ts`, `relayer/src/utils/retry-policy.ts`,
  `resolver/src/retry.ts` — structurally similar (exponential backoff +
  jitter) but with different APIs and no shared package.
- **RPC client construction has no shared abstraction** — each service
  independently constructs its own viem/ethers/Stellar-SDK/Solana
  `Connection` clients; there is no injectable RPC-client package shared
  across coordinator/relayer/resolver.
- **The relayer's core order-processing routes still live in a single
  3,000+ line `src/index.ts`**, only partially decomposed into the
  `services/`/`listeners/` modules that the newer code follows.

None of this blocks correctness — the redundancy is part of why no single
service is a single point of failure — but it does mean a fix to one
implementation is never automatically a fix to its siblings. Treat any of
the three duplicated concerns above as three separate changes until they're
consolidated.

---

## Runtime assumptions

These are the assumptions the system makes about its environment during normal
operation. They are not enforced by the code in every case — violating them can
produce silent misbehavior rather than an obvious error. Update this section when
a new runtime dependency is introduced.

### Database

The coordinator is the only service with a persistent store. Everything stated
below applies to both supported engines (SQLite and Postgres):

- **SQLite (development / single-node):** The coordinator opens the file at
  `DATABASE_URL` (`file:./wafflefinance.db` by default). Concurrent writes from
  two coordinator processes against the same file will cause lock contention and
  errors. Never run two coordinator instances pointing at the same SQLite file.
- **Postgres (production):** Multiple coordinator instances can share a Postgres
  database safely. The migration runner uses `ON CONFLICT DO NOTHING` when
  recording applied migrations, so concurrent startup is safe.
- **Migrations run at startup, not at deploy time.** Schema migrations in
  `coordinator/migrations/` are applied automatically when the coordinator
  process starts. A deployment that upgrades the coordinator binary without
  restarting the process does not apply pending migrations. Always restart
  after deploying a new build that includes migration files.
- **The database is a cache, not an authoritative ledger.** On-chain HTLC
  state is always the source of truth. An order's status in the coordinator
  database may lag chain reality by up to one reconciler interval (default
  polling period). Never treat a `completed` or `refunded` status in the DB as
  final without verifying on-chain.

### RPC connectivity

- **All three chain RPCs must be reachable at coordinator startup** for
  `/readyz` to return 200. A coordinator that starts with a flaky RPC will
  report degraded readiness but will continue serving cached order data. It
  will catch up once the RPC recovers, using the reconciler's lookback window.
- **Chain listeners start lazily** (TD-042). The Ethereum, Soroban, and Solana
  listeners do not start at process boot — they activate on the first incoming
  swap order or an explicit `POST /api/wake`. A coordinator that has just
  deployed and received no orders will miss on-chain events until listener
  activation. The reconciler's 48-hour lookback window mitigates this, but
  there is a window of up to `COORDINATOR_POLL_INTERVAL_MS` (default 15 s)
  where events may be buffered on-chain but not yet processed.
- **RPC calls have a fixed per-probe timeout with no retry inside the probe.**
  This is intentional for health checks: a slow RPC is treated the same as an
  unreachable one, so load balancers can route traffic away from a degraded
  instance quickly. Retry logic for actual order-processing calls (event
  subscription, reconciler scans) is handled separately per service.

### Secrets and encryption

- **`SECRET_STORAGE_KEY` must be set** to a 32-byte hex key before a
  coordinator handles real orders (TD-041). Without it, HTLC preimages are
  stored unencrypted in the database. Any actor with database read access
  can extract all preimages and claim orders on other chains.
- **`COORDINATOR_OPERATOR_KEYS` must be set** to protect the `/metrics`,
  `/api/orders/:id/src-locked`, and `/api/orders/:id/dst-locked` endpoints.
  These endpoints are not rate-limited; a missing operator key means they are
  open to any caller.
- **Secrets are never logged.** The coordinator's `sanitizeForLog()` function
  strips preimage material before anything reaches Pino. The hashlock (the
  public commitment) is safe to log and appears in structured fields.

### Service startup order

Services do not gate on each other's health checks, but the correct startup
order avoids unnecessary errors in logs and health endpoints:

```
1. Database (Postgres) or auto-create (SQLite)
2. Coordinator  — applies migrations, starts REST API, then activates listeners lazily
3. Relayer      — polls coordinator API; errors until coordinator is reachable
4. Resolver     — purely independent; starts its own listeners; no coordinator dependency
5. Frontend     — reads VITE_API_BASE_URL at build time; runtime polls coordinator
```

The SDK must be built (`pnpm --filter @wafflefinance/sdk build`) before any
Node service that imports its compiled output starts.

---

## Event replay in depth

Event replay is the mechanism that makes the coordinator's database
reconstructable after a crash, a missed event, or a fresh deployment with no
prior state. Understanding it is essential for debugging stuck orders or
assessing how complete the coordinator's view is after a restart.

### What replay covers

The reconciler (`coordinator/src/reconciliation/reconciler.ts`) re-scans a
fixed lookback window on every run:

| Chain | Lookback window | Unit | Approximate wall time |
|---|---|---|---|
| Ethereum | 14,400 blocks | ~48 hours at 12 s/block | 48 h |
| Soroban (Stellar) | 34,560 ledgers | ~48 hours at 5 s/ledger | 48 h |
| Solana | Equivalent slot window | ~48 hours | 48 h |

For each chain, the reconciler replays `OrderCreated`, `OrderClaimed`, and
`OrderRefunded` events (or their Soroban/Solana equivalents) and calls the same
`order-service.ts` methods the live listeners call. Replay is idempotent: if an
event has already been processed, the state machine guard in `order-service.ts`
rejects the redundant transition without error.

### Per-order cursor tracking

Since migration `011` (`last_eth_block`, `last_soroban_ledger`,
`last_solana_slot` columns on the orders table), the reconciler tracks a
per-order high-water mark for each chain. On subsequent runs it skips events
already processed for a given order, avoiding redundant RPC load.

### What replay does NOT cover

- **Events older than 48 hours.** An order locked more than 48 hours ago whose
  events were all missed (e.g. coordinator was offline for the entire window)
  will not be recovered by the reconciler. The on-chain HTLC state is still
  correct — the user can refund directly — but the coordinator's DB will not
  reflect the order. This scenario is rare given the 24-hour timelock, but
  possible for orders that were announced and never locked.
- **Secret recovery from off-chain storage.** The reconciler reconstructs order
  status from on-chain events but cannot reconstruct HTLC preimages from chain
  history alone (preimages are revealed on-chain at claim time but the
  coordinator caches them earlier for relay purposes). If the coordinator DB is
  wiped and rebuilt, any preimage that was cached but not yet revealed on-chain
  must be recovered via `SECRET_RECOVERY` job (part of the startup backlog
  priority queue), which re-fetches secrets from a configurable backup source.
- **Order metadata not on-chain.** Fields like `direction`, `srcAsset`,
  `dstAsset`, and `dstAmount` are stored in the coordinator DB only — they are
  not emitted in on-chain events. A full DB wipe loses this metadata
  permanently for historical orders. This is a known limitation of the
  current schema design.

### Startup backlog priority

When the coordinator restarts (after a crash, a deploy, or a manual restart
during an incident), the backlog scheduler
(`coordinator/src/backlog/backlog-scheduler.ts`) processes work in this order:

```
1. LIVE_EVENT     — events arriving from the live chain listeners right now
2. REPLAY_JOB     — reconciler scanning the 48-hour lookback window
3. SECRET_RECOVERY — re-fetching any preimages that were in-flight at crash time
4. STALE_CLEANUP   — archiving announced-but-never-locked orders past retention
```

This ordering means a coordinator restarting mid-incident does not delay
processing of live events while it works through historical replay.

---

## Service restart behavior

What to expect when each service restarts, and what state is preserved or lost.

### Coordinator

**State preserved:** All order state in the database survives a restart.
Migrations are idempotent; no manual schema work is needed. The reconciler
re-scans the 48-hour lookback window on startup, catching any events missed
while the process was down.

**State lost on restart:**
- In-memory RPC subscriptions. Live listeners must re-subscribe to chain
  events. There is a gap between when the process stopped and when the live
  listener re-subscribes — the reconciler fills this gap on startup.
- The listener activation state. Listeners are lazy; they re-activate on the
  first order or `POST /api/wake` after restart.
- Any in-flight order-processing work that had not yet been written to the DB
  (e.g. a `recordSrcLock` call that was mid-transaction). These are replayed
  by the reconciler.

**Expected time to full readiness after restart:** 30–120 seconds, depending
on how long the reconciler takes to scan the lookback window. `/readyz` returns
200 once the startup phase is `"ready"`. Do not conclude that a restart fixed or
failed to fix a problem until `/readyz` shows `"ready"`.

### Relayer

**State preserved:** The relayer is stateless — it has no persistent store of
its own. It re-reads chain state and the coordinator API on restart. Any
in-flight transactions that were broadcast before the crash may still confirm
on-chain; the coordinator will pick them up via its own listeners.

**State lost on restart:** In-memory price cache (re-fetched from CoinGecko on
next price request). Any pending order-processing work in memory.

**Expected time to readiness:** Near-instant. The relayer's `/readyz` probes
chain RPCs on each call. It is ready as soon as both probes succeed.

**Edge case — transaction broadcast before crash:** If the relayer broadcast a
destination-lock transaction just before crashing, the transaction may confirm
on-chain while the relayer is down. The coordinator's listener will pick up the
`OrderClaimed` event and advance the order to `dst_locked`. When the relayer
restarts, it will see the order is already `dst_locked` and skip re-sending.

### Resolver

**State preserved:** None — the resolver is fully stateless. Registration and
stake state live on-chain in `ResolverRegistry`. Listener progress is lost and
restarts from the current chain head.

**State lost on restart:** The supervisor's restart counter resets. After a
clean restart, the supervisor has a fresh budget of `maxRestarts` (default 5)
before it gives up and the process exits.

**Expected time to readiness:** Near-instant for `/readyz` (config-presence
check only). The `/telemetry` endpoint will show `inactive` for each chain until
the listener connects and begins making progress, which takes a few seconds per
chain.

**Supervisor restart ceiling:** The resolver supervisor will exit the process
after `maxRestarts` consecutive listener crashes (default 5, not configurable
via env — TD-061). If the resolver exits due to a restart ceiling, it requires
a manual restart of the process itself. This is logged at `fatal` level in Pino.

### Frontend

The frontend is a static Vite build served by Vercel. It has no restart
concept — Vercel handles routing and CDN distribution. A new deploy triggers
Vercel's build pipeline, which runs `pnpm --filter @wafflefinance/sdk build`
followed by `pnpm --filter @wafflefinance/frontend build` before the new
bundle is served. There is no downtime during a Vercel deploy.

---

## Degraded network behavior

How each service behaves when a chain RPC is slow, unavailable, or returning
partial results. This section documents the design intent, not just the observed
behavior — it is what operators should expect and what tests in
`*/test/rpc-degradation.test.ts` verify.

For the full deterministic test matrix and expected outcomes per failure mode,
see [`docs/RPC_DEGRADATION_TEST_MATRIX.md`](./RPC_DEGRADATION_TEST_MATRIX.md).

### Coordinator under RPC degradation

| Failure mode | `/readyz` | Order processing | Recovery |
|---|---|---|---|
| Single RPC call times out | 503 (that chain's check fails) | Live listener still running; this timeout event does not kill it | Probe recovers on next call; 503 clears automatically |
| RPC returns errors for > N consecutive calls | 503 | Listener enters error state; reconciler scans may be delayed | RPC must recover; reconciler catches up on next successful scan |
| Chain RPC fully unreachable | 503 | No new events processed for that chain | Switch RPC endpoint in env, restart coordinator; reconciler fills the gap |
| Only one of three chains degraded | 503 (that chain only) | Other chains continue normally; affected chain orders may miss events | As above for the affected chain |

The coordinator never marks an order as failed or expired solely because an RPC
is down. Status transitions only occur when an on-chain event is confirmed.

### Relayer under RPC degradation

The relayer probes Ethereum RPC (`eth_blockNumber`) and Stellar Horizon on every
`/readyz` call with no retry inside the probe. A single slow probe is enough to
flip `/readyz` to 503. This is intentional: it gives load balancers a fast signal,
even though the relayer itself may still be functioning (it has its own internal
retry logic for actual transactions, separate from the health probe).

Specifically:
- The health check timing out does **not** stop the relayer from processing
  orders — the order-processing loop runs independently of the health endpoint.
- A relayer with a 503 `/readyz` may still be submitting valid transactions. Do
  not assume a 503 relayer is idle.

### Resolver under RPC degradation

The resolver's design deliberately separates health from liveness:

- **`/readyz` does not degrade** when an RPC is slow. It checks only that config
  is present. This is microsecond-fast by design — the resolver is always "ready"
  in the sense that it has what it needs to try, even if the underlying network
  is degraded.
- **`/telemetry` degrades** to `stale` or `degraded` when the listener has not
  made progress within its staleness threshold. This is the correct signal to
  alert on for RPC degradation.
- **`retryRpcCall`** in `resolver/src/utils/` provides exponential backoff with
  jitter for Soroban RPC calls. Parameters are tunable via env:
  `RESOLVER_RPC_MAX_RETRIES`, `RESOLVER_RPC_BASE_DELAY_MS`,
  `RESOLVER_RPC_MAX_DELAY_MS`, `RESOLVER_RPC_TIMEOUT_MS`.
- After `maxRestarts` supervisor restarts due to RPC-induced listener crashes,
  the resolver process exits. RPC instability can trigger this faster than expected
  on a flaky connection. Increase `RESOLVER_RPC_MAX_RETRIES` and
  `RESOLVER_RPC_MAX_DELAY_MS` for degraded environments.

### What never degrades: the settlement contracts

On-chain HTLC settlement is independent of all off-chain services. The smart
contracts enforce settlement purely through:

1. A caller submitting a valid preimage (`sha256(preimage) == hashlock`) before
   `timelock` expires → `beneficiary` receives funds.
2. `timelock` expiring → anyone calls `refundOrder` → `refundAddress` (always
   the original user) receives funds.

No service outage, RPC failure, coordinator crash, or relayer downtime can trap
funds. The worst case for a user is that they wait for the timelock to expire
and then call `refundOrder` themselves from any wallet.

---

## Cross-chain invariants

These invariants must hold at all times. A violation is a protocol bug, not a
service configuration issue. They are encoded in `e2e/cross-chain.test.ts` and
should be re-verified any time the contract settlement logic or the timelock
parameters change.

### Invariant 1 — Timelock asymmetry

```
destination timelock (12h) < source timelock (24h)
```

The resolver's destination refund window closes before the user's source refund
window opens. This ensures:

- The resolver can always refund its destination leg before the user can refund
  the source leg. There is no scenario where the resolver is stuck holding a
  destination lock it cannot recover.
- The user can always refund the source leg after waiting 24 hours, regardless
  of what the resolver does.

**What breaks this invariant:** Deploying a new HTLC with destination timelock
≥ source timelock, or accepting user orders where the frontend incorrectly sets
`dstTimelock ≥ srcTimelock`. The SDK's `createOrder` helpers enforce the
asymmetry at construction time.

### Invariant 2 — Single preimage, both legs

```
sha256(preimage) == srcHashlock == dstHashlock
```

The same preimage unlocks both the source and destination HTLCs. There is no
separate attestation, multisig, or relay message — the user reveals the preimage
by claiming the destination leg, and that same preimage is used by the resolver
(or anyone) to claim the source leg.

**Dual-hash compatibility:** `HTLCEscrow.claimOrder` accepts a preimage if either
`sha256(preimage) == hashlock` OR `keccak256(preimage) == hashlock`. This exists
for cross-chain compatibility — Stellar and Solana use sha256 natively; the EVM
contract accepts either. The SDK's `secrets/` module always generates sha256
hashlocks. Third-party resolvers must be aware of this (documented in TD-032).

### Invariant 3 — Funds are never pooled

```
sum(locked order amounts) + sum(_pendingWithdrawals) == contract ETH balance
```

Each order's funds are tracked individually in `HTLCEscrow`. There is no
shared liquidity pool. A `beneficiary` or `refundAddress` that is a smart
contract and reverts on direct ETH receipt has its payment credited to a
pull-payment balance (`_pendingWithdrawals`); the claim/refund still finalizes.
The pull-payment balance is never operator-movable — only the credited address
can call `withdraw()` to recover it.

**On-chain enforcement:** The Foundry invariant test
`contracts/test/foundry/InvariantHTLCEscrow.t.sol` asserts this balance
identity holds across all state transitions.

### Invariant 4 — Coordinator is not in the settlement path

The coordinator never signs transactions, never holds keys to HTLC contracts,
and never controls fund movement. Its database being wrong, stale, or empty
does not affect whether funds settle correctly on-chain. A user whose order
is correctly recorded on-chain but missing from the coordinator can:

1. Claim the destination leg directly from their wallet using the preimage.
2. Refund the source leg directly from any wallet once the timelock expires.

Neither action requires coordinator involvement.

### Invariant 5 — ResolverRegistry and HTLCEscrow are separate

Slashing a resolver in `ResolverRegistry` does not affect any in-flight HTLCs.
The `HTLCEscrow` contract holds funds and settles them purely by hashlock +
timelock — it does not check the registry on `claimOrder` or `refundOrder`.
A slashed resolver whose stake is zeroed can still claim orders if it holds the
valid preimage. The registry's effect is economic (stake penalty) and
participatory (can't fill new orders while `active == false`), not a veto on
settlement.

This boundary is intentional and is what makes the registry upgradeable
without touching live HTLC state. See TD-010 for the documented upgrade path
and its current gaps.
