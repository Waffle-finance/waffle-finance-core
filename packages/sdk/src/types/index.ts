export type Chain = "ethereum" | "stellar" | "solana";
export type Direction =
  | "eth_to_xlm"
  | "xlm_to_eth"
  | "eth_to_sol"
  | "sol_to_eth"
  | "xlm_to_sol"
  | "sol_to_xlm";

/**
 * Canonical order lifecycle vocabulary.
 *
 * This is the single source of truth for how an order's state is *named*
 * across the SDK, coordinator services, and frontend. The coordinator's
 * `OrderStatus` (orders-repo.ts) and the shared state machine
 * {@link ../state-machine/index.ts} are pinned to this list by conformance
 * tests — adding a status here without updating those consumers surfaces as
 * a test failure rather than silently divergent UI.
 */
export const ORDER_STATUSES = [
  "announced",
  "src_locked",
  "dst_locked",
  "secret_revealed",
  "completed",
  "refunded",
  "failed",
  "expired",
  "cancelled",
  "abandoned",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Statuses from which no further progression is possible.
 *
 * These mirror the empty-next-state terminal set of the state machine
 * ({@link ../state-machine/index.ts isTerminal}); the conformance suite keeps
 * the two in lock-step.
 */
export const TERMINAL_ORDER_STATUSES = [
  "completed",
  "refunded",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export type TerminalOrderStatus = (typeof TERMINAL_ORDER_STATUSES)[number];

/** Runtime guard: is `value` one of the canonical order status atoms? */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly unknown[]).includes(value);
}

/** Cross-chain swap order as visible to clients of the SDK. */
export interface Order {
  publicId: string;
  direction: Direction;
  status: OrderStatus;
  hashlock: `0x${string}`;
  src: ChainLeg;
  dst: ChainLeg;
  preimage: `0x${string}` | null;
}

export interface ChainLeg {
  chain: Chain;
  address: string;
  asset: string;
  /** Atomic units, decimal string. */
  amount: string;
  /** Atomic units, decimal string. */
  safetyDeposit?: string;
  /** On-chain order id once the leg is locked. */
  orderId?: string | null;
  /** Tx hash that created the on-chain lock. */
  lockTx?: string | null;
  /** Absolute timelock as unix seconds. */
  timelock?: number | null;
}

/** Resolver listing entry returned by the coordinator. */
export interface ResolverInfo {
  address: string;
  chain: Chain;
  stake: string;
  active: boolean;
  registeredAt: number;
}

// ---------------------------------------------------------------
// External bridge route composability (v2.0 interface, v2.1 fillout)
// ---------------------------------------------------------------
//
// WaffleFinance's atomic HTLC swap is one of several ways to move value
// between Ethereum and Stellar. CCTP v2 (USDC burn-and-mint) and
// Axelar ITS (validator-set wrapped tokens) handle different asset
// classes with different trust models. For some swaps, routing a leg
// through one of those external bridges is strictly better for the
// user (e.g. native USDC via CCTP v2 instead of a WaffleFinance USDC
// hop).
//
// We expose the route abstraction in v2.0 even though no provider is
// wired up yet, so that v2.1 implementations can ship as additive
// adapters without breaking SDK consumers. A frontend or coordinator
// can iterate `getAvailableRoutes(...)` and present the user with
// "WaffleFinance HTLC" vs "CCTP v2 fast path" choices, and the SDK
// orchestrates whichever the user picks.
//
// v2.0 ships a single built-in route (`wafflefinance-htlc`). Adapters for
// `cctp-v2` and `axelar-its` arrive during the Q1 2027 mainnet
// tranche (see ROADMAP.md).

export type ExternalBridgeKind = "wafflefinance-htlc" | "cctp-v2" | "axelar-its";

/**
 * A candidate route for moving value between two chains. Routes are
 * additive and may be composed: a swap can use WaffleFinance HTLC for the
 * native-asset leg and CCTP v2 for the USDC leg in the same
 * cross-chain operation.
 */
export interface ExternalBridgeRoute {
  /** Stable identifier for the routing engine. */
  kind: ExternalBridgeKind;

  /** Human-readable label for UI presentation. */
  label: string;

  /** Source chain leg as seen by the user. */
  src: ChainLeg;

  /** Destination chain leg as seen by the user. */
  dst: ChainLeg;

  /**
   * Trust assumptions disclosed alongside the route. Surfacing this
   * forces every adapter author to be explicit about what the user
   * is opting into.
   */
  trust: {
    /** Set of off-chain actors whose compromise would let funds be stolen. */
    trustedParties: string[];
    /** True if the locked funds are recoverable without any off-chain actor. */
    permissionlessRefund: boolean;
  };

  /**
   * Expected settlement window in seconds. For WaffleFinance HTLC this is
   * dominated by the destination-side timelock and the user's claim
   * latency; for attestation-style bridges it is dominated by the
   * attester latency.
   */
  estimatedSettlementSeconds: number;

  /**
   * Adapter-specific extension blob. Adapters are expected to
   * extend this interface with their own typed payload via
   * declaration merging.
   */
  extra?: Record<string, unknown>;
}

/**
 * Optional adapter contract implemented by external-bridge plugins.
 * v2.0 does not ship any third-party implementations; we define the
 * shape now so that v2.1 plugins are non-breaking.
 */
export interface ExternalBridgeAdapter {
  kind: ExternalBridgeKind;
  /** Return zero or more routes this adapter can serve for the given pair. */
  quote(params: {
    direction: Direction;
    srcAsset: string;
    dstAsset: string;
    amount: string;
  }): Promise<ExternalBridgeRoute[]>;
}
