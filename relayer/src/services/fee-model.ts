/**
 * @fileoverview Fee and profitability model for the WaffleFinance relayer.
 *
 * Problem
 * -------
 * The relayer must remain economically sustainable while honouring the
 * bridge's atomic settlement semantics. Previously, fee and profitability
 * assumptions were scattered across index.ts (hard-coded gas limits, a
 * static safety-deposit table, no payout tracking). There was no single
 * place to ask "is this relay financially worth pursuing?" before committing
 * to chain work.
 *
 * Solution
 * --------
 * This module defines a typed `FeeModel` class that:
 *
 *  1. Holds the operator's gas-price, ETH-price, XLM-price, and fee-rate
 *     assumptions in one `FeeModelConfig`.
 *  2. Exposes a `computeRelayDecision` method that calculates, for a single
 *     relay action, the expected gas cost, safety-deposit cost, payout, and
 *     net profit — all in USD — and returns a typed `RelayDecision`.
 *  3. Classifies decisions as `profitable`, `neutral`, or `unprofitable` so
 *     the relay engine can gate action on financial health.
 *  4. Records Prometheus metrics for every decision so operators can monitor
 *     profitability trends over time without reading logs.
 *  5. Provides a `FallbackFeeModel` that returns safe conservative defaults
 *     when live prices are unavailable — the relayer never crashes because
 *     a price feed is down.
 *
 * Design constraints
 * ------------------
 * - All monetary arithmetic uses bigint (wei/stroop) wherever possible.
 *   USD amounts are floating-point only at the final reporting layer.
 * - No network calls are made from within this module; callers inject
 *   the current price snapshot so the model is deterministic and testable.
 * - The `minProfitThresholdUsd` is configurable so operators can tune the
 *   floor without a code change.
 * - Labels on Prometheus metrics carry only route + verdict — no amounts,
 *   no addresses — so the /metrics endpoint stays safe to expose internally.
 *
 * Usage
 * -----
 * ```ts
 * const model = new FeeModel({
 *   ethPriceUsd: 3_500,
 *   xlmPriceUsd: 0.12,
 *   gasPriceGwei: 20,
 *   minProfitThresholdUsd: 0.05,
 * });
 *
 * const decision = model.computeRelayDecision({
 *   route: 'eth_to_xlm',
 *   orderAmountWei: 100_000_000_000_000n,   // 0.0001 ETH
 *   safetyDepositWei: 10_000_000_000_000n,   // 0.00001 ETH
 *   expectedPayoutXlmStroops: 8_000_000_000n, // 800 XLM
 *   gasLimitUnits: 200_000n,
 * });
 *
 * if (!decision.shouldRelay) {
 *   // skip — log decision.verdict + decision.netProfitUsd
 * }
 * ```
 */

import {
  feeRelayDecisionsTotal,
  feeGasCostUsdHistogram,
  feeNetProfitUsdHistogram,
  feeSafetyDepositUsdHistogram,
  feeSkippedRelaysTotal,
} from '../metrics.js';
import { correlationLog } from '../correlation/correlation-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wei per 1 ETH. */
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

/** Stroops per 1 XLM. */
const STROOPS_PER_XLM = 10_000_000n;

/** Gwei per ETH (1e9). */
const GWEI_PER_ETH = 1_000_000_000n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bridge route direction for the fee model (mirrors RelayRoute). */
export type FeeRoute = 'eth_to_xlm' | 'xlm_to_eth' | 'unknown';

/**
 * The financial verdict for a relay action.
 *
 * - `profitable`    — net profit exceeds minProfitThresholdUsd.
 * - `neutral`       — net profit is non-negative but below the threshold.
 * - `unprofitable`  — net profit is negative (relay costs more than payout).
 */
export type RelayVerdict = 'profitable' | 'neutral' | 'unprofitable';

/**
 * Inputs to a single relay profitability calculation.
 * All on-chain quantities use bigint (wei or stroops) to prevent float drift.
 */
export interface RelayFeeInput {
  /** Bridge route direction — used as a Prometheus label. */
  route: FeeRoute;

