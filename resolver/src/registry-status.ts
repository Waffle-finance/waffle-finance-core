/**
 * @file registry-status.ts
 *
 * Resolver-side operational policy for registration, stake maintenance, and
 * slash consequences (see docs/operational-policy.md).
 *
 * The on-chain ResolverRegistry contracts do NOT expose a single "lifecycle"
 * enum — each chain derives status from a handful of primitive fields, and
 * the two chains diverge:
 *
 *   EVM      (contracts/contracts/ResolverRegistry.sol):
 *              { stake, registeredAt, lastSlashAt, totalSlashed, active }
 *              `active` auto-reactivates on `increaseStake()` once
 *              stake >= minStake again. No unbonding window — `unregister()`
 *              deletes the record immediately.
 *
 *   Soroban  (soroban/contracts/resolver-registry/src/lib.rs):
 *              { stake, registered_at, last_slash_at, total_slashed, active,
 *                unbonding_at: Option<u64> }
 *              `active` does NOT auto-reactivate on `increase_stake()` — a
 *              slashed-below-minimum resolver must fully exit
 *              (`request_unregister` -> wait out the unbonding window ->
 *              `withdraw_stake`) and re-`register()`. `unbonding_at` is set
 *              the moment `request_unregister()` is called and stays set
 *              until `withdraw_stake()` succeeds.
 *
 * `deriveLifecycleState()` below is this module's chain-agnostic contract:
 * it maps either chain's raw fields onto one shared, testable state machine
 * so the rest of the resolver (metrics, health checks, logs) never has to
 * know which chain it's looking at.
 */

