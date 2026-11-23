/**
 * Typed Soroban HTLC event decoding.
 *
 * The Soroban HTLC contract emits three event kinds.  Topics are a
 * tuple prefixed with the event name symbol; the value is a separate
 * tuple.  Both arrive as raw `xdr.ScVal` objects from the RPC.
 *
 * Contract event shapes (from soroban/contracts/htlc/src/lib.rs):
 *
 *  created
 *    topics : (Symbol("created"), Address sender, Address beneficiary, BytesN<32> hashlock)
 *    value  : (u64 order_id, Address asset, i128 amount, i128 safety_deposit, u64 timelock)
 *
 *  claimed
 *    topics : (Symbol("claimed"), Address beneficiary, BytesN<32> hashlock)
 *    value  : (u64 order_id, Address caller, Bytes preimage, i128 amount, i128 safety_deposit)
 *
 *  refunded
 *    topics : (Symbol("refunded"), Address refund_address, BytesN<32> hashlock)
 *    value  : (u64 order_id, Address caller, i128 amount, i128 safety_deposit)
 *
 * `scValToNative` from @stellar/stellar-sdk converts ScVal trees to
 * plain JS values:
 *   Symbol  → string
 *   Address → string (strkey)
 *   u64     → BigInt
 *   i128    → BigInt
 *   Bytes / BytesN → Buffer / Uint8Array
 *   Vec/tuple → Array
 */

import { scValToNative, xdr } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Typed event interfaces
// ---------------------------------------------------------------------------

/** Emitted when a new HTLC order is funded on Soroban. */
export interface SorobanOrderCreatedEvent {
  /** Discriminant for exhaustive handler switches. */
  type: "created";
  ledger: number;
  txHash: string;
  contractId: string;
  /** Order identifier (u64 — fits in BigInt). */
  orderId: bigint;
  /** Address that locked the funds (Stellar strkey). */
  sender: string;
  /** Address entitled to claim by revealing the preimage. */
  beneficiary: string;
  /** The locked token contract address. */
  asset: string;
  /** Locked amount in the token's smallest unit (i128). */
  amount: bigint;
  /** Safety deposit in the token's smallest unit (i128). */
  safetyDeposit: bigint;
  /** sha256(preimage) as a hex string. */
  hashlock: string;
  /** Unix-second timestamp after which refund becomes valid (u64). */
  timelock: bigint;
}

/** Emitted when the beneficiary (or a relay) reveals the preimage. */
export interface SorobanOrderClaimedEvent {
  type: "claimed";
  ledger: number;
  txHash: string;
  contractId: string;
  orderId: bigint;
  /** Address that receives the locked amount. */
  beneficiary: string;
  /** Address that submitted the claim transaction. */
  caller: string;
  /** The revealed preimage as a hex string. */
  preimage: string;
  amount: bigint;
  safetyDeposit: bigint;
  /** sha256(preimage) as a hex string — matches the stored hashlock. */
  hashlock: string;
}

/** Emitted when the timelock expires and funds are returned. */
export interface SorobanOrderRefundedEvent {
  type: "refunded";
  ledger: number;
  txHash: string;
  contractId: string;
  orderId: bigint;
  /** Address that receives the refunded amount. */
  refundAddress: string;
  /** Address that submitted the refund transaction. */
  caller: string;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: string;
}

/** Union of all typed Soroban HTLC events. */
export type SorobanHtlcEvent =
  | SorobanOrderCreatedEvent
  | SorobanOrderClaimedEvent
  | SorobanOrderRefundedEvent;

// ---------------------------------------------------------------------------
// Decoding error — thrown on structural mismatches so callers can
// distinguish "unknown event kind" (soft skip) from "known event with
// wrong shape" (likely a contract version bump that needs attention).
// ---------------------------------------------------------------------------

export class SorobanEventDecodeError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly reason: string,
    public readonly raw?: unknown,
  ) {
    super(`[soroban-events] failed to decode "${eventName}" event: ${reason}`);
    this.name = "SorobanEventDecodeError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deserialise a base64-encoded XDR ScVal and convert it to a native
 * JS value via `scValToNative`.
 */
function decodeScVal(base64: string): unknown {
  try {
    const val = xdr.ScVal.fromXDR(base64, "base64");
    return scValToNative(val);
  } catch {
    throw new SorobanEventDecodeError(
      "unknown",
      "invalid base64-encoded XDR ScVal",
    );
  }
}

/**
 * Convert a raw value (Buffer, Uint8Array, or already a string) to a
 * lower-case hex string.  Used for hashlock and preimage bytes.
 */
function toHex(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    return Buffer.from(raw).toString("hex");
  }
  throw new TypeError(`expected bytes, got ${typeof raw}`);
}

