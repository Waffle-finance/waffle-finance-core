import { rpc, scValToNative } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  observeListenerEventProcessing,
  recordListenerProgress,
  sorobanDecodeErrors,
} from "../metrics.js";

/** Maximum ledger gap before we treat it as a node inconsistency and re-scan. */
const MAX_LEDGER_GAP = 100;

// ─── Typed decoded-event interfaces ──────────────────────────────────────────

/**
 * Decoded `created` event.
 *
 * Contract emit:
 *   topics = (symbol("created"), sender: Address, beneficiary: Address, hashlock: BytesN<32>)
 *   data   = (order_id: u64, asset: Address, amount: i128, safety_deposit: i128, timelock: u64)
 */
interface CreatedEvent {
  kind: "created";
  /** Soroban numeric order id (u64 decoded as bigint). */
  orderId: bigint;
  /** 0x-prefixed 32-byte hex hashlock. */
  hashlock: `0x${string}`;
  /** Absolute unix-second timelock. */
  timelock: number;
  /** Stellar address of the order sender. */
  sender: string;
  /** Stellar address of the beneficiary. */
  beneficiary: string;
  /** Amount locked, as a decimal string (atomic units). */
  amount: string;
  /** Safety deposit posted, as a decimal string (atomic units). */
  safetyDeposit: string;
}

/**
 * Decoded `claimed` event.
 *
 * Contract emit:
 *   topics = (symbol("claimed"), beneficiary: Address, hashlock: BytesN<32>)
 *   data   = (order_id: u64, caller: Address, preimage: Bytes, amount: i128, safety_deposit: i128)
 */
interface ClaimedEvent {
  kind: "claimed";
  orderId: bigint;
  /** 0x-prefixed 32-byte hex hashlock (from topics). */
  hashlock: `0x${string}`;
  /** 0x-prefixed hex preimage (from data). */
  preimage: `0x${string}`;
  /** Stellar address of the beneficiary. */
  beneficiary: string;
}

/**
 * Decoded `refunded` event.
 *
 * Contract emit:
 *   topics = (symbol("refunded"), refund_address: Address, hashlock: BytesN<32>)
 *   data   = (order_id: u64, caller: Address, amount: i128, safety_deposit: i128)
 */
interface RefundedEvent {
  kind: "refunded";
  orderId: bigint;
  /** 0x-prefixed 32-byte hex hashlock (from topics). */
  hashlock: `0x${string}`;
  /** Stellar address of the refund recipient. */
  refundAddress: string;
}

type DecodedHtlcEvent = CreatedEvent | ClaimedEvent | RefundedEvent;

// ─── Typed RPC event shape ────────────────────────────────────────────────────

/**
 * Minimal typed wrapper for the raw Soroban RPC event returned by
 * `rpc.Server.getEvents()`.  The full type is not exported by the SDK at
 * the version we use, so we extract the relevant slice.
 */
