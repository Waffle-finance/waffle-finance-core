# WaffleFinance resolver

The resolver is the operator-run service that fills cross-chain swap orders.
It watches both chains' HTLC contracts for order events and, once staked and
registered, is eligible to claim/refund on the destination side. This
document covers running it, its environment variables, and the operational
policy for registration, stake maintenance, and slash consequences.

## CLI

```bash
resolver register [amount]   # stake into ResolverRegistry (EVM only) and register
resolver status               # print this resolver's on-chain registration status (EVM only)
resolver unregister           # exit the registry (EVM only)
resolver run                  # start the long-running listener/health/metrics daemon
```

`register` / `status` / `unregister` only talk to the **Ethereum**
`ResolverRegistry` today (`src/commands/register.ts`) — there is no Soroban
equivalent CLI yet. `run` is chain-agnostic: it starts listeners for both
chains and, independently, the registration/stake/slash status monitor
described below for whichever chain(s) are configured.

## Environment variables

| Variable | Purpose |
|---|---|
| `NETWORK_MODE` | `testnet` or `mainnet`. Selects which `_TESTNET`/`_MAINNET` contract addresses below apply. |
| `LOG_LEVEL` | pino log level (`info`, `debug`, …). |
| `ETH_RPC_URL_*` / `SOROBAN_RPC_URL_*` | Chain RPC endpoints (see `env.example`). |
| `ETH_RESOLVER_REGISTRY_TESTNET` / `_MAINNET` | EVM `ResolverRegistry` address. |
| `SOROBAN_RESOLVER_REGISTRY_TESTNET` / `_MAINNET` | Soroban `resolver-registry` contract id. |
| `RESOLVER_ETH_PRIVATE_KEY` | 0x-prefixed EVM signing key. Optional — omit to run Ethereum observe-only. |
| `RESOLVER_STELLAR_SECRET` | `S...` Stellar signing secret. Optional — omit to run Soroban observe-only. |
| `RESOLVER_RPC_MAX_RETRIES` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS` / `_TIMEOUT_MS` | RPC retry/backoff tuning. |
| `RESOLVER_METRICS_PORT` | Prometheus `/metrics` port (default `3002`). |
| `RESOLVER_HEALTH_PORT` | `/healthz` `/readyz` `/health` port (default `3003`). |
| `RESOLVER_STATUS_POLL_INTERVAL_MS` | How often the registration/stake status monitor polls each configured registry (default `60000`). |
| `RESOLVER_SHUTDOWN_DRAIN_MS` | How long in-flight operations get to finish after `SIGTERM`/`SIGINT`/`SIGHUP` (default `10000`, clamped below the 15 s hard shutdown timeout). |
| `RESOLVER_AMBIGUOUS_TX_LOG` | Optional path to a JSON-lines journal of transactions that were submitted but not confirmed when shutdown finished. |
| `RESOLVER_ETH_PRIVATE_KEY_NEXT` / `RESOLVER_STELLAR_SECRET_NEXT` | Replacement signing key. When set, the resolver starts mid-rotation: new orders use the NEXT key, orders already in flight keep the current one. See [docs/key-rotation.md](docs/key-rotation.md). |
| `RESOLVER_KEY_OVERLAP_MS` | Minimum time the previous key keeps serving its in-flight orders after a rotation (default `86400000`, 24 h). |
| `RESOLVER_MAX_CONCURRENT_PER_CHAIN` | Event handlers allowed to run at once per chain (default `4`). |
| `RESOLVER_MAX_QUEUED_PER_CHAIN` | Handlers allowed to wait for a slot per chain before new work is rejected (default `256`). |
| `RESOLVER_MAX_ATTEMPTS_PER_ORDER` | Handler runs allowed per order and action within the attempt window (default `5`). |
| `RESOLVER_ORDER_ATTEMPT_WINDOW_MS` | Sliding window for the per-order attempt budget (default `60000`). |
| `RESOLVER_DEDUP_TTL_MS` | How long a successfully handled event absorbs identical replays (default `30000`). |

A resolver without a signing key/secret for a chain runs **observe-only** on
that chain: it still watches events and exposes metrics, but never attempts a
claim/refund there, and the status monitor described below skips it (there is
no on-chain identity to check).

## Graceful shutdown and draining

On a termination signal the resolver shuts down in a fixed order
(`src/shutdown-drain.ts`):

1. **Stop intake.** New operations are refused immediately, the supervisor
   is stopped and listeners are torn down. Events that arrive from here on
   are not processed; they are seen again from the persisted cursor after
   restart.
2. **Drain.** Operations already running get up to `RESOLVER_SHUTDOWN_DRAIN_MS`
   to finish.
3. **Report.** If a transaction was submitted but not confirmed by the
   deadline (or its confirmation wait failed during the drain), it is logged
   as *ambiguous*, with chain, action, order id and tx hash, and appended to
   `RESOLVER_AMBIGUOUS_TX_LOG` if that is set. Check each hash on-chain
   before retrying the order. Operations that had not submitted anything are
   logged as *abandoned* and can be retried.
4. **Close clients.** HTTP servers and clients are closed only after the
   drain finishes.

If a second signal arrives during shutdown, it is ignored and the first
shutdown sequence keeps running. Code that broadcasts a transaction must run
inside `DrainCoordinator.run()` and call `op.recordTx(hash)` as soon as the
transaction is submitted.

## Work limits and deduplication

Listeners can deliver the same event more than once: Ethereum subscriptions
re-deliver logs after reconnects, Soroban polling re-reads a page from the
persisted cursor after a failed tick, and supervisor restarts replay from the
cursor. `retry.ts` bounds each RPC *call*, but nothing bounded how often one
order's handler ran. Every event handler now runs through a
`ResolverWorkLimiter` (`src/work-limiter.ts`):

- **Per-order deduplication.** Work is keyed by chain, action and order id.
  A copy of work that is already running, or that succeeded within
  `RESOLVER_DEDUP_TTL_MS`, is absorbed without calling RPC or signing.
  Failures are not remembered, so a real retry still runs.
- **Per-order attempt budget.** At most `RESOLVER_MAX_ATTEMPTS_PER_ORDER`
  runs per order and action in any `RESOLVER_ORDER_ATTEMPT_WINDOW_MS`. Each
  action has its own budget, so replayed `order_created` events can never use
  up the budget of a time-sensitive claim or refund.
- **Per-chain concurrency.** Up to `RESOLVER_MAX_CONCURRENT_PER_CHAIN` handlers
  run per chain. Extra work waits in a queue of up to
  `RESOLVER_MAX_QUEUED_PER_CHAIN` entries and is rejected after that. Claims
  and refunds move ahead of queued new-order work. Each chain has its own
  slots, so a backlog on one chain never holds up another.

Rejected, deduplicated and deferred work is counted in
`resolver_work_rejected_total`, `resolver_work_deduplicated_total` and
`resolver_work_deferred_total`. Current load is in `resolver_work_in_flight` and
`resolver_work_queue_depth`.

## Local development keys (test identities only)

Resolver keys authorize on-chain actions. Never copy a production key into a
local `.env`, a frontend config, or coordinator config — those files are
shared, logged, and bundled differently. For local runs, generate throwaway
test-only identities and keep signing keys in the resolver process alone.

Supported formats:

- `RESOLVER_ETH_PRIVATE_KEY` — `0x`-prefixed 32-byte hex (`/^0x[0-9a-fA-F]{64}$/`,
  must be a usable secp256k1 key). Empty/unset means Ethereum observe-only.
- `RESOLVER_STELLAR_SECRET` — `S...` StrKey Ed25519 secret seed
  (`StrKey.isValidEd25519SecretSeed`). Empty/unset means Soroban observe-only.
- `NETWORK_MODE=testnet` selects the `*_TESTNET` registry addresses; use
  testnet endpoints (`SEPOLIA_RPC_URL`, `SOROBAN_RPC_URL`, `STELLAR_HORIZON_URL`)
  for local runs.

Generate local-only identities (testnet/dev only — outputs stay redacted):

```bash
# Ethereum test identity (writes a random key to a local file, never prints it)
node -e "const {randomBytes}=require('node:crypto');require('node:fs').writeFileSync('./.resolver-eth-test.key','0x'+randomBytes(32).toString('hex'),{mode:0o600})"
RESOLVER_ETH_PRIVATE_KEY="$(cat ./.resolver-eth-test.key)" NETWORK_MODE=testnet pnpm --filter @wafflefinance/resolver dev