/**
 * Like {@link toHex} but additionally rejects a zero-length byte sequence.
 * Used exclusively for the HTLC preimage field: a zero-length preimage is
 * structurally valid XDR yet semantically impossible — sha256("") can never
 * equal any real hashlock stored on-chain — so forwarding it would silently
 * corrupt downstream claim handling.
 */
function toNonEmptyHex(raw: unknown, field: string): string {
  const hex = toHex(raw);
  if (hex.length === 0) {
    throw new TypeError(`${field}: preimage must be non-empty bytes`);
  }
  return hex;
}

/**
 * Ensure a native value is BigInt; coerce from number for robustness.
 * Soroban u64 / i128 both decode to BigInt with scValToNative.
 */
export function toBigInt(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isSafeInteger(v)) {
      throw new RangeError(`Unsafe number: ${v} cannot be safely converted to bigint`);
    }
    return BigInt(v);
  }
  throw new TypeError(`${field}: expected bigint, got ${typeof v}`);
}

/** Assert the value is a non-empty string (Address / Symbol). */
function toStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "") {
    throw new TypeError(`${field}: expected non-empty string, got ${typeof v}`);
  }
  return v;
}

/** Assert the value is an array of a given minimum length. */
function toArray(v: unknown, minLen: number, ctx: string): unknown[] {
  if (!Array.isArray(v) || v.length < minLen) {
    throw new TypeError(
      `${ctx}: expected array[>=${minLen}], got ${Array.isArray(v) ? `array[${v.length}]` : typeof v}`,
    );
  }
  return v as unknown[];
}

// ---------------------------------------------------------------------------
// Per-event decoders
// ---------------------------------------------------------------------------

/**
 * Decode a raw "created" event.
 *
 * topics[0] = Symbol("created")  (consumed by the caller's dispatch)
 * topics[1] = Address sender
 * topics[2] = Address beneficiary
 * topics[3] = BytesN<32> hashlock
 *
 * value = Vec(u64 order_id, Address asset, i128 amount, i128 safety_deposit, u64 timelock)
 */
function decodeCreated(
  topics: string[],
  valueB64: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanOrderCreatedEvent {
  if (topics.length < 4) {
    throw new SorobanEventDecodeError(
      "created",
      `expected ≥4 topic ScVals, got ${topics.length}`,
    );
  }

  let sender: string;
  let beneficiary: string;
  let hashlock: string;
  try {
    sender = toStr(decodeScVal(topics[1]!), "sender");
    beneficiary = toStr(decodeScVal(topics[2]!), "beneficiary");
    hashlock = toHex(decodeScVal(topics[3]!));
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "created",
      `topic decode failed: ${(e as Error).message}`,
      topics,
    );
  }

  let val: unknown[];
  try {
    val = toArray(decodeScVal(valueB64), 5, "value");
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "created",
      `value decode failed: ${(e as Error).message}`,
      valueB64,
    );
  }

  try {
    return {
      type: "created",
      ...meta,
      orderId: toBigInt(val[0], "order_id"),
      asset: toStr(val[1], "asset"),
      amount: toBigInt(val[2], "amount"),
      safetyDeposit: toBigInt(val[3], "safety_deposit"),
      timelock: toBigInt(val[4], "timelock"),
      sender,
      beneficiary,
      hashlock,
    };
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "created",
      `value field decode failed: ${(e as Error).message}`,
      val,
    );
  }
}

/**
 * Decode a raw "claimed" event.
 *
 * topics[0] = Symbol("claimed")
 * topics[1] = Address beneficiary
 * topics[2] = BytesN<32> hashlock
 *
 * value = Vec(u64 order_id, Address caller, Bytes preimage, i128 amount, i128 safety_deposit)
 */
