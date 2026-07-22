/**
 * Background watchdog that rescues XLM→ETH orders the relayer failed to
 * complete (typically because the user closed the page after sending XLM,
 * or the ETH RPC hiccupped past the in-request retry budget).
 *
 * Every `intervalMs` we walk `activeOrders`, find any `xlm_to_eth` order
 * that has been awaiting ETH for longer than `staleAfterMs`, and trigger a
 * refund using the same code path as the inline handler. Refunded orders are
 * stamped `refunded` (and `refundTxHash`) so subsequent ticks don't double-pay.
 *
 * Idempotency
 * -----------
 * Before submitting to Horizon the watchdog claims the order in the
 * `RefundLedger`. A successful submit commits the entry; a Horizon timeout
 * marks it ambiguous so subsequent ticks check on-chain state before trying
 * again. If another code path already committed a refund, the watchdog detects
 * the `committed` state, syncs the order, and skips it.
 *
 * Amount unknown (deferral)
 * -------------------------
 * When `RefundAmountUnknownError` is thrown (no stellarTxHash and no valid
 * fallback), the watchdog releases the lock and marks the order for retry on
 * the next tick without counting it as a hard failure. This handles the window
 * between a user sending XLM and Horizon indexing that transaction.
 *
 * ## Metrics
 *
 *   relayer_refund_watchdog_runs_total
 *   relayer_refund_watchdog_success_total
 *   relayer_refund_watchdog_failure_total          { reason, network_mode }
 *   relayer_refund_watchdog_stale_orders_detected_total
 *   relayer_refund_watchdog_backoff_skips_total
 *   relayer_refund_watchdog_last_run_timestamp_seconds
 *   relayer_refund_watchdog_max_stale_age_seconds
 *   relayer_refund_watchdog_pending_refunds
 *   relayer_refund_watchdog_tick_duration_seconds
 *   relayer_xlm_refund_duplicates_suppressed_total
 *   relayer_xlm_refund_horizon_timeouts_total
 */

import {
  refundXlmToUser,
  HorizonTimeoutError,
  RefundAmountUnknownError,
  type RefundNetworkMode,
} from './xlm-refund.js';
import { globalRefundLedger, type RefundLedger } from './refund-ledger.js';
import {
  watchdogRunsTotal,
  watchdogRefundSuccessTotal,
  watchdogRefundFailureTotal,
  watchdogStaleOrdersDetected,
  watchdogBackoffSkipsTotal,
  watchdogLastRunTimestamp,
  watchdogMaxStaleAgeSeconds,
  watchdogPendingRefundsGauge,
  watchdogTickDurationSeconds,
} from '../metrics.js';
import { sanitizeForLog } from '../utils/sanitize-for-log.js';

const DEFAULT_INTERVAL_MS = 60_000;       // 1 minute
const DEFAULT_STALE_AFTER_MS = 5 * 60_000; // 5 minutes
const BACKOFF_MS = 10 * 60_000;           // 10 minutes after a failure

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WatchdogOrder {
  orderId?: string;
  direction?: string;
  status?: string;
  stellarAddress?: string;
  stellarTxHash?: string;
  xlmReceivedAt?: number | string;
  created?: number | string;
  amount?: number | string;
  networkMode?: RefundNetworkMode | string;
  refundTxHash?: string;
  refundedAt?: number;
  watchdogFailedAt?: number;
  watchdogFailureReason?: string;
  [k: string]: unknown;
}

export interface WatchdogConfig {
  /** How often to scan, in ms. Defaults to 60s. */
  intervalMs?: number;
  /**
   * How long an order can sit without ETH being sent before the watchdog
   * refunds it. Defaults to 5 minutes.
   */
  staleAfterMs?: number;
  /** Horizon URL for the active Stellar network (mainnet or testnet). */
  horizonUrl: string;
  /** Stellar secret the relayer will sign refunds with. */
  refundSecret: string;
  /** Network mode used to choose the right passphrase. */
  networkMode: RefundNetworkMode;
  /**
   * Reference to the in-memory order map maintained by the relayer.
   * The watchdog mutates entries in-place to mark them refunded.
   */
  activeOrders: Map<string, WatchdogOrder>;
  /**
   * Idempotency ledger shared across all refund code paths.
   * Defaults to the process-wide singleton when omitted (normal operation).
   * Pass a fresh `RefundLedger` instance in tests for isolation.
   */
  refundLedger?: RefundLedger;
}

// ---------------------------------------------------------------------------
// Exported helpers (used by tests and the inline route handler)
// ---------------------------------------------------------------------------

/**
 * Normalise a timestamp value to milliseconds.
 * Accepts: ms-range number, seconds-range number, ISO string.
 * Returns null for missing or unparseable values.
 */
export function toMillis(
  value: WatchdogOrder['xlmReceivedAt'] | WatchdogOrder['created']
): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when an order is an XLM→ETH swap that has received XLM but has not
 * yet been refunded or advanced to the ETH-sent / completed state.
 */
