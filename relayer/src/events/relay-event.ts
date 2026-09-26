/**
 * Normalized relay event contract for the WaffleFinance relayer.
 *
 * Motivation
 * ──────────
 * The relayer has multiple event entry points — Ethereum contract events,
 * Solana program logs, Soroban/Stellar events — each of which previously
 * produced ad hoc payloads with different field names, different null
 * conventions, and different routing assumptions. Downstream service logic
 * therefore accumulated chain-specific branches that obscured intent and
 * made it difficult to add new chains without risk of regression.
 *
 * This module defines ONE event shape that all listeners must produce before
 * passing events to the relay service layer. The normalization step is the
 * single seam where chain-specific quirks are isolated: everything downstream
 * of `NormalizedRelayEvent` is chain-agnostic.
 *
 * Contract
 * ────────
 * • `sourceChain` identifies the chain that emitted the raw event.
 * • `eventKind` is a closed union so downstream switch statements are
 *   exhaustive by type rather than by convention.
 * • `orderId` and `txHash` are always present as strings or explicit nulls —
 *   never `undefined`.
 * • `routingMeta` carries chain-specific supplemental fields that the relay
 *   engine may need without widening the primary schema.
 * • The entire envelope is JSON-serialisable with no Date or bigint values.
 */

// ── Schema versioning ─────────────────────────────────────────────────────────

/**
 * Current schema version for {@link NormalizedRelayEvent}.
 *
 * Bump this constant whenever a field is added, removed, or changes type in
 * `NormalizedRelayEvent`.  Listeners must handle events at any version ≤ this
 * value — use {@link parseLegacyRelayEvent} to upgrade older envelopes to the
 * current shape before passing them to version-agnostic service logic.
 *
 * Version history
 *  v0 (legacy) — original unversioned shape; no `schemaVersion` field.
 *  v1 (current) — explicit `schemaVersion: 1` added to every envelope.
 */
export const RELAY_EVENT_SCHEMA_VERSION = 1 as const;
export type RelayEventSchemaVersion = typeof RELAY_EVENT_SCHEMA_VERSION;

/** Schema version produced by the original (pre-versioning) relay listeners. */
export const LEGACY_RELAY_EVENT_SCHEMA_VERSION = 0 as const;

// ── Source chains ─────────────────────────────────────────────────────────────

export type RelaySourceChain =
  | 'ethereum'
  | 'solana'
  | 'stellar'
  | 'soroban';

// ── Event kinds ───────────────────────────────────────────────────────────────

/**
 * Exhaustive set of domain-relevant events the relayer handles.
 *
 * Names follow `<noun>_<verb_past>` to be unambiguous as past-tense facts.
 */
export type RelayEventKind =
  /** A new cross-chain order was created on the source chain. */
  | 'order_created'
  /** Funds were locked in an HTLC on the source or destination chain. */
  | 'funds_locked'
  /** The HTLC preimage was revealed, completing the swap. */
  | 'secret_revealed'
  /** An order was claimed (partial or full fill). */
  | 'order_claimed'
  /** An order expired without being filled; refund is available. */
  | 'order_expired'
  /** An order was refunded after expiry. */
  | 'order_refunded'
  /** A settlement receipt was confirmed on-chain. */
  | 'settlement_confirmed';

// ── Routing metadata ──────────────────────────────────────────────────────────

/**
 * Chain-specific supplemental fields that the relay engine may need.
 * Consumers should treat every field as optional and never branch on
 * the absence of a field as a business signal — use `eventKind` for that.
 */
export interface RelayEventRoutingMeta {
  /** Ethereum/EVM block number at which the event was emitted. */
  blockNumber?: number;
  /** Ethereum/EVM log index within the transaction. */
  logIndex?: number;
  /** Solana slot at which the event was observed. */
  slot?: number;
  /** Stellar/Soroban ledger sequence. */
  ledgerSequence?: number;
  /** Hashlock (bytes32 hex) from an HTLC event. */
  hashlock?: string | null;
  /** Timelock expiry (unix seconds) from an HTLC event. */
  timelock?: number | null;
  /** Fee rate basis points from the order. */
  feeRateBps?: number | null;
  /** Whether the order allows partial fills. */
  partialFillEnabled?: boolean | null;
  /** Resolver/relayer address involved in the event. */
  resolverAddress?: string | null;
  /** Amount expressed as a decimal string (no bigint). */
  amount?: string | null;
  /** Token contract address (for EVM token events). */
  tokenAddress?: string | null;
}