# Stellar test identity (fund via Friendbot on testnet; secret stays in the file)
npx -y @stellar/stellar-cli key generate --fund --network testnet --output-json /tmp/friendbot.json >/dev/null
```

Operational rules:

- Keep `RESOLVER_ETH_PRIVATE_KEY` / `RESOLVER_STELLAR_SECRET` in the resolver
  `.env` only — never in `frontend/.env`, coordinator config, screenshots, or
  chat logs. Redact them in pastes (`RESOLVER_ETH_PRIVATE_KEY=[redacted]`).
- Frontend and coordinator configs need only public addresses/contract ids
  (`ETH_*`, `SOROBAN_*`); they must never contain signing secrets.
- If a real key was ever pasted or committed, rotate it: generate a fresh key
  and treat the exposed one as compromised.

## Operational policy: registration, stake maintenance, and slashing

The two `ResolverRegistry` contracts (`contracts/contracts/ResolverRegistry.sol`
on EVM, `soroban/contracts/resolver-registry/src/lib.rs` on Soroban) do not
expose the same shape of state, and don't behave identically on recovery. The
resolver runtime normalizes both onto one shared, testable model
(`src/registry-status.ts`) so operators only need to reason about one set of
states regardless of which chain(s) they run on.

### States

| State | Meaning | Ready to fill orders? |
|---|---|---|
| `unregistered` | No on-chain record for this resolver's address. | Yes — treated as "not participating on this chain," not a failure. |
| `active` | Registered, staked ≥ the registry's current minimum, contract's `active` flag is set. | **Yes.** |
| `low_stake` | Staked below the current minimum, but has never been slashed (e.g. the admin raised `minStake`). | No. |
| `slashed` | Staked below the current minimum **and** has a nonzero slash history — under-collateralized because of a penalty. | No. |
| `unbonding` | *(Soroban only)* `request_unregister()` has been called; stake is locked until the unbonding window elapses and `withdraw_stake()` is called. | No. |
| `inactive` | Registered, sufficiently staked, but the contract's `active` flag is unexpectedly false. Not normally reachable on either chain today — kept as an explicit fallback rather than misreporting `active`. | No. |

`low_stake` and `slashed` are deliberately distinct: the operator response
differs. `low_stake` typically means "top up your stake" (an admin-driven
`minStake` change); `slashed` means "you were penalized for misbehavior — top
up your stake **and** investigate what happened," since `totalSlashed` is
never zero once a resolver has been slashed, even after it re-actives (this
is a scar on the record, not just a stake shortfall).

### Recovery paths differ by chain — the runtime cannot assume symmetry

- **EVM**: calling `increaseStake()` re-checks the threshold and flips
  `active` back to `true` automatically once `stake >= minStake`. A slashed
  EVM resolver recovers by simply topping up.
- **Soroban**: `increase_stake()` does **not** reactivate a slashed
  resolver. Recovery requires the full exit sequence —
  `request_unregister()` → wait out the unbonding window
  (`unbonding_period()`, ≥ 24h) → `withdraw_stake()` → `register()` again.
  This is why `unbonding` is tracked as its own state rather than folded into
  `low_stake`/`slashed`: an unbonding resolver's stake is *expected* to fall
  to zero, and that is not something to alert on the same way a surprise
  slash is.

### How it's observed

- **Metrics** (`GET /metrics`, `src/metrics.ts`):
  - `resolver_registration_info{chain}` — `1` when `active`, else `0`.
  - `resolver_registry_lifecycle_state{chain,state}` — enum-style gauge;
    exactly one `state` series per `chain` is `1` at a time.
  - `resolver_registration_changes_total{action}` — counted once per
    transition, labeled with the state entered.
- **Logs** — every state transition is logged once, at a severity matching
  the new state (`info` for `active`/`unregistered`, `warn` for
  `low_stake`/`unbonding`/`inactive`, `error` for `slashed`), with the
  previous state, new state, stake, minStake, and totalSlashed attached.
  Repeated polls that don't change state produce no log line — the monitor
  is quiet unless something actually changed.
- **Readiness** (`GET /readyz`, `src/health.ts`) — includes a
  `registry_status` check that fails (503) when any *tracked* chain
  (one that has been probed at least once) is not in `active` or
  `unregistered`. A chain that was never probed at all (no registry
  configured, or no signing key/secret) never blocks readiness.

### Polling

`ResolverStatusMonitor` (`src/registry-status.ts`) polls each configured
registry on its own timer (`RESOLVER_STATUS_POLL_INTERVAL_MS`, default 60s) —
deliberately much coarser than the order-event listeners, since
registration/stake status changes far less often than order flow. It is
started and stopped alongside the rest of the daemon in `src/commands/run.ts`.

A probe failure (RPC error, timeout) is logged at `warn` and the previously
known state is kept — it never throws out of the poll loop, and never resets
a resolver from `active` to `unregistered` just because one poll failed.

### Registry failure policy: new work vs in-flight orders

Registry standing controls whether the resolver takes **new** work. It never
makes the resolver walk away from an order it already accepted, because
abandoning an accepted order is what puts user funds at risk.
`OrderEligibilityGate` (`src/order-eligibility.ts`) applies the policy to every
order event:

| What the registry says about this chain | New order | Claim for an accepted order | Refund for an accepted order |
|---|---|---|---|
| No registry configured (probe returns nothing) | accept | run | run |
| `active`, recently read, last probe succeeded | accept | run | run |
| `inactive` / `low_stake` / `slashed` / `unbonding` / `unregistered` | **refuse** | run | run |
| Never read, or the most recent probe failed | **refuse** | run | run |
| Last good read older than twice the poll interval (stale) | **refuse** | run | run |

- A claim for an order this resolver never accepted counts as new work and
  is refused under the same conditions. If the registry is unreachable, the
  resolver cannot show it may complete the order, so it does not start.
- A refund for an order this resolver never accepted is refused, because it
  has nothing to return.
- Any doubt (unknown, stale or failed probe) refuses new work. The cached
  state is still reported, but it is not used to take on work.
- An order refused while the resolver is ineligible is not remembered as
  handled. If the event is seen again after the resolver becomes `active`,
  the order is processed.

Decisions are counted in
`resolver_order_eligibility_decisions_total{chain,action,result}`.
Integration tests that cover each row are in
`test/registry-eligibility.integration.test.ts`, and the fixtures are in
`test/fixtures/registry.ts`.
