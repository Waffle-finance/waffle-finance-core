/**
 * @fileoverview Replay-safe event deduplication for relayer processing.
 *
 * Problem (#1085)
 * ---------------
 * Event delivery can be duplicated after a provider reconnects or after a
 * transaction replacement (e.g. fee-bumped EVM tx that resubmits with a new
 * hash, or a Solana signature that is re-observed after a reconnect). The
 * relayer must treat an already-applied event as idempotent (no second
 * transaction side effect) while still *detecting* a *conflicting* event for
 * the same order and surfacing it for investigation rather than silently
 * ignoring it.
 *
 * Solution
 * --------
 * `RelayEventDeduplicator` standardizes event identity at the relayer
 * processing boundary and tracks every applied event. Identity is
 * *chain-qualified* and built from the transaction/signature, the position
 * within that transaction (EVM log index, Solana slot, Soroban ledger
 * sequence), and the event kind — matching the fields already carried by
 * {@link NormalizedRelayEvent}. Two deliveries of the same on-chain event
 * therefore collapse to one identity; two genuinely different events do not.
 *
 * Deduplication is bounded and lives in-process by default (consistent with
 * the coordinator's own in-process `processedEventKeys` cache). An optional
 * durable backing directory mirrors the disk pattern used by the relayer's
 * `IdempotencyManager` and `TxStateStore` so applied events survive a restart
 * and an overlapping replay window after a restart is still a no-op.
 *
 * Conflict detection
 * ------------------
 * The relayer records, per order, the terminal event kind that has already been
 * applied (e.g. `order_claimed`, `order_refunded`, `settlement_confirmed`).
 * When a *different* event for the same order arrives that contradicts the
 * recorded terminal state — for example an `order_refunded` arriving after an
 * `order_claimed` — the deduplicator does not apply it, logs a structured
 * warning, and surfaces a {@link RelayEventConflict} so an operator can
 * investigate instead of the event vanishing silently.
 *
 * The coordinator's listener uses the simpler `"<eventType>:<txHash>"` key
 * (see `coordinator/src/listeners/ethereum-listener.ts`). This module is
 * intentionally richer — it adds the chain qualifier, the within-transaction
 * position, and cross-event conflict detection — because the relayer is the
 * last boundary before a chain transaction side effect is produced.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { getLogger } from '../logger.js';
import {
  RELAY_EVENT_SCHEMA_VERSION,
  type NormalizedRelayEvent,
  type RelayEventKind,
  type RelaySourceChain,
} from './relay-event.js';

const log = getLogger().child({ component: 'event-dedup' });

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default cap on the number of applied-event identities retained in memory.
 * Sized to comfortably cover an overlapping replay window (a re-scan that
 * overlaps already-processed blocks) for a long-running process without
 * unbounded growth. Each entry is a short string key plus a small record.
 */
const DEFAULT_MAX_APPLIED = 10_000;

/**
 * Event kinds that mark an order as having reached a terminal lifecycle state.
 * A subsequent *different* event that contradicts one of these is a conflict.
 *
 * `order_expired` is intentionally NOT terminal here: an expired order may
 * legitimately be refunded afterwards, so `order_expired` → `order_refunded`
 * is a normal progression, not a conflict.
 */
const TERMINAL_KINDS: ReadonlySet<RelayEventKind> = new Set<RelayEventKind>([
  'order_claimed',
  'order_refunded',
  'settlement_confirmed',
]);

/**
 * Pairs of terminal kinds that cannot both be true for the same order.
 * Stored as a set of `"a|b"` strings with both orderings so lookup is
 * order-independent.
 */
