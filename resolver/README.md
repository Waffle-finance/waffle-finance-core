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

A resolver without a signing key/secret for a chain runs **observe-only** on
that chain: it still watches events and exposes metrics, but never attempts a
claim/refund there, and the status monitor described below skips it (there is
no on-chain identity to check).

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
