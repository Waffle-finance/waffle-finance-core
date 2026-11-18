import { createHash } from "node:crypto";
import { keccak256, toHex, parseAbiItem, type PublicClient, type Log } from "viem";
import type { Logger } from "pino";
import type { OrderService } from "../services/order-service.js";
import { secretRecoveryOutcomeTotal } from "../metrics.js";

// ── Validation helpers ────────────────────────────────────────────────────────

function bufferFromHex(s: string): Buffer {
  return Buffer.from(s.startsWith("0x") ? s.slice(2) : s, "hex");
}

function sha256Hex(buf: Buffer): string {
  return "0x" + createHash("sha256").update(buf).digest("hex");
}

function keccak256Hex(buf: Buffer): string {
  return keccak256(toHex(buf)) as `0x${string}`;
}

/**
 * Validate that `preimage` hashes to `hashlock` via sha256 OR keccak256.
 * Returns the matched algorithm name, or `null` if neither matches.
 *
 * This is the same dual-hash check used by `SecretService.reveal()` and must
 * be applied to every preimage recovered from on-chain logs before it is
 * written to the database.
 */
export function validatePreimage(
  preimage: string,
  hashlock: string,
): "sha256" | "keccak256" | null {
  try {
    const buf = bufferFromHex(preimage);
    if (sha256Hex(buf) === hashlock) return "sha256";
    if (keccak256Hex(buf) === hashlock) return "keccak256";
  } catch {
    // Malformed hex — treat as invalid rather than throwing.
  }
  return null;
}

// ── ABI ───────────────────────────────────────────────────────────────────────

const ORDER_CLAIMED_EVENT = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SecretRecoveryResult {
  /** Number of missing preimages successfully recovered and written to DB. */
  recovered: number;
  /** Number of preimages that failed sha256/keccak256 validation — never persisted. */
  invalidPreimages: number;
  /** Orders where the preimage was already present in DB (idempotent skip). */
  alreadyKnown: number;
  /**
   * Orders where the preimage passed hash validation but the order was in a state
   * that does not accept secret recording (e.g. already terminal). Never persisted.
   */
  stateConflict: number;
  /** Unexpected errors during individual order processing — order skipped. */
  errors: number;
}

/**
 * Deterministic outcome of a single recovery attempt for one order.
 *
 * Used internally by `_recoverOneOrder` and exposed for callers that want to
 * react to individual outcomes (e.g. operator tooling or integration tests).
 */
export type RecoveryOutcome =
  | "recovered"
  | "already_known"
  | "invalid_preimage"
  | "state_conflict"
  | "error";

export interface StaleRevelation {
  publicId: string;
  srcOrderId: string | null;
  hashlock: string;
  status: string;
}

// ── SecretReconciler ──────────────────────────────────────────────────────────

/**
 * Recovers secret preimages that the coordinator's live listener missed.
 *
 * ## Problem it solves
 *
 * When an `OrderClaimed` event is emitted on-chain, the coordinator's event
 * listener writes the preimage to the database.  If the listener is down
 * (restart, RPC timeout, missed block), the DB ends up with an order stuck
 * in `src_locked` / `dst_locked` even though the secret is already on-chain.
 *
 * ## How it works
 *
 * `recoverFromEthereumLogs` scans `OrderClaimed` logs in a recent block window
 * and for each log:
 *   1. Looks up the matching order in the DB by `srcOrderId`.
 *   2. **Validates** the on-chain preimage against the order's `hashlock`
 *      (sha256 or keccak256).  Any preimage that does not match is logged as a
 *      warning and never persisted.
 *   3. Writes only verified preimages to the database via `OrderService`.
 *
 * `detectStaleRevelations` returns orders in `src_locked` / `dst_locked` state
 * that have no preimage in the DB — these are candidates for recovery.
 *
 * ## Security invariant
 *
 * A preimage is NEVER written to the database without passing
 * `sha256(preimage) === hashlock` OR `keccak256(preimage) === hashlock`.
 * This matches the validation in `SecretService.reveal()`.
 *
 * The main `Reconciler` handles broader event replay (OrderCreated, OrderRefunded)
 * across all chains.  This class focuses exclusively on Ethereum secret recovery.
 */
export class SecretReconciler {
  private readonly log: Logger;

  constructor(
    private readonly ethClient: PublicClient,
    private readonly orders: OrderService,
    log: Logger,
  ) {
    this.log = log.child({ component: "SecretReconciler" });
  }