  /**
   * The user's order amount in wei (for ETH→XLM) or stroops (for XLM→ETH).
   * Used only for logging context; the profitability calculation is driven
   * by the payout and cost fields.
   */
  orderAmountNative: bigint;

  /**
   * Safety deposit the relayer must lock on-chain (wei for ETH routes).
   * This is a cost even when fully refunded, because it consumes capital
   * during the bridge window.
   */
  safetyDepositWei: bigint;

  /**
   * Expected payout to the relayer expressed in the source asset.
   * For ETH→XLM: fee earned in wei (relayer margin on the ETH side).
   * For XLM→ETH: fee earned in stroops.
   * Pass 0n when the relayer earns no explicit fee (relay is altruistic).
   */
  expectedPayoutNative: bigint;

  /**
   * Gas limit in EVM gas units for the relay transaction.
   * Defaults to 200_000 when omitted.
   */
  gasLimitUnits?: bigint;
}

/**
 * Fully-computed relay profitability decision.
 */
export interface RelayDecision {
  /** Whether the relayer should proceed with this action. */
  shouldRelay: boolean;

  /** Financial verdict used as a Prometheus label. */
  verdict: RelayVerdict;

  /** Estimated gas cost in USD. */
  gasCostUsd: number;

  /** Safety deposit cost in USD (capital at risk during the bridge window). */
  safetyDepositUsd: number;

  /** Expected payout to the relayer in USD. */
  expectedPayoutUsd: number;

  /**
   * Net profit in USD = expectedPayoutUsd - gasCostUsd - safetyDepositUsd.
   * Negative values indicate the relay action costs more than it earns.
   */
  netProfitUsd: number;

  /** Gas price used in the calculation (gwei). */
  gasPriceGwei: number;

  /** Gas limit used in the calculation (EVM units). */
  gasLimitUnits: bigint;

  /** ETH price used in the calculation (USD). */
  ethPriceUsd: number;

  /** XLM price used in the calculation (USD), if relevant. */
  xlmPriceUsd: number;

  /** Route for which this decision was made. */
  route: FeeRoute;

  /** Unix timestamp (ms) when this decision was computed. */
  computedAt: number;
}

/**
 * Configuration for the FeeModel. All fields are mutable so the model can be
 * refreshed with live prices without instantiation overhead.
 */
export interface FeeModelConfig {
  /** Current ETH/USD price. */
  ethPriceUsd: number;

  /** Current XLM/USD price. */
  xlmPriceUsd: number;

  /**
   * Gas price in gwei the relayer expects to pay for on-chain transactions.
   * Defaults to 20 gwei when omitted.
   */
  gasPriceGwei?: number;

  /**
   * Minimum net profit in USD required to classify a relay as `profitable`.
   * Relays between 0 and this threshold are classified as `neutral`.
   * Defaults to 0.05 USD (5 cents).
   */
  minProfitThresholdUsd?: number;

  /**
   * Whether the relayer should proceed with `neutral` relays (net profit
   * non-negative but below threshold). Defaults to `true` so the system
   * errs on the side of completing user operations.
   */
  relayOnNeutral?: boolean;

  /**
   * Whether the relayer should proceed with `unprofitable` relays.
   * Defaults to `false`. Set to `true` only in test/testnet environments.
   */
  relayOnUnprofitable?: boolean;
}

// ---------------------------------------------------------------------------
// FeeModel
// ---------------------------------------------------------------------------

/** Default gas limit for a cross-chain relay transaction (EVM units). */
const DEFAULT_GAS_LIMIT = 200_000n;

/** Default gas price when none is configured (gwei). */
const DEFAULT_GAS_PRICE_GWEI = 20;

/** Default minimum profit threshold (USD). */
const DEFAULT_MIN_PROFIT_USD = 0.05;

export class FeeModel {
  private _config: Required<FeeModelConfig>;

  constructor(config: FeeModelConfig) {
    this._config = {
      gasPriceGwei: DEFAULT_GAS_PRICE_GWEI,
      minProfitThresholdUsd: DEFAULT_MIN_PROFIT_USD,
      relayOnNeutral: true,
      relayOnUnprofitable: false,
      ...config,
    };
  }