function decodeClaimed(
  topics: string[],
  valueB64: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanOrderClaimedEvent {
  if (topics.length < 3) {
    throw new SorobanEventDecodeError(
      "claimed",
      `expected ≥3 topic ScVals, got ${topics.length}`,
    );
  }

  let beneficiary: string;
  let hashlock: string;
  try {
    beneficiary = toStr(decodeScVal(topics[1]!), "beneficiary");
    hashlock = toHex(decodeScVal(topics[2]!));
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "claimed",
      `topic decode failed: ${(e as Error).message}`,
      topics,
    );
  }

  let val: unknown[];
  try {
    val = toArray(decodeScVal(valueB64), 5, "value");
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "claimed",
      `value decode failed: ${(e as Error).message}`,
      valueB64,
    );
  }

  try {
    return {
      type: "claimed",
      ...meta,
      orderId: toBigInt(val[0], "order_id"),
      caller: toStr(val[1], "caller"),
      preimage: toNonEmptyHex(val[2], "preimage"),
      amount: toBigInt(val[3], "amount"),
      safetyDeposit: toBigInt(val[4], "safety_deposit"),
      beneficiary,
      hashlock,
    };
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "claimed",
      `value field decode failed: ${(e as Error).message}`,
      val,
    );
  }
}

/**
 * Decode a raw "refunded" event.
 *
 * topics[0] = Symbol("refunded")
 * topics[1] = Address refund_address
 * topics[2] = BytesN<32> hashlock
 *
 * value = Vec(u64 order_id, Address caller, i128 amount, i128 safety_deposit)
 */