  /**
   * Recover a preimage for a single order deterministically.
   *
   * This is the shared recovery path for every branch of the engine.  It
   * validates the preimage, classifies the outcome, persists only safe values,
   * and increments the appropriate metric counter so operators can see which
   * branch fires most often.
   */
  async _recoverOneOrder(
    orderId: string,
    preimage: string,
    txHash: string,
  ): Promise<RecoveryOutcome> {
    const order = await this.orders.findBySrcOrderId("ethereum", orderId);
    if (!order) {
      this.log.debug({ orderId }, "SecretReconciler: no DB order for on-chain orderId — skipping");
      return "error";
    }

    if (order.preimage) {
      secretRecoveryOutcomeTotal.inc({ outcome: "already_known" });
      return "already_known";
    }

    const algo = validatePreimage(preimage, order.hashlock);
    if (!algo) {
      secretRecoveryOutcomeTotal.inc({ outcome: "invalid_preimage" });
      this.log.warn(
        { orderId, publicId: order.publicId, hashlock: order.hashlock },
        "SecretReconciler: recovered preimage does not match hashlock — rejected",
      );
      return "invalid_preimage";
    }

    try {
      await this.orders.recordSecret(order.publicId, preimage, txHash, null, "secret_reconciler");
    } catch (err: any) {
      if (err?.message?.includes("cannot record")) {
        secretRecoveryOutcomeTotal.inc({ outcome: "state_conflict" });
        this.log.warn(
          { orderId, publicId: order.publicId, status: order.status, err: err.message },
          "SecretReconciler: order state does not accept secret recording",
        );
        return "state_conflict";
      }
      secretRecoveryOutcomeTotal.inc({ outcome: "error" });
      this.log.warn({ err, orderId }, "SecretReconciler: unexpected error recording secret");
      return "error";
    }

    secretRecoveryOutcomeTotal.inc({ outcome: "recovered" });
    this.log.info(
      { orderId, publicId: order.publicId, algo, txHash },
      "SecretReconciler: missing secret recovered from on-chain log",
    );
    return "recovered";
  }

  /**
   * Scan Ethereum `OrderClaimed` logs in `[fromBlock, toBlock]` and recover
   * any preimages missing from the coordinator's database.
   *
   * @param contractAddress - Deployed HTLCEscrow address.
   * @param fromBlock       - First block to scan (inclusive).
   * @param toBlock         - Last block to scan (inclusive).
   */
  async recoverFromEthereumLogs(
    contractAddress: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<SecretRecoveryResult> {
    const result: SecretRecoveryResult = {
      recovered: 0,
      invalidPreimages: 0,
      alreadyKnown: 0,
      stateConflict: 0,
      errors: 0,
    };

    let logs: Log[];
    try {
      logs = await this.ethClient.getLogs({
        address: contractAddress as `0x${string}`,
        event: ORDER_CLAIMED_EVENT,
        fromBlock,
        toBlock,
      });
    } catch (err) {
      this.log.warn(
        { err, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
        "SecretReconciler: failed to fetch OrderClaimed logs",
      );
      return result;
    }

    this.log.info(
      { count: logs.length, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
      "SecretReconciler: scanning OrderClaimed logs",
    );

    for (const log of logs) {
      const args = (log as any).args as {
        orderId?: bigint;
        preimage?: `0x${string}`;
      };
      if (!args?.orderId || !args?.preimage) continue;

      const orderId = args.orderId.toString();
      const preimage = args.preimage;
      const txHash = log.transactionHash ?? "0x";

      const outcome = await this._recoverOneOrder(orderId, preimage, txHash);
      switch (outcome) {
        case "recovered":      result.recovered++;      break;
        case "already_known":  result.alreadyKnown++;   break;
        case "invalid_preimage": result.invalidPreimages++; break;
        case "state_conflict": result.stateConflict++;  break;
        case "error":          result.errors++;         break;
      }
    }

    return result;
  }

  /**
   * Return orders in `src_locked` or `dst_locked` state that have no preimage
   * stored in the DB.
   *
   * These are candidates for `recoverFromEthereumLogs`: the coordinator likely
   * missed an `OrderClaimed` event for each of them.  The caller can use the
   * returned `srcOrderId` and `hashlock` to cross-reference on-chain state.
   */
  async detectStaleRevelations(): Promise<StaleRevelation[]> {
    return this.orders.findOrdersMissingSecret();
  }
}