  // Config accessors

  /** Update prices and gas assumptions without re-instantiating. */
  update(patch: Partial<FeeModelConfig>): void {
    this._config = { ...this._config, ...patch };
    this._assertConfig();
  }

  get ethPriceUsd(): number { return this._config.ethPriceUsd; }
  get xlmPriceUsd(): number { return this._config.xlmPriceUsd; }
  get gasPriceGwei(): number { return this._config.gasPriceGwei; }

  // ── Core calculation ──────────────────────────────────────────────────────

  /**
   * Compute the relay profitability for a single action and record metrics.
   *
   * Throws `FeeModelConfigError` when the configuration has zero/negative
   * prices that would produce meaningless results.
   */
  computeRelayDecision(input: RelayFeeInput): RelayDecision {
    this._assertConfig();

    if (input.orderAmountNative < 0n) {
      throw new FeeModelConfigError('orderAmountNative cannot be negative');
    }
    if (input.safetyDepositWei < 0n) {
      throw new FeeModelConfigError('safetyDepositWei cannot be negative');
    }
    if (input.expectedPayoutNative < 0n) {
      throw new FeeModelConfigError('expectedPayoutNative cannot be negative');
    }
    if (input.gasLimitUnits !== undefined && input.gasLimitUnits <= 0n) {
      throw new FeeModelConfigError('gasLimitUnits must be positive');
    }

    const gasLimitUnits = input.gasLimitUnits ?? DEFAULT_GAS_LIMIT;
    const gasPriceWei = BigInt(Math.round(this._config.gasPriceGwei * 1e9));

    // Gas cost in wei → USD
    const gasCostWei = gasLimitUnits * gasPriceWei;
    const gasCostEth = Number(gasCostWei) / Number(WEI_PER_ETH);
    const gasCostUsd = gasCostEth * this._config.ethPriceUsd;

    // Safety deposit → USD (always denominated in wei/ETH)
    const safetyDepositEth = Number(input.safetyDepositWei) / Number(WEI_PER_ETH);
    const safetyDepositUsd = safetyDepositEth * this._config.ethPriceUsd;

    // Payout → USD (depends on route)
    const expectedPayoutUsd = this._payoutToUsd(
      input.expectedPayoutNative,
      input.route,
    );

    // Net profit
    const netProfitUsd = expectedPayoutUsd - gasCostUsd - safetyDepositUsd;

    // Verdict
    const verdict = this._classify(netProfitUsd);

    // Should relay?
    let shouldRelay: boolean;
    if (verdict === 'profitable') {
      shouldRelay = true;
    } else if (verdict === 'neutral') {
      shouldRelay = this._config.relayOnNeutral;
    } else {
      shouldRelay = this._config.relayOnUnprofitable;
    }

    const decision: RelayDecision = {
      shouldRelay,
      verdict,
      gasCostUsd,
      safetyDepositUsd,
      expectedPayoutUsd,
      netProfitUsd,
      gasPriceGwei: this._config.gasPriceGwei,
      gasLimitUnits,
      ethPriceUsd: this._config.ethPriceUsd,
      xlmPriceUsd: this._config.xlmPriceUsd,
      route: input.route,
      computedAt: Date.now(),
    };

    this._recordMetrics(decision);

    return decision;
  }

