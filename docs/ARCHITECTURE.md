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