export function isXlmToEthAwaitingEth(order: WatchdogOrder): boolean {
  if (order.direction !== 'xlm_to_eth') return false;
  if (!order.stellarTxHash) return false; // XLM never received → nothing to refund
  if (order.refundTxHash || order.refundedAt) return false; // already refunded
  if (order.status === 'eth_tx_sent' || order.status === 'completed') return false;
  if (order.status === 'refunded') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export function startRefundWatchdog(config: WatchdogConfig): { stop: () => void } {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const ledger = config.refundLedger ?? globalRefundLedger;

  process.stdout.write(
    JSON.stringify({
      level: 'info',
      msg: '[refund-watchdog] starting',
      intervalSecs: Math.round(intervalMs / 1000),
      staleAfterSecs: Math.round(staleAfterMs / 1000),
      network: config.networkMode,
    }) + '\n'
  );

  const tick = async (): Promise<void> => {
    const tickEnd = watchdogTickDurationSeconds.startTimer();
    const now = Date.now();

    let maxStaleAgeMs = 0;
    let pendingCount = 0;

    try {
      for (const [orderId, order] of config.activeOrders.entries()) {
        try {
          if (!isXlmToEthAwaitingEth(order)) continue;

          // ── Idempotency: another path already committed a refund ──────────
          const ledgerEntry = ledger.getEntry(orderId);
          if (ledgerEntry?.state.phase === 'committed') {
            if (!order.refundTxHash) {
              order.status = 'refunded';
              order.refundTxHash = ledgerEntry.state.txHash;
              order.refundedAt = ledgerEntry.state.committedAt;
              process.stdout.write(
                JSON.stringify({
                  level: 'info',
                  msg: '[refund-watchdog] duplicate suppressed — syncing from ledger',
                  orderId,
                  txHash: ledgerEntry.state.txHash,
                }) + '\n'
              );
            }
            continue;
          }

          // ── Ambiguous entry: re-check if the tx actually landed ───────────
          if (ledgerEntry?.state.phase === 'ambiguous') {
            const resolved = await checkAmbiguousRefund(orderId, ledger, order, config);
            if (resolved) continue;
            // Not yet resolved — fall through to back-off check.
          }

          pendingCount++;

          // ── Back-off: skip for 10 min after a prior hard failure ──────────
          if (order.watchdogFailedAt && now - order.watchdogFailedAt < BACKOFF_MS) {
            watchdogBackoffSkipsTotal.inc();
            continue;
          }

          const startedAt = toMillis(order.xlmReceivedAt) ?? toMillis(order.created);
          if (!startedAt) continue;

          const age = now - startedAt;
          if (age < staleAfterMs) continue;

          maxStaleAgeMs = Math.max(maxStaleAgeMs, age);
          watchdogStaleOrdersDetected.inc();

          const stellarAddress = order.stellarAddress;
          if (!stellarAddress) {
            process.stderr.write(
              JSON.stringify({
                level: 'warn',
                msg: '[refund-watchdog] missing stellarAddress — skipping',
                orderId,
              }) + '\n'
            );
            watchdogRefundFailureTotal.inc({
              reason: 'missing_address',
              network_mode: config.networkMode,
            });
            continue;
          }

          // ── Claim the idempotency lock ────────────────────────────────────
          const claimed = ledger.claim(orderId);
          if (!claimed) {
            // Another concurrent tick claimed it first (rare in single-threaded
            // Node, but be defensive).
            watchdogBackoffSkipsTotal.inc();
            continue;
          }

          process.stdout.write(
            JSON.stringify({
              level: 'info',
              msg: '[refund-watchdog] attempting refund',
              orderId,
              ageSecs: Math.round(age / 1000),
              stellarTxHash: order.stellarTxHash,
            }) + '\n'
          );

          try {
            const refund = await refundXlmToUser({
              orderId,
              stellarAddress,
              stellarTxHash: order.stellarTxHash,
              networkMode: config.networkMode,
              horizonUrl: config.horizonUrl,
              refundSecret: config.refundSecret,
              fallbackStroops: order.amount != null ? String(order.amount) : undefined,
              ledger,
              maxRetries: 3,
            });

            // refundXlmToUser called ledger.commit on success.
            order.status = 'refunded';
            order.refundTxHash = refund.hash;
            order.refundedAt = Date.now();

            watchdogRefundSuccessTotal.inc({ network_mode: config.networkMode });

            process.stdout.write(
              JSON.stringify({
                level: 'info',
                msg: '[refund-watchdog] refund succeeded',
                orderId,
                amount: refund.amount,
                stroops: refund.stroops.toString(),
                destination: stellarAddress,
                txHash: refund.hash,
              }) + '\n'
            );
          } catch (refundErr: unknown) {
            if (refundErr instanceof RefundAmountUnknownError) {
              // Amount not yet available — release and defer; not a hard failure.
              ledger.release(orderId);
              process.stdout.write(
                JSON.stringify({
                  level: 'info',
                  msg: '[refund-watchdog] amount unknown — deferring to next tick',
                  orderId,
                }) + '\n'
              );
              // Do NOT stamp watchdogFailedAt — we want to retry next tick.
            } else if (refundErr instanceof HorizonTimeoutError) {
              // Tx may have landed — mark ambiguous rather than releasing.
              ledger.markAmbiguous(orderId, refundErr.message);
              order.watchdogFailedAt = Date.now();
              order.watchdogFailureReason = `horizon_timeout: ${refundErr.message}`;

              watchdogRefundFailureTotal.inc({
                reason: 'horizon_timeout',
                network_mode: config.networkMode,
              });

              process.stderr.write(
                JSON.stringify({
                  level: 'warn',
                  msg: '[refund-watchdog] Horizon timeout — marked ambiguous',
                  orderId,
                }) + '\n'
              );
            } else {
              // Definitive failure — release lock so a future tick can retry.
              ledger.release(orderId);
              order.watchdogFailedAt = Date.now();
              const safeErr = sanitizeForLog(refundErr);
              order.watchdogFailureReason =
                safeErr instanceof Error ? safeErr.message : String(safeErr);

              watchdogRefundFailureTotal.inc({
                reason: 'refund_error',
                network_mode: config.networkMode,
              });

              process.stderr.write(
                JSON.stringify({
                  level: 'error',
                  msg: '[refund-watchdog] refund failed',
                  orderId,
                  error: order.watchdogFailureReason,
                }) + '\n'
              );
            }
          }
        } catch (err: unknown) {
          // Unexpected error escaping the inner block.
          const safeErr = sanitizeForLog(err);
          order.watchdogFailedAt = Date.now();
          order.watchdogFailureReason =
            safeErr instanceof Error ? safeErr.message : String(safeErr);

          watchdogRefundFailureTotal.inc({
            reason: 'refund_error',
            network_mode: config.networkMode,
          });

          process.stderr.write(
            JSON.stringify({
              level: 'error',
              msg: '[refund-watchdog] unexpected error',
              orderId,
              error: order.watchdogFailureReason,
            }) + '\n'
          );
        }
      }
    } finally {
      tickEnd();
      watchdogRunsTotal.inc();
      watchdogLastRunTimestamp.set(Math.floor(Date.now() / 1000));
      watchdogMaxStaleAgeSeconds.set(maxStaleAgeMs / 1000);
      watchdogPendingRefundsGauge.set(pendingCount);
    }
  };

  // Warm-up delay so the watchdog doesn't race with relayer startup.
  const warmup = setTimeout(() => { void tick(); }, 15_000);
  const handle = setInterval(() => { void tick(); }, intervalMs);

  return {
    stop() {
      clearTimeout(warmup);
      clearInterval(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// Ambiguous-refund resolution
// ---------------------------------------------------------------------------

/**
 * Re-check whether an ambiguous refund actually landed on Stellar by scanning
 * recent transactions from the relayer account for the refund memo.
 *
 * Confirmed  → resolves the ledger entry, syncs order state; returns true.
 * Not found  → releases the ambiguous entry so the next eligible tick can
 *              retry; returns false.
 * Horizon down → leaves entry ambiguous, tries again next tick; returns false.
 */
async function checkAmbiguousRefund(
  orderId: string,
  ledger: RefundLedger,
  order: WatchdogOrder,
  config: WatchdogConfig
): Promise<boolean> {
  try {
    const { Horizon, Keypair } = await import('@stellar/stellar-sdk');
    const server = new Horizon.Server(config.horizonUrl);
    const keypair = Keypair.fromSecret(config.refundSecret);
    const relayerPublicKey = keypair.publicKey();

    const memoTarget = `Refund:${(orderId || 'unknown').substring(0, 20)}`;

    const txs = await server
      .transactions()
      .forAccount(relayerPublicKey)
      .order('desc')
      .limit(50)
      .call();

    const landed = txs.records.find((tx: any) => tx.memo === memoTarget);

    if (landed) {
      const ops = await server.operations().forTransaction(landed.hash).call();
      const paymentOp: any = ops.records.find(
        (op: any) => op.type === 'payment' && op.asset_type === 'native'
      );
      const amount = paymentOp?.amount ?? '0.0000000';

      ledger.resolveAmbiguous(orderId, {
        txHash: landed.hash,
        amount,
        ledger: typeof landed.ledger === 'number' ? landed.ledger : undefined,
      });

      order.status = 'refunded';
      order.refundTxHash = landed.hash;
      order.refundedAt = Date.now();

      process.stdout.write(
        JSON.stringify({
          level: 'info',
          msg: '[refund-watchdog] ambiguous refund confirmed on-chain',
          orderId,
          txHash: landed.hash,
          amount,
        }) + '\n'
      );
      return true;
    }

    // Not found in last 50 txs — safe to release and allow a new submission.
    ledger.releaseAmbiguous(orderId);
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        msg: '[refund-watchdog] ambiguous refund not found on-chain — releasing for retry',
        orderId,
      }) + '\n'
    );
    return false;
  } catch (checkErr: unknown) {
    // Horizon unavailable — leave ambiguous, try again next tick.
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        msg: '[refund-watchdog] could not check ambiguous refund — leaving for next tick',
        orderId,
        error: checkErr instanceof Error ? checkErr.message : String(checkErr),
      }) + '\n'
    );
    return false;
  }
}