function decodeRefunded(
  topics: string[],
  valueB64: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanOrderRefundedEvent {
  if (topics.length < 3) {
    throw new SorobanEventDecodeError(
      "refunded",
      `expected ≥3 topic ScVals, got ${topics.length}`,
    );
  }

  let refundAddress: string;
  let hashlock: string;
  try {
    refundAddress = toStr(decodeScVal(topics[1]!), "refund_address");
    hashlock = toHex(decodeScVal(topics[2]!));
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "refunded",
      `topic decode failed: ${(e as Error).message}`,
      topics,
    );
  }

  let val: unknown[];
  try {
    val = toArray(decodeScVal(valueB64), 4, "value");
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "refunded",
      `value decode failed: ${(e as Error).message}`,
      valueB64,
    );
  }

  try {
    return {
      type: "refunded",
      ...meta,
      orderId: toBigInt(val[0], "order_id"),
      caller: toStr(val[1], "caller"),
      amount: toBigInt(val[2], "amount"),
      safetyDeposit: toBigInt(val[3], "safety_deposit"),
      refundAddress,
      hashlock,
    };
  } catch (e: unknown) {
    throw new SorobanEventDecodeError(
      "refunded",
      `value field decode failed: ${(e as Error).message}`,
      val,
    );
  }
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Decode a raw Soroban contract event into a typed `SorobanHtlcEvent`.
 *
 * @param topics  Array of base64-encoded XDR ScVal strings — as
 *                returned by `ev.topic.map(t => t.toXDR("base64"))`.
 * @param value   Base64-encoded XDR ScVal for the event value.
 * @param meta    Ledger, tx hash and contract id for the event.
 *
 * @returns The typed event, or `null` when the first topic is a
 *          symbol that does not belong to the HTLC contract (e.g.
 *          admin / config events that the resolver doesn't handle).
 *
 * @throws  `SorobanEventDecodeError` when the event name is known
 *          (created / claimed / refunded) but the payload doesn't
 *          match the expected shape — so callers can distinguish a
 *          "skip unknown" case from a "schema mismatch" alert.
 */
export function decodeSorobanHtlcEvent(
  topics: string[],
  value: string,
  meta: { ledger: number; txHash: string; contractId: string },
): SorobanHtlcEvent | null {
  if (topics.length === 0) return null;

  // The first topic is always the event name symbol.
  let eventName: unknown;
  try {
    eventName = decodeScVal(topics[0]!);
  } catch {
    return null; // unparseable topic — skip silently
  }

  if (typeof eventName !== "string") return null;

  switch (eventName) {
    case "created":
      return decodeCreated(topics, value, meta);
    case "claimed":
      return decodeClaimed(topics, value, meta);
    case "refunded":
      return decodeRefunded(topics, value, meta);
    default:
      // e.g. "adm_xfer" or "cfg" — not HTLC order events, skip.
      return null;
  }
}
import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { type Logger } from "pino";
import type { ResolverConfig } from "../config.js";
import {
  eventsTotal,
  listenerErrorsTotal,
  listenerLastEventTimestampSeconds,
  activeListeners,
} from "../metrics.js";
import { globalStalenessMonitor } from "../telemetry.js";

const CHAIN = "ethereum";

/**
 * Maximum number of event keys retained in the deduplication Set before it is
 * pruned.  Events are emitted at most once per block and the resolver is
 * observe-only, so a window of 10 000 keys is large enough to survive any
 * realistic listener restart without growing without bound.
 */
const DEDUP_MAX_SIZE = 10_000;

/**
 * Build the deduplication key for an Ethereum HTLC event.
 *
 * We key on `txHash:eventType` because a single transaction can contain at
 * most one event of each type for a given contract, so this is sufficient to
 * deduplicate replayed events across listener restarts.
 */
function dedupKey(txHash: string, eventType: string): string {
  return `${txHash}:${eventType}`;
}

/**
 * Stream HTLCEscrow events from the configured Ethereum chain.
 *
 * This listener only OBSERVES — it does not submit transactions. Acting
 * on observed events (e.g. claiming on the opposite chain when a
 * preimage is revealed) is the resolver runtime's job and lives outside
 * this listener so it can be tested independently.
 *
 * ## Deduplication
 *
 * `viem.watchEvent` may replay recently seen logs when the WebSocket
 * reconnects or the listener is restarted by the Supervisor.  A
 * `processedEvents` Set (keyed by `txHash:eventType`) guards every handler
 * dispatch and silently drops duplicates after emitting a debug log.  The
 * Set is bounded to `DEDUP_MAX_SIZE` entries; the oldest half is evicted
 * when the limit is reached so memory stays bounded across long uptimes.
 */
export class EthereumListener {
  private readonly client: PublicClient;
  private readonly log: Logger;
  private readonly cfg: ResolverConfig;
  private unwatchOrderCreated?: () => void;
  private unwatchOrderClaimed?: () => void;
  private unwatchOrderRefunded?: () => void;

  /**
   * Cross-restart deduplication Set.  Lives on the instance so that it
   * survives Supervisor-driven restarts (the Supervisor reuses the same
   * listener instance on each restart attempt).
   */
  private readonly processedEvents = new Set<string>();

  constructor(cfg: ResolverConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child({ component: "EthereumListener" });
    this.client = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl)
    });
  }

  // ── Deduplication helpers ─────────────────────────────────────────────────

  /**
   * Returns true when the event has already been processed.
   * Inserts the key into the Set when it is new.
   * Evicts the oldest half of entries once the Set exceeds DEDUP_MAX_SIZE.
   */
  private isDuplicate(txHash: string, eventType: string): boolean {
    const key = dedupKey(txHash, eventType);
    if (this.processedEvents.has(key)) {
      return true;
    }
    // Prune before inserting to keep the Set bounded.
    if (this.processedEvents.size >= DEDUP_MAX_SIZE) {
      const half = DEDUP_MAX_SIZE / 2;
      let pruned = 0;
      for (const k of this.processedEvents) {
        this.processedEvents.delete(k);
        pruned++;
        if (pruned >= half) break;
      }
      this.log.debug({ pruned, remaining: this.processedEvents.size }, "pruned dedup Set");
    }
    this.processedEvents.add(key);
    return false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(handlers: EthereumEventHandlers): Promise<void> {
    if (!this.cfg.ethereum.htlcEscrow) {
      this.log.warn("ETH_HTLC_ESCROW address not configured — skipping Ethereum listener");
      return;
    }
    await this.stop();

    const address = this.cfg.ethereum.htlcEscrow;
    this.log.info({ chainId: this.cfg.ethereum.chainId, contract: address }, "starting Ethereum listener");
    activeListeners.set({ chain: CHAIN }, 1);
    globalStalenessMonitor.recordStarted(CHAIN);

    const orderCreated = parseAbiItem(
      "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
    );
    const orderClaimed = parseAbiItem(
      "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
    );
    const orderRefunded = parseAbiItem(
      "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
    );

    this.unwatchOrderCreated = this.client.watchEvent({
      address,
      event: orderCreated,
      onLogs: (logs) => {
        for (const log of logs) {
          const txHash = log.transactionHash ?? "";
          const eventType = "order_created";

          // ── Deduplication guard ─────────────────────────────────────────
          if (this.isDuplicate(txHash, eventType)) {
            this.log.debug(
              { txHash, orderId: String(log.args.orderId), eventType },
              "duplicate Ethereum event dropped (already processed)"
            );
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "duplicate_event" });
            continue;
          }

          eventsTotal.inc({ chain: CHAIN, event_type: eventType });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN }, Math.floor(Date.now() / 1000));
          globalStalenessMonitor.recordHealthyTick(CHAIN);
          try {
            handlers.onOrderCreated({
              orderId: log.args.orderId!,
              sender: log.args.sender!,
              beneficiary: log.args.beneficiary!,
              token: log.args.token!,
              amount: log.args.amount!,
              safetyDeposit: log.args.safetyDeposit!,
              hashlock: log.args.hashlock!,
              timelock: log.args.timelock!,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash
            });
          } catch (err) {
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "handler_error" });
            this.log.warn({ err }, "onOrderCreated handler failed");
          }
        }
      }
    });

    this.unwatchOrderClaimed = this.client.watchEvent({
      address,
      event: orderClaimed,
      onLogs: (logs) => {
        for (const log of logs) {
          const txHash = log.transactionHash ?? "";
          const eventType = "order_claimed";

          // ── Deduplication guard ─────────────────────────────────────────
          if (this.isDuplicate(txHash, eventType)) {
            this.log.debug(
              { txHash, orderId: String(log.args.orderId), eventType },
              "duplicate Ethereum event dropped (already processed)"
            );
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "duplicate_event" });
            continue;
          }

          eventsTotal.inc({ chain: CHAIN, event_type: eventType });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN }, Math.floor(Date.now() / 1000));
          globalStalenessMonitor.recordHealthyTick(CHAIN);
          try {
            handlers.onOrderClaimed({
              orderId: log.args.orderId!,
              claimer: log.args.claimer!,
              preimage: log.args.preimage!,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash
            });
          } catch (err) {
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "handler_error" });
            this.log.warn({ err }, "onOrderClaimed handler failed");
          }
        }
      }
    });

    this.unwatchOrderRefunded = this.client.watchEvent({
      address,
      event: orderRefunded,
      onLogs: (logs) => {
        for (const log of logs) {
          const txHash = log.transactionHash ?? "";
          const eventType = "order_refunded";

          // ── Deduplication guard ─────────────────────────────────────────
          if (this.isDuplicate(txHash, eventType)) {
            this.log.debug(
              { txHash, orderId: String(log.args.orderId), eventType },
              "duplicate Ethereum event dropped (already processed)"
            );
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "duplicate_event" });
            continue;
          }

          eventsTotal.inc({ chain: CHAIN, event_type: eventType });
          listenerLastEventTimestampSeconds.set({ chain: CHAIN }, Math.floor(Date.now() / 1000));
          globalStalenessMonitor.recordHealthyTick(CHAIN);
          try {
            handlers.onOrderRefunded({
              orderId: log.args.orderId!,
              caller: log.args.caller!,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash
            });
          } catch (err) {
            listenerErrorsTotal.inc({ chain: CHAIN, error_type: "handler_error" });
            this.log.warn({ err }, "onOrderRefunded handler failed");
          }
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.unwatchOrderCreated?.();
    this.unwatchOrderClaimed?.();
    this.unwatchOrderRefunded?.();
    activeListeners.set({ chain: CHAIN }, 0);
    globalStalenessMonitor.recordStopped(CHAIN);
  }
}

export interface EthereumOrderCreatedEvent {
  orderId: bigint;
  sender: `0x${string}`;
  beneficiary: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: `0x${string}`;
  timelock: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface EthereumOrderClaimedEvent {
  orderId: bigint;
  claimer: `0x${string}`;
  preimage: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface EthereumOrderRefundedEvent {
  orderId: bigint;
  caller: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface EthereumEventHandlers {
  onOrderCreated(e: EthereumOrderCreatedEvent): void;
  onOrderClaimed(e: EthereumOrderClaimedEvent): void;
  onOrderRefunded(e: EthereumOrderRefundedEvent): void;
}