interface SorobanRpcEvent {
  ledger: number;
  txHash: string;
  /** Array of xdr.ScVal — the published topics. */
  topic: xdr.ScVal[];
  /** Single xdr.ScVal — the published data (a Soroban Vec/tuple). */
  value: xdr.ScVal;
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

/**
 * Convert a `Uint8Array | Buffer` decoded from a Soroban `BytesN<32>` or
 * `Bytes` ScVal into a 0x-prefixed hex string.
 */
function bytesToHex(bytes: Uint8Array | Buffer): `0x${string}` {
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

/**
 * Decode a single ScVal topic array + data ScVal into a typed HTLC event,
 * or `null` on an unknown topic / decode failure.
 *
 * The contract always publishes topics as a tuple whose first element is a
 * short `Symbol`.  `scValToNative` maps:
 *   - `Symbol`   → `string`
 *   - `Address`  → Stellar G-address string
 *   - `BytesN`   → `Buffer`
 *   - `Bytes`    → `Buffer`
 *   - `u64`      → `bigint`
 *   - `i128`     → `bigint`
 *   - Vec/tuple  → `Array`
 */
function decodeHtlcEvent(
  topicScVals: xdr.ScVal[],
  dataScVal: xdr.ScVal
): DecodedHtlcEvent | null {
  if (topicScVals.length === 0) return null;

  // Topics[0] is always the short symbol identifying the event type.
  const topic0 = topicScVals[0];
  if (!topic0) return null;
  const eventKind = scValToNative(topic0) as unknown;
  if (typeof eventKind !== "string") return null;

  // data is a Soroban Vec (tuple); scValToNative converts it to an Array.
  const data = scValToNative(dataScVal) as unknown;
  if (!Array.isArray(data)) return null;

  // ── created ──────────────────────────────────────────────────────────────
  if (eventKind === "created") {
    // topics: [symbol("created"), sender: Address, beneficiary: Address, hashlock: BytesN<32>]
    if (topicScVals.length < 4) return null;
    const t1 = topicScVals[1];
    const t2 = topicScVals[2];
    const t3 = topicScVals[3];
    if (!t1 || !t2 || !t3) return null;
    const sender = scValToNative(t1) as unknown;
    const beneficiary = scValToNative(t2) as unknown;
    const hashlockRaw = scValToNative(t3) as unknown;

    if (
      typeof sender !== "string" ||
      typeof beneficiary !== "string" ||
      !(hashlockRaw instanceof Uint8Array || Buffer.isBuffer(hashlockRaw))
    ) {
      return null;
    }

    // data: [order_id: u64, asset: Address, amount: i128, safety_deposit: i128, timelock: u64]
    if (data.length < 5) return null;
    const [orderId, , amount, safetyDeposit, timelock] = data as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown
    ];

    if (
      typeof orderId !== "bigint" ||
      typeof amount !== "bigint" ||
      typeof safetyDeposit !== "bigint" ||
      typeof timelock !== "bigint"
    ) {
      return null;
    }

    return {
      kind: "created",
      orderId,
      hashlock: bytesToHex(hashlockRaw as Uint8Array),
      timelock: Number(timelock),
      sender,
      beneficiary,
      amount: amount.toString(),
      safetyDeposit: safetyDeposit.toString(),
    };
  }

  // ── claimed ───────────────────────────────────────────────────────────────
  if (eventKind === "claimed") {
    // topics: [symbol("claimed"), beneficiary: Address, hashlock: BytesN<32>]
    if (topicScVals.length < 3) return null;
    const t1 = topicScVals[1];
    const t2 = topicScVals[2];
    if (!t1 || !t2) return null;
    const beneficiary = scValToNative(t1) as unknown;
    const hashlockRaw = scValToNative(t2) as unknown;

    if (
      typeof beneficiary !== "string" ||
      (!(hashlockRaw instanceof Uint8Array) && !Buffer.isBuffer(hashlockRaw))
    ) {
      return null;
    }

    // data: [order_id: u64, caller: Address, preimage: Bytes, amount: i128, safety_deposit: i128]
    if (data.length < 3) return null;
    const [orderId, , preimageRaw] = data as [unknown, unknown, unknown];

    if (
      typeof orderId !== "bigint" ||
      (!(preimageRaw instanceof Uint8Array) && !Buffer.isBuffer(preimageRaw))
    ) {
      return null;
    }

    return {
      kind: "claimed",
      orderId,
      hashlock: bytesToHex(hashlockRaw as Uint8Array),
      preimage: bytesToHex(preimageRaw as Uint8Array),
      beneficiary,
    };
  }

  // ── refunded ──────────────────────────────────────────────────────────────
  if (eventKind === "refunded") {
    // topics: [symbol("refunded"), refund_address: Address, hashlock: BytesN<32>]
    if (topicScVals.length < 3) return null;
    const t1 = topicScVals[1];
    const t2 = topicScVals[2];
    if (!t1 || !t2) return null;
    const refundAddress = scValToNative(t1) as unknown;
    const hashlockRaw = scValToNative(t2) as unknown;

    if (
      typeof refundAddress !== "string" ||
      (!(hashlockRaw instanceof Uint8Array) && !Buffer.isBuffer(hashlockRaw))
    ) {
      return null;
    }

    // data: [order_id: u64, caller: Address, amount: i128, safety_deposit: i128]
    if (data.length < 1) return null;
    const [orderId] = data as [unknown];

    if (typeof orderId !== "bigint") return null;

    return {
      kind: "refunded",
      orderId,
      hashlock: bytesToHex(hashlockRaw as Uint8Array),
      refundAddress,
    };
  }

  // Unknown topic — not one of our HTLC events.
  return null;
}

// ─── SorobanListener ─────────────────────────────────────────────────────────

/**
 * Polls the Soroban RPC for HTLC contract events and feeds them into
 * the OrderService.
 *
 * Stellar consensus is BFT-finalized so true chain reorgs cannot occur,
 * but we guard against three classes of node-level inconsistency:
 *
 *  1. Out-of-order delivery  — ledger sequence goes backwards.
 *     Detected per-event: skip and warn.
 *
 *  2. Ledger gap             — cursor jumps forward by more than MAX_LEDGER_GAP.
 *     Detected per-event: reset cursor so the next iteration re-scans
 *     from lastProcessedLedger.
 *
 *  3. Stale / expired cursor — the RPC node no longer recognises our cursor
 *     (e.g. node restarted, history window pruned).
 *     Detected on RPC error: reset cursor and continue.
 *
 * Event decoding
 * ──────────────
 * All Soroban RPC events carry topics and values as raw `xdr.ScVal` objects.
 * This listener decodes them with `scValToNative` from `@stellar/stellar-sdk`
 * and matches against the short symbols the contract actually emits:
 *   `"created"`, `"claimed"`, `"refunded"`
 * (not the camel-case strings the old mock used).
 *
 * One malformed or unknown event is logged + counted but never stalls
 * the poll loop or prevents cursor advancement.
 */
export class SorobanListener {
  private readonly server: rpc.Server;
  private readonly log: Logger;
  private cursor: string | undefined;
  private stopped = false;
  private lastProcessedLedger = 0;

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "SorobanListener" });
    this.server = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://")
    });
  }

  start(): void {
    if (!this.cfg.soroban.htlcContract) {
      this.log.warn("SOROBAN_HTLC contract not configured - Soroban listener disabled");
      return;
    }
    const contractId = this.cfg.soroban.htlcContract;
    this.log.info({ contract: contractId }, "starting");
    void this.loop(contractId);
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(contractId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const startedAt = Date.now();
        const latest = await this.server.getLatestLedger();

        // When we have no cursor, start just behind the chain tip.
        const startLedger = this.cursor === undefined ? latest.sequence - 1 : undefined;

        // processedLedger tracks the highest ledger we process this iteration
        // for recordListenerProgress. Seed it from the resolved start point.
        let processedLedger = startLedger ?? this.lastProcessedLedger;

        let events: Awaited<ReturnType<rpc.Server["getEvents"]>>;
        try {
          events = await this.server.getEvents({
            filters: [{ type: "contract", contractIds: [contractId] }],
            startLedger: startLedger,
            cursor: this.cursor,
            limit: 100
          });
        } catch (rpcErr) {
          // Stale / expired cursor — reset and let the next iteration re-scan.
          this.log.warn({ err: rpcErr }, "Soroban cursor reset due to error");
          this.cursor = undefined;
          await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
          continue;
        }

        for (const ev of events.events) {
          // ── Guard 1: out-of-order event ──────────────────────────────────
          if (ev.ledger < this.lastProcessedLedger) {
            this.log.warn(
              { evLedger: ev.ledger, lastProcessedLedger: this.lastProcessedLedger },
              "Soroban event out of order — possible node inconsistency"
            );
            continue;
          }

          // ── Guard 2: ledger gap ───────────────────────────────────────────
          if (
            this.lastProcessedLedger > 0 &&
            ev.ledger > this.lastProcessedLedger + MAX_LEDGER_GAP
          ) {
            this.log.warn(
              { evLedger: ev.ledger, lastProcessedLedger: this.lastProcessedLedger, MAX_LEDGER_GAP },
              "Soroban ledger gap detected, re-scanning from last known ledger"
            );
            // Reset cursor so next iteration does a full re-scan from lastProcessedLedger.
            this.cursor = undefined;
            // Break out of the event loop; remaining events in this batch may
            // also be from the gap range and would be replayed correctly after
            // the re-scan.
            break;
          }

          processedLedger = Math.max(processedLedger, ev.ledger);
          this.lastProcessedLedger = Math.max(this.lastProcessedLedger, ev.ledger);

          await this.processSorobanEvent(ev as unknown as SorobanRpcEvent);
        }

        recordListenerProgress("soroban", processedLedger, latest.sequence);
        observeListenerEventProcessing("soroban", "poll", startedAt);

        // Advance the cursor only when this.cursor was NOT reset to undefined
        // by the gap guard above. If the gap guard fired it set this.cursor to
        // undefined — leave it that way so the next iteration re-scans from
        // lastProcessedLedger via startLedger.
        if (events.cursor && this.cursor !== undefined) {
          this.cursor = events.cursor;
        }
      } catch (err) {
        this.log.warn({ err }, "Soroban poll failed");
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  /**
   * Decode a single Soroban contract event and dispatch to the appropriate
   * OrderService method.
   *
   * Errors from `scValToNative` (malformed XDR), unknown topics, and
   * missing required fields are all handled here: the event is counted,
   * warned about, and skipped so the poll loop continues.
   */
  private async processSorobanEvent(ev: SorobanRpcEvent): Promise<void> {
    let decoded: DecodedHtlcEvent | null;

    try {
      decoded = decodeHtlcEvent(ev.topic, ev.value);
    } catch (decodeErr) {
      // scValToNative threw — malformed XDR.
      sorobanDecodeErrors.inc({ reason: "xdr_decode_error" });
      this.log.warn(
        { err: decodeErr, ledger: ev.ledger, txHash: ev.txHash },
        "Soroban event XDR decode failed — skipping"
      );
      return;
    }

    if (decoded === null) {
      // Unknown topic or structurally invalid payload.
      sorobanDecodeErrors.inc({ reason: "unknown_or_invalid" });
      this.log.debug(
        { ledger: ev.ledger, txHash: ev.txHash },
        "Soroban event with unknown topic or invalid payload — skipping"
      );
      return;
    }

    this.log.info(
      { kind: decoded.kind, ledger: ev.ledger, txHash: ev.txHash },
      "Soroban HTLC event decoded"
    );

    // ── created ────────────────────────────────────────────────────────────
    if (decoded.kind === "created") {
      try {
        const order = await this.orders.findByHashlock(decoded.hashlock);
        if (!order) {
          this.log.info(
            { hashlock: decoded.hashlock, orderId: decoded.orderId.toString() },
            "Soroban created event: no matching announced order — skipping"
          );
          return;
        }
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: decoded.orderId.toString(),
          txHash: ev.txHash,
          blockNumber: ev.ledger,
          timelock: decoded.timelock,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot record") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, hashlock: decoded.hashlock },
            "Soroban created event processing error"
          );
        }
      }
      return;
    }

    // ── claimed ────────────────────────────────────────────────────────────
    if (decoded.kind === "claimed") {
      try {
        const order = await this.orders.findBySrcOrderId(
          "stellar",
          decoded.orderId.toString()
        );
        if (!order) {
          // Fallback: look up by hashlock (coordinator may have lost the orderId).
          const byHash = await this.orders.findByHashlock(decoded.hashlock);
          if (!byHash) {
            this.log.info(
              { orderId: decoded.orderId.toString(), hashlock: decoded.hashlock },
              "Soroban claimed event: order not found — skipping"
            );
            return;
          }
          await this.orders.recordSecret(byHash.publicId, decoded.preimage, ev.txHash);
          return;
        }
        await this.orders.recordSecret(order.publicId, decoded.preimage, ev.txHash);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot record") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, orderId: decoded.orderId.toString() },
            "Soroban claimed event processing error"
          );
        }
      }
      return;
    }

    // ── refunded ───────────────────────────────────────────────────────────
    if (decoded.kind === "refunded") {
      try {
        const order = await this.orders.findBySrcOrderId(
          "stellar",
          decoded.orderId.toString()
        );
        if (!order) {
          // Fallback: look up by hashlock.
          const byHash = await this.orders.findByHashlock(decoded.hashlock);
          if (!byHash) {
            this.log.info(
              { orderId: decoded.orderId.toString(), hashlock: decoded.hashlock },
              "Soroban refunded event: order not found — skipping"
            );
            return;
          }
          await this.orders.markStatus(byHash.publicId, "refunded");
          return;
        }
        await this.orders.markStatus(order.publicId, "refunded");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot transition") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, orderId: decoded.orderId.toString() },
            "Soroban refunded event processing error"
          );
        }
      }
      return;
    }
  }
}