import { createPublicClient, http, parseAbi, type Address as EvmAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Address as StellarAddress, Contract, Keypair, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { ResolverConfig } from "./config.js";
import { registrationInfo, registrationChangesTotal, resolverLifecycleState } from "./metrics.js";

// ── Lifecycle model ──────────────────────────────────────────────────────────

/**
 * The resolver's own logical standing with a chain's ResolverRegistry, as
 * derived from that registry's raw on-chain fields.
 *
 *  - unregistered : no on-chain record for this address (never registered,
 *                    or a Soroban unbonding completed and stake was withdrawn).
 *  - active        : registered, sufficiently staked, eligible to fill orders.
 *  - low_stake     : stake has fallen below the current minimum for a reason
 *                    OTHER than a slash (e.g. the admin raised minStake).
 *  - slashed       : stake is below the current minimum AND this resolver has
 *                    a nonzero slash history — under-collateralized because of
 *                    a penalty, not an admin parameter change.
 *  - unbonding     : (Soroban only) `request_unregister()` has been called;
 *                    stake is locked until the unbonding window elapses and
 *                    `withdraw_stake()` is called.
 *  - inactive      : registered, sufficiently staked, but the contract's
 *                    `active` flag is false. Should not normally be reachable
 *                    on either chain today, but is kept as an explicit,
 *                    non-throwing fallback rather than silently misreporting
 *                    "active" if a future contract change introduces a new
 *                    way to flip the flag without changing stake.
 */
export type ResolverLifecycleState =
  | "unregistered"
  | "active"
  | "low_stake"
  | "slashed"
  | "unbonding"
  | "inactive";

export const ALL_LIFECYCLE_STATES: readonly ResolverLifecycleState[] = [
  "unregistered",
  "active",
  "low_stake",
  "slashed",
  "unbonding",
  "inactive",
];

/** Chain-neutral view of a ResolverRegistry entry, normalized from either chain's raw fields. */
export interface RawRegistryInfo {
  /** Whether an on-chain record exists for this resolver address at all. */
  registered: boolean;
  /** The registry contract's own `active` flag. */
  active: boolean;
  stake: bigint;
  minStake: bigint;
  /** Cumulative amount ever slashed from this resolver (0 if never slashed). */
  totalSlashed: bigint;
  /** Soroban only: set while an unbonding withdrawal is pending. Always null on EVM. */
  unbondingAt: bigint | null;
}

/**
 * Map a registry's raw fields onto the shared lifecycle state.
 *
 * Order matters: unbonding takes precedence over a stake shortfall (an
 * unbonding resolver's stake is expected to eventually reach zero, that's
 * not a "low stake" problem to alert on), and a slash history takes
 * precedence over a generic stake shortfall so operators can tell "you got
 * slashed" apart from "the minimum went up."
 */
export function deriveLifecycleState(info: RawRegistryInfo): ResolverLifecycleState {
  if (!info.registered) return "unregistered";
  if (info.unbondingAt != null) return "unbonding";
  if (info.stake < info.minStake) {
    return info.totalSlashed > 0n ? "slashed" : "low_stake";
  }
  if (info.active) return "active";
  return "inactive";
}

/**
 * Whether the resolver should be treated as fit to keep filling new orders.
 * `unregistered` counts as ready: it means this instance isn't participating
 * in that chain's registry at all (e.g. a single-chain or observe-only
 * deployment), which is a deliberate configuration, not a degraded one.
 */
export function isOperationallyReady(state: ResolverLifecycleState): boolean {
  return state === "active" || state === "unregistered";
}

/** Log level to use when transitioning INTO a given state. */
const STATE_LOG_LEVEL: Record<ResolverLifecycleState, "info" | "warn" | "error"> = {
  unregistered: "info",
  active: "info",
  low_stake: "warn",
  unbonding: "warn",
  slashed: "error",
  inactive: "warn",
};

export type RegistryChain = "ethereum" | "soroban";

/** A source of raw registry info for one chain. Returns null when that chain isn't configured for status tracking. */
export type RegistryProbe = (cfg: ResolverConfig, log: Logger) => Promise<RawRegistryInfo | null>;

// ── EVM probe ─────────────────────────────────────────────────────────────────

const EVM_REGISTRY_READ_ABI = parseAbi([
  "function get(address resolver) view returns ((address resolver,uint256 stake,uint64 registeredAt,uint64 lastSlashAt,uint256 totalSlashed,bool active))",
  "function minStake() view returns (uint256)",
]);

/**
 * Read this resolver's own status from the EVM ResolverRegistry.
 * Returns null when no registry address or signing key is configured —
 * an observe-only deployment has no on-chain identity to check.
 */
export async function fetchEvmRegistryInfo(cfg: ResolverConfig, _log: Logger): Promise<RawRegistryInfo | null> {
  const { resolverRegistry, resolverPrivateKey, rpcUrl } = cfg.ethereum;
  if (!resolverRegistry || !resolverPrivateKey) return null;

  const address = privateKeyToAccount(resolverPrivateKey).address;
  const client = createPublicClient({ transport: http(rpcUrl) });

  const [info, minStake] = await Promise.all([
    client.readContract({
      address: resolverRegistry as EvmAddress,
      abi: EVM_REGISTRY_READ_ABI,
      functionName: "get",
      args: [address],
    }),
    client.readContract({
      address: resolverRegistry as EvmAddress,
      abi: EVM_REGISTRY_READ_ABI,
      functionName: "minStake",
    }),
  ]);

  const raw = info as unknown as {
    stake: bigint;
    registeredAt: bigint;
    totalSlashed: bigint;
    active: boolean;
  };

  return {
    registered: raw.registeredAt > 0n,
    active: raw.active,
    stake: raw.stake,
    minStake: minStake as bigint,
    totalSlashed: raw.totalSlashed,
    // EVM ResolverRegistry has no unbonding window — unregister() is immediate.
    unbondingAt: null,
  };
}

// ── Soroban probe ────────────────────────────────────────────────────────────

/**
 * Simulate a read-only Soroban contract invocation and decode its return
 * value. Soroban has no eth_call-style free read RPC method for contract
 * functions — `simulateTransaction` against an unsigned, never-submitted
 * transaction is the standard pattern (view methods require no auth, so the
 * simulation succeeds without the transaction ever being signed or sent).
 */
async function simulateSorobanRead(
  server: rpc.Server,
  sourcePublicKey: string,
  networkPassphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<unknown> {
  const account = await server.getAccount(sourcePublicKey);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Soroban simulation of ${method}() failed: ${sim.error}`);
  }
  if (!("result" in sim) || !sim.result) {
    return null;
  }
  return scValToNative(sim.result.retval);
}

/**
 * Read this resolver's own status from the Soroban ResolverRegistry.
 * Returns null when no registry contract id or signing secret is configured.
 */
export async function fetchSorobanRegistryInfo(cfg: ResolverConfig, log: Logger): Promise<RawRegistryInfo | null> {
  const { resolverRegistry, resolverSecret, rpcUrl, networkPassphrase } = cfg.soroban;
  if (!resolverRegistry || !resolverSecret) return null;

  const publicKey = Keypair.fromSecret(resolverSecret).publicKey();
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const resolverScVal = new StellarAddress(publicKey).toScVal();

  const [infoNative, minStakeNative] = await Promise.all([
    simulateSorobanRead(server, publicKey, networkPassphrase, resolverRegistry, "get", [resolverScVal]),
    simulateSorobanRead(server, publicKey, networkPassphrase, resolverRegistry, "min_stake", []),
  ]);

  const minStake = toBigIntSafe(minStakeNative as bigint | number | string, "minStake");

  // `get()` returns Option<ResolverInfo> — scValToNative decodes None as
  // null/undefined and Some(x) as the plain decoded struct.
  if (infoNative === null || infoNative === undefined) {
    return { registered: false, active: false, stake: 0n, minStake, totalSlashed: 0n, unbondingAt: null };
  }

  const info = infoNative as {
    stake: bigint | number | string;
    total_slashed: bigint | number | string;
    active: boolean;
    unbonding_at?: bigint | number | string | null;
  };

  return {
    registered: true,
    active: Boolean(info.active),
    stake: toBigIntSafe(info.stake, "stake"),
    minStake,
    totalSlashed: toBigIntSafe(info.total_slashed ?? 0n, "total_slashed"),
    unbondingAt: info.unbonding_at != null ? toBigIntSafe(info.unbonding_at, "unbonding_at") : null,
  };
}

// ── Safe bigint conversion ────────────────────────────────────────────────────

/**
 * Convert a value from on-chain decoding to bigint safely.
 *
 * Accepted inputs:
 *   - bigint  : passed through unchanged.
 *   - string  : passed directly to the BigInt() constructor (full precision).
 *   - number  : only accepted when it is a finite, safe integer
 *               (Number.isSafeInteger). A JS number outside the safe range
 *               has already been rounded by IEEE-754, so converting it with
 *               BigInt() would silently propagate the rounded — and therefore
 *               wrong — value. Stake amounts and registration timestamps are
 *               large enough (wei-denominated) to overflow Number.MAX_SAFE_INTEGER,
 *               so we guard against that here.
 *
 * @throws {RangeError} when a numeric value is not a finite safe integer.
 */
export function toBigIntSafe(value: bigint | number | string, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return BigInt(value);
  // typeof value === "number"
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new RangeError(
      `${field} has an unsafe numeric value (${value}). ` +
      "Use bigint or a string representation to avoid silent precision loss."
    );
  }
  return BigInt(value);
}



/** Poll interval when none is supplied. Registration/stake status changes far less often than order events, so this is deliberately much coarser than the chain listeners' poll interval. */
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 60_000;

/**
 * Age after which a cached registry status is considered stale.
 * Defaults to twice the poll interval: one missed poll is tolerated, two
 * consecutive misses (or an equivalent time span without a successful read)
 * mark the cached value stale. Staleness never changes readiness — it only
 * tells operators/UI whether the last-known value is still fresh.
 */
export const DEFAULT_STATUS_STALE_AFTER_MS = 2 * DEFAULT_STATUS_POLL_INTERVAL_MS;

export interface RegistryChainStatus {
  chain: RegistryChain;
  state: ResolverLifecycleState;
  /** Epoch ms of the last successful probe for this chain, or null if never read. */
  lastUpdatedAt: number | null;
  /** True when no successful read has occurred within `staleAfterMs`. */
  stale: boolean;
}

export interface ResolverStatusMonitorOptions {
  intervalMs?: number;
  /** Age in ms after which cached status counts as stale. Defaults to `DEFAULT_STATUS_STALE_AFTER_MS`. */
  staleAfterMs?: number;
  /** Overrideable probes — primarily for testing without live RPC (mirrors validation.ts's probe injection). */
  evmProbe?: RegistryProbe;
  sorobanProbe?: RegistryProbe;
}

/**
 * Periodically polls both chains' ResolverRegistry contracts for this
 * resolver's own status and:
 *   - keeps `resolver_registration_info` / `resolver_registry_lifecycle_state`
 *     gauges current,
 *   - logs at a severity matching the new state on every transition,
 *   - increments `resolver_registration_changes_total` on every transition,
 *   - exposes the latest known state per chain for the health server's
 *     readiness check.
 *
 * A chain whose probe returns null (registry not configured, or no signing
 * key/secret for that chain) is skipped entirely — no metric, no log, and it
 * never counts against readiness. That mirrors the rest of the resolver's
 * "observe-only when key material is absent" behavior (see validation.ts).
 */
export class ResolverStatusMonitor {
  private readonly cfg: ResolverConfig;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly evmProbe: RegistryProbe;
  private readonly sorobanProbe: RegistryProbe;
  private readonly lastState = new Map<RegistryChain, ResolverLifecycleState>();
  private readonly lastUpdatedAt = new Map<RegistryChain, number>();
  private readonly staleAfterMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(cfg: ResolverConfig, log: Logger, options: ResolverStatusMonitorOptions = {}) {
    this.cfg = cfg;
    this.log = log.child({ component: "ResolverStatusMonitor" });
    this.intervalMs = options.intervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STATUS_STALE_AFTER_MS;
    this.evmProbe = options.evmProbe ?? fetchEvmRegistryInfo;
    this.sorobanProbe = options.sorobanProbe ?? fetchSorobanRegistryInfo;
  }

  start(): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      await Promise.allSettled([
        this.checkChain("ethereum", this.evmProbe),
        this.checkChain("soroban", this.sorobanProbe),
      ]);
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.intervalMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Run a single check cycle immediately, bypassing the timer. Primarily for tests and manual diagnostics. */
  async checkNow(): Promise<void> {
    await Promise.allSettled([
      this.checkChain("ethereum", this.evmProbe),
      this.checkChain("soroban", this.sorobanProbe),
    ]);
  }

  getState(chain: RegistryChain): ResolverLifecycleState | undefined {
    return this.lastState.get(chain);
  }

  /** Epoch ms of the last successful probe for a chain, or null if never read. */
  getLastUpdatedAt(chain: RegistryChain): number | null {
    return this.lastUpdatedAt.get(chain) ?? null;
  }

  /**
   * Whether the cached status for a chain is stale: never successfully read,
   * or the last successful read is older than `staleAfterMs`. A failed
   * refresh preserves the last-known state but still marks it stale once it
   * ages out — staleness is reported separately so health never depends on an
   * old successful read.
   */
  isStale(chain: RegistryChain, now: number = Date.now()): boolean {
    if (!this.lastState.has(chain)) return true;
    const updatedAt = this.lastUpdatedAt.get(chain);
    if (updatedAt == null) return true;
    return now - updatedAt > this.staleAfterMs;
  }

  /** Freshness-annotated snapshot of every chain with a cached status. */
  getStatusSnapshot(now: number = Date.now()): RegistryChainStatus[] {
    const out: RegistryChainStatus[] = [];
    for (const [chain, state] of this.lastState) {
      const lastUpdatedAt = this.lastUpdatedAt.get(chain) ?? null;
      out.push({
        chain,
        state,
        lastUpdatedAt,
        stale: lastUpdatedAt == null || now - lastUpdatedAt > this.staleAfterMs,
      });
    }
    return out;
  }

  /** True unless a currently-tracked chain is in a non-ready state. Chains never probed (not configured) don't block readiness. */
  isReady(): boolean {
    for (const state of this.lastState.values()) {
      if (!isOperationallyReady(state)) return false;
    }
    return true;
  }

  private async checkChain(chain: RegistryChain, probe: RegistryProbe): Promise<void> {
    let info: RawRegistryInfo | null;
    try {
      info = await probe(this.cfg, this.log);
    } catch (err) {
      this.log.warn({ chain, err }, "failed to fetch resolver registry status");
      // Preserve last-known state and its timestamp: a failed refresh must
      // not erase useful data nor reset the freshness clock.
      return;
    }
    if (info === null) return;

    const state = deriveLifecycleState(info);
    const previous = this.lastState.get(chain);
    this.lastState.set(chain, state);
    this.lastUpdatedAt.set(chain, Date.now());

    registrationInfo.set({ chain }, state === "active" ? 1 : 0);
    for (const s of ALL_LIFECYCLE_STATES) {
      resolverLifecycleState.set({ chain, state: s }, s === state ? 1 : 0);
    }

    if (state !== previous) {
      registrationChangesTotal.inc({ action: state });
      const level = STATE_LOG_LEVEL[state];
      this.log[level](
        {
          chain,
          previousState: previous ?? "unknown",
          newState: state,
          stake: info.stake.toString(),
          minStake: info.minStake.toString(),
          totalSlashed: info.totalSlashed.toString(),
        },
        `resolver registry status changed to ${state}`
      );
    }
  }
}