const CONTRADICTORY_PAIRS: ReadonlySet<string> = new Set<string>([
  'order_claimed|order_refunded',
  'order_refunded|order_claimed',
  'order_claimed|settlement_confirmed',
  'settlement_confirmed|order_claimed',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Chain-qualified identity for a single on-chain event delivery.
 *
 * Format: `"<sourceChain>:<eventKind>:<txHash|signature>:<position>"` where
 * `position` is the EVM log index, Solana slot, or Soroban ledger sequence —
 * the within-transaction coordinate that distinguishes two events emitted in
 * the same transaction. When no positional coordinate is available the block
 * number is used as a fallback so the identity still collides only for true
 * duplicates.
 */
export type RelayEventIdentity = string;

/** A previously-applied event, retained for duplicate lookup and audit. */
export interface AppliedRelayEvent {
  identity: RelayEventIdentity;
  orderId: string;
  sourceChain: RelaySourceChain;
  eventKind: RelayEventKind;
  txHash: string | null;
  observedAt: number;
  terminal: boolean;
}

/**
 * Describes a contradictory event for an order that already reached a
 * different terminal state. Surfaced (and logged) rather than applied.
 */
export interface RelayEventConflict {
  /** Order that already reached a terminal state. */
  orderId: string;
  /** Terminal kind already applied for this order. */
  existingTerminalKind: RelayEventKind;
  /** The new event kind that contradicts the existing terminal. */
  newEventKind: RelayEventKind;
  /** Identity of the existing applied event. */
  existingIdentity: RelayEventIdentity;
  /** Identity of the newly-arrived conflicting event. */
  newIdentity: RelayEventIdentity;
  /** Why the pair is contradictory (human-readable, no secrets). */
  reason: string;
}

/**
 * Outcome of {@link RelayEventDeduplicator.process}.
 *
 * Exactly one of the boolean flags is true:
 *   - `duplicate`  — this exact event was already applied; skip the side effect.
 *   - `conflict`    — a different event for this order contradicts a recorded
 *                     terminal state; skip the side effect and investigate.
 *   - otherwise    — the event is novel and safe to apply (`shouldApply: true`).
 */
export interface DedupResult {
  /** Stable identity computed for the event. */
  identity: RelayEventIdentity;
  /** True when this exact event identity was already applied. */
  duplicate: boolean;
  /** Present when the event contradicts a recorded terminal state. */
  conflict?: RelayEventConflict;
  /** True when the caller should apply the event (produce the side effect). */
  shouldApply: boolean;
}

// ── Identity helpers ──────────────────────────────────────────────────────────

/**
 * The within-transaction position carried by a normalized event, or `null`
 * when none is present. EVM events use `logIndex`, Solana uses `slot`, and
 * Soroban/Stellar use `ledgerSequence`; `blockNumber` is the fallback so two
 * deliveries of the same event still collapse to one identity.
 */
function eventPosition(event: NormalizedRelayEvent): string {
  const meta = event.routingMeta ?? {};
  if (typeof meta.logIndex === 'number') return `log:${meta.logIndex}`;
  if (typeof meta.slot === 'number') return `slot:${meta.slot}`;
  if (typeof meta.ledgerSequence === 'number') return `ledger:${meta.ledgerSequence}`;
  if (typeof meta.blockNumber === 'number') return `block:${meta.blockNumber}`;
  return 'pos:none';
}

/**
 * Compute the chain-qualified identity for a normalized relay event.
 *
 * The identity is deliberately independent of `orderId`: two genuinely
 * different events for the same order must produce two different identities,
 * while two deliveries of the *same* on-chain event must produce the same
 * identity regardless of when they arrive.
 */
export function computeRelayEventIdentity(event: NormalizedRelayEvent): RelayEventIdentity {
  const tx = event.txHash ?? 'no-tx';
  return `${event.sourceChain}:${event.eventKind}:${tx}:${eventPosition(event)}`;
}

/**
 * True when `kind` marks an order as terminal (claim / refund / settlement).
 */
export function isTerminalRelayKind(kind: RelayEventKind): boolean {
  return TERMINAL_KINDS.has(kind);
}

/**
 * True when applying `newKind` after `existingKind` would contradict the
 * already-recorded terminal state for an order.
 */
export function isContradictoryTerminal(
  existingKind: RelayEventKind,
  newKind: RelayEventKind,
): boolean {
  if (existingKind === newKind) return false;
  return CONTRADICTORY_PAIRS.has(`${existingKind}|${newKind}`);
}

// ── RelayEventDeduplicator ────────────────────────────────────────────────────

export interface RelayEventDeduplicatorOptions {
  /**
   * Maximum number of applied-event identities retained in memory. The
   * oldest entry is evicted (FIFO) once the cap is reached. Defaults to
   * {@link DEFAULT_MAX_APPLIED}.
   */
  maxApplied?: number;
  /**
   * Directory used for durable backing. When set, every applied event is
   * written to disk so an overlapping replay window after a restart is still
   * a no-op. Pass `null` (the default) for an in-process-only cache.
   */
  storageDir?: string | null;
}

/**
 * Replay-safe deduplication of relay events at the relayer processing
 * boundary.
 *
 * Construct one per relayer process (or per listener) and call
 * {@link process} for every event before producing its side effect. Use
 * {@link createDeduplicatingHandler} to wrap an existing
 * {@link NormalizedRelayEvent} handler so duplicates and conflicts are handled
 * uniformly.
 */
export class RelayEventDeduplicator {
  /** identity → applied record (insertion-ordered for FIFO eviction). */
  private readonly applied = new Map<RelayEventIdentity, AppliedRelayEvent>();
  /** orderId → the terminal kind already applied for that order. */
  private readonly orderTerminal = new Map<string, RelayEventKind>();
  private readonly maxApplied: number;
  private readonly storageDir: string | null;

  constructor(opts: RelayEventDeduplicatorOptions = {}) {
    this.maxApplied = opts.maxApplied ?? DEFAULT_MAX_APPLIED;
    this.storageDir = opts.storageDir === undefined ? null : opts.storageDir;
    if (this.storageDir) {
      if (!existsSync(this.storageDir)) mkdirSync(this.storageDir, { recursive: true });
      this._loadFromDisk();
    }
  }

  /**
   * Classify an event as a duplicate, a conflict, or a novel event to apply.
   *
   * This method is pure with respect to side effects on the chain: it only
   * updates the in-memory (and optional durable) dedup store. The caller is
   * responsible for producing the actual side effect when `shouldApply` is
   * true.
   */
  process(event: NormalizedRelayEvent): DedupResult {
    return this._process(event, /* persist */ true);
  }

  /**
   * Peek at how an event would be classified *without* recording it. Useful
   * for tests and for pre-flight checks. Does not mutate state.
   */
  classify(event: NormalizedRelayEvent): DedupResult {
    return this._process(event, /* persist */ false);
  }

  private _process(event: NormalizedRelayEvent, persist: boolean): DedupResult {
    const identity = computeRelayEventIdentity(event);

    // ── Exact duplicate: same identity already applied ──────────────────────
    const existing = this.applied.get(identity);
    if (existing) {
      return { identity, duplicate: true, shouldApply: false };
    }

    // ── Conflict: a different event for this order contradicts a terminal ──
    const priorTerminal = this.orderTerminal.get(event.orderId);
    if (priorTerminal !== undefined && isTerminalRelayKind(event.eventKind)) {
      if (isContradictoryTerminal(priorTerminal, event.eventKind)) {
        const conflict: RelayEventConflict = {
          orderId: event.orderId,
          existingTerminalKind: priorTerminal,
          newEventKind: event.eventKind,
          existingIdentity: this._findIdentityForOrder(event.orderId, priorTerminal),
          newIdentity: identity,
          reason: `order ${event.orderId} already reached terminal ${priorTerminal}; ` +
            `received conflicting ${event.eventKind}`,
        };
        log.warn(
          {
            orderId: conflict.orderId,
            existingTerminalKind: conflict.existingTerminalKind,
            newEventKind: conflict.newEventKind,
            existingIdentity: conflict.existingIdentity,
            newIdentity: conflict.newIdentity,
          },
          '[event-dedup] contradictory terminal event surfaced for investigation',
        );
        return { identity, duplicate: false, conflict, shouldApply: false };
      }
    }

    // ── Novel event: record it and tell the caller to apply it. ─────────────
    if (persist) {
      const record: AppliedRelayEvent = {
        identity,
        orderId: event.orderId,
        sourceChain: event.sourceChain,
        eventKind: event.eventKind,
        txHash: event.txHash,
        observedAt: event.observedAt,
        terminal: isTerminalRelayKind(event.eventKind),
      };
      this._record(record);
    }
    return { identity, duplicate: false, shouldApply: true };
  }

  /** Number of applied events currently retained. */
  size(): number {
    return this.applied.size;
  }

  /** Number of orders with a recorded terminal state. */
  terminalOrderCount(): number {
    return this.orderTerminal.size;
  }

  /** Return the applied record for an identity, if any (test/diagnostic helper). */
  getApplied(identity: RelayEventIdentity): AppliedRelayEvent | undefined {
    return this.applied.get(identity);
  }

  /** Remove all recorded state (in-memory + durable). */
  clear(): void {
    this.applied.clear();
    this.orderTerminal.clear();
    if (this.storageDir && existsSync(this.storageDir)) {
      for (const file of readdirSync(this.storageDir)) {
        if (file.endsWith('.json')) unlinkSync(join(this.storageDir, file));
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _record(record: AppliedRelayEvent): void {
    if (this.applied.size >= this.maxApplied) {
      const oldest = this.applied.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.applied.get(oldest);
        this.applied.delete(oldest);
        if (evicted) this._deletePersisted(oldest);
      }
    }
    this.applied.set(record.identity, record);
    if (isTerminalRelayKind(record.eventKind)) {
      // Only record the first terminal for an order; a later contradictory
      // terminal is surfaced as a conflict rather than overwriting.
      if (!this.orderTerminal.has(record.orderId)) {
        this.orderTerminal.set(record.orderId, record.eventKind);
      }
    }
    this._persist(record);
  }

  private _findIdentityForOrder(orderId: string, kind: RelayEventKind): RelayEventIdentity {
    for (const rec of this.applied.values()) {
      if (rec.orderId === orderId && rec.eventKind === kind) return rec.identity;
    }
    return '(unknown)';
  }

  private _filePath(identity: RelayEventIdentity): string {
    const safe = identity.replace(/[^a-zA-Z0-9_\-:]/g, '_').substring(0, 140);
    return join(this.storageDir!, `${safe}.json`);
  }

  private _persist(record: AppliedRelayEvent): void {
    if (!this.storageDir) return;
    const fpath = this._filePath(record.identity);
    const tmp = fpath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify({ ...record, savedAt: Date.now() }), 'utf-8');
      renameSync(tmp, fpath);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, '[event-dedup] persist failed');
    }
  }

  private _deletePersisted(identity: RelayEventIdentity): void {
    if (!this.storageDir) return;
    const fpath = this._filePath(identity);
    try {
      if (existsSync(fpath)) unlinkSync(fpath);
    } catch { /* best-effort */ }
  }

  private _loadFromDisk(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;
    let files: string[];
    try {
      files = readdirSync(this.storageDir).filter(
        (f) => f.endsWith('.json') && !f.endsWith('.tmp'),
      );
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.storageDir, file), 'utf-8');
        const persisted = JSON.parse(raw) as AppliedRelayEvent & { savedAt?: number };
        if (
          persisted &&
          typeof persisted.identity === 'string' &&
          typeof persisted.eventKind === 'string' &&
          !this.applied.has(persisted.identity)
        ) {
          this.applied.set(persisted.identity, persisted);
          if (
            isTerminalRelayKind(persisted.eventKind) &&
            !this.orderTerminal.has(persisted.orderId)
          ) {
            this.orderTerminal.set(persisted.orderId, persisted.eventKind);
          }
        }
      } catch {
        // corrupted record — skip
      }
    }
  }
}