  /**
   * Convenience wrapper — compute a decision and log it via the correlation
   * context if one is active.
   */
  computeAndLog(input: RelayFeeInput): RelayDecision {
    const decision = this.computeRelayDecision(input);

    correlationLog(
      decision.verdict === 'unprofitable' ? 'warn' : 'info',
      `[fee-model] relay decision: ${decision.verdict}`,
      {
        route: decision.route,
        shouldRelay: decision.shouldRelay,
        gasCostUsd: round2(decision.gasCostUsd),
        safetyDepositUsd: round2(decision.safetyDepositUsd),
        expectedPayoutUsd: round2(decision.expectedPayoutUsd),
        netProfitUsd: round2(decision.netProfitUsd),
        gasPriceGwei: decision.gasPriceGwei,
      },
    );

    return decision;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _payoutToUsd(payoutNative: bigint, route: FeeRoute): number {
    if (payoutNative === 0n) return 0;

    if (route === 'eth_to_xlm') {
      // Payout denominated in wei
      const eth = Number(payoutNative) / Number(WEI_PER_ETH);
      return eth * this._config.ethPriceUsd;
    }

    if (route === 'xlm_to_eth') {
      // Payout denominated in stroops
      const xlm = Number(payoutNative) / Number(STROOPS_PER_XLM);
      return xlm * this._config.xlmPriceUsd;
    }

    // Unknown route — treat payout as zero to be conservative
    return 0;
  }

  private _classify(netProfitUsd: number): RelayVerdict {
    if (netProfitUsd < 0) return 'unprofitable';
    if (netProfitUsd < this._config.minProfitThresholdUsd) return 'neutral';
    return 'profitable';
  }

  private _recordMetrics(decision: RelayDecision): void {
    const { verdict, route } = decision;

    feeRelayDecisionsTotal.inc({ verdict, route });
    feeGasCostUsdHistogram.observe({ route }, decision.gasCostUsd);
    feeNetProfitUsdHistogram.observe({ route }, decision.netProfitUsd);
    feeSafetyDepositUsdHistogram.observe({ route }, decision.safetyDepositUsd);

    if (!decision.shouldRelay) {
      feeSkippedRelaysTotal.inc({ route });
    }
  }

  private _assertConfig(): void {
    if (this._config.ethPriceUsd <= 0) {
      throw new FeeModelConfigError('ethPriceUsd must be positive');
    }
    if (this._config.xlmPriceUsd <= 0) {
      throw new FeeModelConfigError('xlmPriceUsd must be positive');
    }
    if (this._config.gasPriceGwei < 0) {
      throw new FeeModelConfigError('gasPriceGwei cannot be negative');
    }
    if (this._config.minProfitThresholdUsd < 0) {
      throw new FeeModelConfigError('minProfitThresholdUsd cannot be negative');
    }
  }
}

// ---------------------------------------------------------------------------
// FallbackFeeModel
// ---------------------------------------------------------------------------

/**
 * Conservative fee model that uses hardcoded fallback prices.
 *
 * Used when the live price feed is unavailable. It deliberately uses
 * pessimistic (low ETH price, low XLM price) assumptions so the relay
 * engine will tend to classify actions as `neutral` rather than
 * `profitable`, preventing over-optimistic execution during an outage.
 */
export class FallbackFeeModel extends FeeModel {
  constructor(overrides?: Partial<FeeModelConfig>) {
    super({
      ethPriceUsd: 2_000,     // conservative: well below typical market
      xlmPriceUsd: 0.08,      // conservative: well below typical market
      gasPriceGwei: 50,       // conservative: above typical fast gas
      minProfitThresholdUsd: 0.05,
      relayOnNeutral: true,
      relayOnUnprofitable: false,
      ...overrides,
    });
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when FeeModel is configured with values that make calculation meaningless. */
export class FeeModelConfigError extends Error {
  constructor(message: string) {
    super(`[fee-model] Configuration error: ${message}`);
    this.name = 'FeeModelConfigError';
  }
}

// ---------------------------------------------------------------------------
// Utilities (exported for tests)
// ---------------------------------------------------------------------------

/** Convert wei to ETH as a float. */
export function weiToEth(wei: bigint): number {
  return Number(wei) / Number(WEI_PER_ETH);
}

/** Convert stroops to XLM as a float. */
export function stroopsToXlm(stroops: bigint): number {
  return Number(stroops) / Number(STROOPS_PER_XLM);
}

/** Convert ETH float to wei bigint (rounds to nearest). */
export function ethToWei(eth: number): bigint {
  return BigInt(Math.round(eth * Number(WEI_PER_ETH)));
}

/** Convert XLM float to stroops bigint (rounds to nearest). */
export function xlmToStroops(xlm: number): bigint {
  return BigInt(Math.round(xlm * Number(STROOPS_PER_XLM)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