// ── Normalized event ──────────────────────────────────────────────────────────

/**
 * The one event shape that all listeners must produce.
 *
 * Required fields are always present. Optional fields are typed `| null` and
 * never `undefined` so the envelope survives JSON round-trips without gaps.
 *
 * `schemaVersion` identifies the envelope layout.  Listeners receiving
 * events from older relayer instances (before versioning was added) may see
 * events without this field; call {@link parseLegacyRelayEvent} to normalise
 * them before processing.
 */
export interface NormalizedRelayEvent {
  /** Envelope schema version.  See {@link RELAY_EVENT_SCHEMA_VERSION}. */
  schemaVersion: RelayEventSchemaVersion;
  /** Which chain emitted the raw event. */
  sourceChain: RelaySourceChain;
  /** Semantic classification of the event. */
  eventKind: RelayEventKind;
  /**
   * Coordinator public order ID (wf_0x…) when known, or the raw on-chain
   * order identifier for new-order events before the coordinator has assigned
   * a public ID. Never null — every relay event concerns a specific order.
   */
  orderId: string;
  /** Transaction hash that contained the event. Null when not applicable. */
  txHash: string | null;
  /** Unix ms when the event was observed (not when the block was mined). */
  observedAt: number;
  /** Chain-specific supplemental context. Never null; may be an empty object. */
  routingMeta: RelayEventRoutingMeta;
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/**
 * Build a `NormalizedRelayEvent` with safe defaults for optional fields.
 * All listeners MUST go through this factory rather than constructing the
 * object literal directly — the factory is the enforcement point for the
 * `schemaVersion`, `observedAt` timestamp, and the `routingMeta` default.
 */
export function createRelayEvent(
  input: Omit<NormalizedRelayEvent, 'schemaVersion' | 'observedAt' | 'routingMeta'> &
    Partial<Pick<NormalizedRelayEvent, 'schemaVersion' | 'observedAt' | 'routingMeta'>>
): NormalizedRelayEvent {
  return {
    schemaVersion: RELAY_EVENT_SCHEMA_VERSION,
    sourceChain: input.sourceChain,
    eventKind: input.eventKind,
    orderId: input.orderId,
    txHash: input.txHash ?? null,
    observedAt: input.observedAt ?? Date.now(),
    routingMeta: input.routingMeta ?? {},
  };
}

/**
 * Upgrade a legacy (v0) relay event envelope — one produced before schema
 * versioning was introduced — to the current {@link NormalizedRelayEvent} shape.
 *
 * Pass any object that satisfies the pre-version contract (all fields present
 * except `schemaVersion`).  The returned event carries
 * `schemaVersion: RELAY_EVENT_SCHEMA_VERSION` and is safe to process with
 * version-aware consumers.
 *
 * Use this at deserialization boundaries (e.g. when reading from a message
 * queue that may contain events emitted by an older relayer instance).
 */
export function parseLegacyRelayEvent(
  raw: Omit<NormalizedRelayEvent, 'schemaVersion'> & { schemaVersion?: number }
): NormalizedRelayEvent {
  return {
    schemaVersion: RELAY_EVENT_SCHEMA_VERSION,
    sourceChain: raw.sourceChain,
    eventKind: raw.eventKind,
    orderId: raw.orderId,
    txHash: raw.txHash ?? null,
    observedAt: raw.observedAt,
    routingMeta: raw.routingMeta ?? {},
  };
}

/** Convenience factory for Ethereum HTLC order-created events. */
export function createEthOrderCreatedEvent(opts: {
  orderId: string;
  txHash: string;
  blockNumber: number;
  hashlock: string;
  timelock: number;
  amount: string;
  tokenAddress: string;
  feeRateBps: number;
  partialFillEnabled: boolean;
}): NormalizedRelayEvent {
  return createRelayEvent({
    sourceChain: 'ethereum',
    eventKind: 'order_created',
    orderId: opts.orderId,
    txHash: opts.txHash,
    routingMeta: {
      blockNumber: opts.blockNumber,
      hashlock: opts.hashlock,
      timelock: opts.timelock,
      amount: opts.amount,
      tokenAddress: opts.tokenAddress,
      feeRateBps: opts.feeRateBps,
      partialFillEnabled: opts.partialFillEnabled,
    },
  });
}

/** Convenience factory for Ethereum HTLC order-claimed/filled events. */
export function createEthOrderClaimedEvent(opts: {
  orderId: string;
  txHash: string;
  blockNumber: number;
  amount: string;
  resolverAddress: string;
}): NormalizedRelayEvent {
  return createRelayEvent({
    sourceChain: 'ethereum',
    eventKind: 'order_claimed',
    orderId: opts.orderId,
    txHash: opts.txHash,
    routingMeta: {
      blockNumber: opts.blockNumber,
      amount: opts.amount,
      resolverAddress: opts.resolverAddress,
    },
  });
}

/** Convenience factory for Ethereum HTLC order-refunded events. */
export function createEthOrderRefundedEvent(opts: {
  orderId: string;
  txHash: string;
  blockNumber: number;
  amount: string;
}): NormalizedRelayEvent {
  return createRelayEvent({
    sourceChain: 'ethereum',
    eventKind: 'order_refunded',
    orderId: opts.orderId,
    txHash: opts.txHash,
    routingMeta: {
      blockNumber: opts.blockNumber,
      amount: opts.amount,
    },
  });
}

/** Convenience factory for Stellar/Soroban settlement-confirmed events. */
export function createStellarSettlementEvent(opts: {
  orderId: string;
  txHash: string;
  ledgerSequence: number;
  hashlock?: string | null;
}): NormalizedRelayEvent {
  return createRelayEvent({
    sourceChain: 'soroban',
    eventKind: 'settlement_confirmed',
    orderId: opts.orderId,
    txHash: opts.txHash,
    routingMeta: {
      ledgerSequence: opts.ledgerSequence,
      hashlock: opts.hashlock ?? null,
    },
  });
}

/** Convenience factory for Solana program events. */
export function createSolanaOrderEvent(opts: {
  orderId: string;
  txHash: string;
  slot: number;
  eventKind: RelayEventKind;
  hashlock?: string | null;
}): NormalizedRelayEvent {
  return createRelayEvent({
    sourceChain: 'solana',
    eventKind: opts.eventKind,
    orderId: opts.orderId,
    txHash: opts.txHash,
    routingMeta: {
      slot: opts.slot,
      hashlock: opts.hashlock ?? null,
    },
  });
}

// ── Type guard ────────────────────────────────────────────────────────────────

const VALID_KINDS: readonly RelayEventKind[] = [
  'order_created',
  'funds_locked',
  'secret_revealed',
  'order_claimed',
  'order_expired',
  'order_refunded',
  'settlement_confirmed',
];

export function isValidRelayEventKind(v: unknown): v is RelayEventKind {
  return typeof v === 'string' && (VALID_KINDS as string[]).includes(v);
}

const VALID_CHAINS: readonly RelaySourceChain[] = ['ethereum', 'solana', 'stellar', 'soroban'];

export function isValidRelaySourceChain(v: unknown): v is RelaySourceChain {
  return typeof v === 'string' && (VALID_CHAINS as string[]).includes(v);
}

/**
 * True when the object satisfies the `NormalizedRelayEvent` contract.
 *
 * `schemaVersion` may be absent (legacy v0 events) or a number — both are
 * accepted so this guard can be used at deserialization boundaries that may
 * receive events from older relayer instances.  Use
 * {@link parseLegacyRelayEvent} to normalise v0 events before passing them
 * to version-aware processing logic.
 */
export function isNormalizedRelayEvent(v: unknown): v is NormalizedRelayEvent {
  if (!v || typeof v !== 'object') return false;
  const ev = v as Record<string, unknown>;
  return (
    isValidRelaySourceChain(ev.sourceChain) &&
    isValidRelayEventKind(ev.eventKind) &&
    typeof ev.orderId === 'string' &&
    ev.orderId.length > 0 &&
    (ev.txHash === null || typeof ev.txHash === 'string') &&
    typeof ev.observedAt === 'number' &&
    ev.routingMeta !== null &&
    typeof ev.routingMeta === 'object' &&
    (ev.schemaVersion === undefined || typeof ev.schemaVersion === 'number')
  );
}