// ── Handler wrapper ───────────────────────────────────────────────────────────

/**
 * Signature of a handler that consumes a normalized relay event, identical to
 * the relayer listener's `RelayEventHandler`.
 */
export type RelayEventHandler = (event: NormalizedRelayEvent) => void | Promise<void>;

/**
 * Callback invoked when {@link createDeduplicatingHandler} detects a
 * contradictory terminal event. Defaults to structured logging; supply your
 * own to route conflicts to an alert or queue.
 */
export type ConflictReporter = (conflict: RelayEventConflict, event: NormalizedRelayEvent) => void;

/**
 * Wrap a relay-event handler with replay-safe deduplication.
 *
 * The returned handler:
 *   - skips the inner handler for exact duplicates (no second side effect);
 *   - skips the inner handler for contradictory terminal events and reports
 *     the conflict via `onConflict` (default: structured log);
 *   - forwards novel events to the inner handler exactly once.
 *
 * The wrapper preserves the inner handler's sync/async return shape.
 */
export function createDeduplicatingHandler(
  inner: RelayEventHandler,
  dedup: RelayEventDeduplicator,
  onConflict?: ConflictReporter,
): RelayEventHandler {
  const reportConflict: ConflictReporter =
    onConflict ??
    ((conflict) => {
      // Already logged inside `process`, but keep an explicit surface point
      // so callers can wire an alert without re-implementing classification.
      log.warn({ conflict }, '[event-dedup] conflict reported by deduplicating handler');
    });

  return async (event: NormalizedRelayEvent): Promise<void> => {
    const result = dedup.process(event);
    if (result.conflict) {
      reportConflict(result.conflict, event);
      return;
    }
    if (!result.shouldApply) {
      log.debug({ identity: result.identity, orderId: event.orderId }, '[event-dedup] duplicate event skipped');
      return;
    }
    await inner(event);
  };
}

// ── Schema version guard (re-exported for completeness) ───────────────────────

export { RELAY_EVENT_SCHEMA_VERSION };
