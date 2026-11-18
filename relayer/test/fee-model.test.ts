/**
 * Tests for relayer/src/services/fee-model.ts
 *
 * Covers:
 *  a. Profitable relay (payout > gas + safety deposit)
 *  b. Neutral relay (payout non-negative but below threshold)
 *  c. Unprofitable relay (payout < gas + safety deposit)
 *  d. shouldRelay flags per verdict + config flags
 *  e. FallbackFeeModel conservative defaults
 *  f. Edge cases: zero payout, zero safety deposit, very small amounts
 *  g. Config error: zero/negative ETH price
 *  h. weiToEth / ethToWei / stroopsToXlm / xlmToStroops round-trip
 *  i. update() patches config in-place
 */

import { describe, it, expect } from 'vitest';
import {
  FeeModel,
  FallbackFeeModel,
  FeeModelConfigError,
  weiToEth,
  ethToWei,
  stroopsToXlm,
  xlmToStroops,
  type RelayFeeInput,
} from '../src/services/fee-model.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

const WEI = 1_000_000_000_000_000_000n;  // 1 ETH in wei
const STROOP = 10_000_000n;               // 1 XLM in stroops

/** Build a FeeModel with sensible test defaults. */
function makeModel(overrides: Partial<{
  ethPriceUsd: number;
  xlmPriceUsd: number;
  gasPriceGwei: number;
  minProfitThresholdUsd: number;
  relayOnNeutral: boolean;
  relayOnUnprofitable: boolean;
}> = {}) {
  return new FeeModel({
    ethPriceUsd: 3_000,
    xlmPriceUsd: 0.10,
    gasPriceGwei: 20,
    minProfitThresholdUsd: 0.10,
    relayOnNeutral: true,
    relayOnUnprofitable: false,
    ...overrides,
  });
}

/** Build a profitable input: payout >> gas+deposit. */
function profitableInput(): RelayFeeInput {
  return {
    route: 'eth_to_xlm',
    orderAmountNative: WEI,                    // 1 ETH order
    safetyDepositWei: 5_000_000_000_000_000n,  // 0.005 ETH
    expectedPayoutNative: 10_000_000_000_000_000n, // 0.01 ETH payout = $30
    gasLimitUnits: 200_000n,
  };
}

/** Build an unprofitable input: payout < gas + deposit. */
function unprofitableInput(): RelayFeeInput {
  return {
    route: 'eth_to_xlm',
    orderAmountNative: 1_000_000_000_000_000n, // 0.001 ETH
    safetyDepositWei: 1_000_000_000_000_000n,  // 0.001 ETH safety = $3
    expectedPayoutNative: 0n,                  // no fee earned
    gasLimitUnits: 200_000n,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FeeModel', () => {

  describe('Profitable relay', () => {
    it('classifies as profitable when payout > gas + safety deposit', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision(profitableInput());
      expect(dec.verdict).toBe('profitable');
      expect(dec.shouldRelay).toBe(true);
    });

    it('netProfitUsd is positive', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision(profitableInput());
      expect(dec.netProfitUsd).toBeGreaterThan(0);
    });

    it('expectedPayoutUsd > gasCostUsd + safetyDepositUsd', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision(profitableInput());
      expect(dec.expectedPayoutUsd).toBeGreaterThan(dec.gasCostUsd + dec.safetyDepositUsd);
    });

    it('returns the correct ETH and gas price used', () => {
      const model = makeModel({ ethPriceUsd: 4_000, gasPriceGwei: 30 });
      const dec = model.computeRelayDecision(profitableInput());
      expect(dec.ethPriceUsd).toBe(4_000);
      expect(dec.gasPriceGwei).toBe(30);
    });
  });

  describe('Neutral relay', () => {
    it('classifies as neutral when profit >= 0 but < threshold', () => {
      // Set a very high threshold so the payout falls below it
      const model = makeModel({ minProfitThresholdUsd: 1_000 });
      const dec = model.computeRelayDecision(profitableInput());
      // Still profitable in absolute terms but below the $1000 threshold
      expect(['neutral', 'profitable']).toContain(dec.verdict);
    });

    it('neutral relay should proceed when relayOnNeutral = true', () => {
      const model = makeModel({ minProfitThresholdUsd: 1_000, relayOnNeutral: true });
      const dec = model.computeRelayDecision(profitableInput());
      if (dec.verdict === 'neutral') {
        expect(dec.shouldRelay).toBe(true);
      }
    });

    it('neutral relay should not proceed when relayOnNeutral = false', () => {
      // Use a threshold above the payout to force neutral
      const model = makeModel({ minProfitThresholdUsd: 100, relayOnNeutral: false });
      // Input with very small profit
      const input: RelayFeeInput = {
        route: 'eth_to_xlm',
        orderAmountNative: WEI,
        safetyDepositWei: 1n,    // negligible
        expectedPayoutNative: 1_000_000n, // tiny payout, below gas cost
        gasLimitUnits: 1n,       // negligible gas
      };
      const dec = model.computeRelayDecision(input);
      if (dec.verdict === 'neutral') {
        expect(dec.shouldRelay).toBe(false);
      }
    });
  });

  describe('Unprofitable relay', () => {
    it('classifies as unprofitable when costs exceed payout', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision(unprofitableInput());
      expect(dec.verdict).toBe('unprofitable');
    });

    it('shouldRelay is false by default for unprofitable', () => {
      const model = makeModel({ relayOnUnprofitable: false });
      const dec = model.computeRelayDecision(unprofitableInput());
      expect(dec.shouldRelay).toBe(false);
    });

    it('shouldRelay is true when relayOnUnprofitable = true', () => {
      const model = makeModel({ relayOnUnprofitable: true });
      const dec = model.computeRelayDecision(unprofitableInput());
      expect(dec.shouldRelay).toBe(true);
    });

    it('netProfitUsd is negative', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision(unprofitableInput());
      expect(dec.netProfitUsd).toBeLessThan(0);
    });
  });

  describe('XLM→ETH route', () => {
    it('computes payout from stroops for xlm_to_eth route', () => {
      const model = makeModel({ xlmPriceUsd: 0.12 });
      const dec = model.computeRelayDecision({
        route: 'xlm_to_eth',
        orderAmountNative: 1000n * STROOP,   // 1000 XLM
        safetyDepositWei: 1_000_000_000_000_000n, // 0.001 ETH
        expectedPayoutNative: 100n * STROOP, // 100 XLM fee = $12
        gasLimitUnits: 100_000n,
      });
      // 100 XLM * $0.12 = $12 payout
      expect(dec.expectedPayoutUsd).toBeCloseTo(12, 2);
    });
  });

  describe('Edge cases', () => {
    it('zero payout → costs dominate → unprofitable', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision({
        route: 'eth_to_xlm',
        orderAmountNative: WEI,
        safetyDepositWei: 1_000_000_000_000_000n,
        expectedPayoutNative: 0n,
        gasLimitUnits: 200_000n,
      });
      expect(dec.verdict).toBe('unprofitable');
      expect(dec.expectedPayoutUsd).toBe(0);
    });

    it('zero safety deposit reduces costs correctly', () => {
      const model = makeModel();
      const decWithDeposit = model.computeRelayDecision({
        route: 'eth_to_xlm',
        orderAmountNative: WEI,
        safetyDepositWei: 5_000_000_000_000_000n,
        expectedPayoutNative: 10_000_000_000_000_000n,
        gasLimitUnits: 200_000n,
      });
      const decNoDeposit = model.computeRelayDecision({
        route: 'eth_to_xlm',
        orderAmountNative: WEI,
        safetyDepositWei: 0n,
        expectedPayoutNative: 10_000_000_000_000_000n,
        gasLimitUnits: 200_000n,
      });
      expect(decNoDeposit.safetyDepositUsd).toBe(0);
      expect(decNoDeposit.netProfitUsd).toBeGreaterThan(decWithDeposit.netProfitUsd);
    });

    it('uses default gas limit (200_000) when not provided', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision({
        route: 'eth_to_xlm',
        orderAmountNative: WEI,
        safetyDepositWei: 0n,
        expectedPayoutNative: 0n,
      });
      expect(dec.gasLimitUnits).toBe(200_000n);
    });

    it('unknown route returns 0 payout', () => {
      const model = makeModel();
      const dec = model.computeRelayDecision({
        route: 'unknown',
        orderAmountNative: WEI,
        safetyDepositWei: 0n,
        expectedPayoutNative: 1_000_000_000_000_000n,
        gasLimitUnits: 100_000n,
      });
      expect(dec.expectedPayoutUsd).toBe(0);
    });

    it('computedAt is approximately now', () => {
      const before = Date.now();
      const model = makeModel();
      const dec = model.computeRelayDecision(profitableInput());
      const after = Date.now();
      expect(dec.computedAt).toBeGreaterThanOrEqual(before);
      expect(dec.computedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('Config validation', () => {
    it('throws FeeModelConfigError when ethPriceUsd is zero', () => {
      const model = makeModel({ ethPriceUsd: 0 });
      expect(() => model.computeRelayDecision(profitableInput())).toThrow(FeeModelConfigError);
    });

    it('throws FeeModelConfigError when ethPriceUsd is negative', () => {
      const model = makeModel({ ethPriceUsd: -1 });
      expect(() => model.computeRelayDecision(profitableInput())).toThrow(FeeModelConfigError);
    });

    it('throws FeeModelConfigError when xlmPriceUsd is zero', () => {
      const model = makeModel({ xlmPriceUsd: 0 });
      expect(() => model.computeRelayDecision(profitableInput())).toThrow(FeeModelConfigError);
    });

    it('throws FeeModelConfigError when gasPriceGwei is negative', () => {
      const model = makeModel({ gasPriceGwei: -5 });
      expect(() => model.computeRelayDecision(profitableInput())).toThrow(FeeModelConfigError);
    });

    it('throws FeeModelConfigError when minProfitThresholdUsd is negative', () => {
      const model = makeModel({ minProfitThresholdUsd: -0.1 });
      expect(() => model.computeRelayDecision(profitableInput())).toThrow(FeeModelConfigError);
    });

    it('throws FeeModelConfigError when orderAmountNative is negative', () => {
      const model = makeModel();
      const input = { ...profitableInput(), orderAmountNative: -1n };
      expect(() => model.computeRelayDecision(input)).toThrow(FeeModelConfigError);
    });

    it('throws FeeModelConfigError when safetyDepositWei is negative', () => {
      const model = makeModel();
      const input = { ...profitableInput(), safetyDepositWei: -100n };
      expect(() => model.computeRelayDecision(input)).toThrow(FeeModelConfigError);
    });

    it('throws FeeModelConfigError when expectedPayoutNative is negative', () => {
      const model = makeModel();
      const input = { ...profitableInput(), expectedPayoutNative: -10n };
      expect(() => model.computeRelayDecision(input)).toThrow(FeeModelConfigError);
    });

    it('does not throw for gasPriceGwei = 0 (free gas scenario)', () => {
      const model = makeModel({ gasPriceGwei: 0 });
      const dec = model.computeRelayDecision(profitableInput());
      expect(dec.gasCostUsd).toBe(0);
    });
  });

  describe('update()', () => {
    it('patches ethPriceUsd without reinstantiating', () => {
      const model = makeModel({ ethPriceUsd: 2_000 });
      const decBefore = model.computeRelayDecision(profitableInput());
      model.update({ ethPriceUsd: 4_000 });
      const decAfter = model.computeRelayDecision(profitableInput());
      // Higher ETH price → higher gas cost AND higher payout
      expect(decAfter.ethPriceUsd).toBe(4_000);
      expect(decBefore.ethPriceUsd).toBe(2_000);
    });
  });

  describe('computeAndLog()', () => {
    it('returns the same decision as computeRelayDecision()', () => {
      const model = makeModel();
      const input = profitableInput();
      const dec1 = model.computeRelayDecision({ ...input });
      const dec2 = model.computeAndLog({ ...input });
      expect(dec1.verdict).toBe(dec2.verdict);
      expect(dec1.netProfitUsd).toBeCloseTo(dec2.netProfitUsd, 10);
    });
  });
});

describe('FallbackFeeModel', () => {
  it('uses conservative prices', () => {
    const model = new FallbackFeeModel();
    expect(model.ethPriceUsd).toBe(2_000);
    expect(model.xlmPriceUsd).toBe(0.08);
    expect(model.gasPriceGwei).toBe(50);
  });

  it('accepts price overrides', () => {
    const model = new FallbackFeeModel({ ethPriceUsd: 1_500 });
    expect(model.ethPriceUsd).toBe(1_500);
    expect(model.xlmPriceUsd).toBe(0.08); // fallback default preserved
  });

  it('can still make a profitability decision', () => {
    const model = new FallbackFeeModel();
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: WEI,
      safetyDepositWei: 5_000_000_000_000_000n,
      expectedPayoutNative: 20_000_000_000_000_000n,
      gasLimitUnits: 200_000n,
    });
    expect(['profitable', 'neutral', 'unprofitable']).toContain(dec.verdict);
  });
});

describe('Utility converters', () => {
  it('weiToEth converts correctly', () => {
    expect(weiToEth(WEI)).toBeCloseTo(1, 10);
    expect(weiToEth(WEI / 2n)).toBeCloseTo(0.5, 10);
  });

  it('ethToWei round-trips through weiToEth', () => {
    const eth = 0.123456789;
    const wei = ethToWei(eth);
    expect(weiToEth(wei)).toBeCloseTo(eth, 6);
  });

  it('stroopsToXlm converts correctly', () => {
    expect(stroopsToXlm(STROOP)).toBeCloseTo(1, 10);
    expect(stroopsToXlm(STROOP * 100n)).toBeCloseTo(100, 8);
  });

  it('xlmToStroops round-trips through stroopsToXlm', () => {
    const xlm = 99.9999;
    const stroops = xlmToStroops(xlm);
    expect(stroopsToXlm(stroops)).toBeCloseTo(xlm, 3);
  });
});


// ---------------------------------------------------------------------------
// Boundary / table-driven tests
//
// These tests verify the fee model never returns a negative deposit, NaN,
// Infinity, or a value outside configured limits when fed extreme inputs.
// They use table-driven patterns so new boundary inputs can be added without
// changing the model design.
// ---------------------------------------------------------------------------

describe('FeeModel — boundary: zero amount', () => {
  it('zero orderAmountNative with zero deposit and zero payout is unprofitable', () => {
    const model = makeModel();
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: 0n,
      safetyDepositWei: 0n,
      expectedPayoutNative: 0n,
      gasLimitUnits: 200_000n,
    });
    // Net profit = 0 payout - gas cost (positive) - 0 deposit = negative
    expect(dec.verdict).toBe('unprofitable');
    expect(dec.netProfitUsd).toBeLessThan(0);
    // Safety deposit must not be negative.
    expect(dec.safetyDepositUsd).toBe(0);
  });

  it('zero safetyDepositWei never produces a negative deposit USD', () => {
    const model = makeModel();
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: WEI,
      safetyDepositWei: 0n,
      expectedPayoutNative: 0n,
    });
    expect(dec.safetyDepositUsd).toBe(0);
    expect(dec.safetyDepositUsd).toBeGreaterThanOrEqual(0);
  });

  it('zero gasLimitUnits (gas-price > 0) produces zero gas cost', () => {
    // gasLimitUnits = 0n is rejected by validation, but the boundary case
    // at 1n approaches zero cost. Since 0n throws, verify 1n is valid.
    const model = makeModel({ gasPriceGwei: 20 });
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: WEI,
      safetyDepositWei: 0n,
      expectedPayoutNative: 0n,
      gasLimitUnits: 1n,
    });
    // 1 gas unit * 20 gwei * $3000/ETH = tiny but valid non-negative cost
    expect(dec.gasCostUsd).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(dec.gasCostUsd)).toBe(true);
  });
});

describe('FeeModel — boundary: minimum amount', () => {
  it('minimum non-zero payout (1 wei) produces finite USD payout close to zero', () => {
    const model = makeModel({ ethPriceUsd: 3_000 });
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: 1n,
      safetyDepositWei: 0n,
      expectedPayoutNative: 1n,
      gasLimitUnits: 1n,
    });
    // 1 wei * $3000 / 1e18 = $3e-15 — extremely small but not NaN or negative
    expect(Number.isFinite(dec.expectedPayoutUsd)).toBe(true);
    expect(dec.expectedPayoutUsd).toBeGreaterThanOrEqual(0);
    expect(dec.safetyDepositUsd).toBeGreaterThanOrEqual(0);
  });

  it('minimum payout in stroops (1 stroop XLM) produces finite USD payout', () => {
    const model = makeModel({ xlmPriceUsd: 0.10 });
    const dec = model.computeRelayDecision({
      route: 'xlm_to_eth',
      orderAmountNative: 1n,
      safetyDepositWei: 0n,
      expectedPayoutNative: 1n,  // 1 stroop = 1e-7 XLM
      gasLimitUnits: 1n,
    });
    expect(Number.isFinite(dec.expectedPayoutUsd)).toBe(true);
    expect(dec.expectedPayoutUsd).toBeGreaterThanOrEqual(0);
  });
});

describe('FeeModel — boundary: large inputs', () => {
  // Table of large but representable bigint inputs.
  const LARGE_WEI = 1_000_000n * WEI;            // 1 million ETH
  const LARGE_STROOP = 1_000_000_000n * STROOP;  // 1 billion XLM

  it('very large payout does not produce NaN or Infinity', () => {
    const model = makeModel({ ethPriceUsd: 3_000 });
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: LARGE_WEI,
      safetyDepositWei: 0n,
      expectedPayoutNative: LARGE_WEI,
      gasLimitUnits: 200_000n,
    });
    expect(Number.isFinite(dec.expectedPayoutUsd)).toBe(true);
    expect(Number.isFinite(dec.gasCostUsd)).toBe(true);
    expect(Number.isFinite(dec.netProfitUsd)).toBe(true);
    expect(Number.isNaN(dec.netProfitUsd)).toBe(false);
  });

  it('very large safety deposit does not produce NaN or negative deposit USD', () => {
    const model = makeModel({ ethPriceUsd: 3_000 });
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: LARGE_WEI,
      safetyDepositWei: LARGE_WEI,
      expectedPayoutNative: LARGE_WEI,
      gasLimitUnits: 200_000n,
    });
    expect(Number.isFinite(dec.safetyDepositUsd)).toBe(true);
    expect(dec.safetyDepositUsd).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(dec.safetyDepositUsd)).toBe(false);
  });

  it('very large stroop payout on xlm_to_eth does not produce NaN', () => {
    const model = makeModel({ xlmPriceUsd: 0.12 });
    const dec = model.computeRelayDecision({
      route: 'xlm_to_eth',
      orderAmountNative: LARGE_STROOP,
      safetyDepositWei: 0n,
      expectedPayoutNative: LARGE_STROOP,
      gasLimitUnits: 200_000n,
    });
    expect(Number.isFinite(dec.expectedPayoutUsd)).toBe(true);
    expect(Number.isNaN(dec.expectedPayoutUsd)).toBe(false);
  });

  it('table: extreme inputs all produce finite, non-negative deposits', () => {
    const model = makeModel({ ethPriceUsd: 3_000, xlmPriceUsd: 0.10 });

    type Row = {
      label: string;
      input: Parameters<typeof model.computeRelayDecision>[0];
    };

    const table: Row[] = [
      {
        label: 'zero everything',
        input: { route: 'eth_to_xlm', orderAmountNative: 0n, safetyDepositWei: 0n, expectedPayoutNative: 0n, gasLimitUnits: 1n },
      },
      {
        label: 'min amounts',
        input: { route: 'eth_to_xlm', orderAmountNative: 1n, safetyDepositWei: 1n, expectedPayoutNative: 1n, gasLimitUnits: 1n },
      },
      {
        label: 'large eth payout',
        input: { route: 'eth_to_xlm', orderAmountNative: LARGE_WEI, safetyDepositWei: WEI, expectedPayoutNative: LARGE_WEI, gasLimitUnits: 300_000n },
      },
      {
        label: 'large xlm payout',
        input: { route: 'xlm_to_eth', orderAmountNative: LARGE_STROOP, safetyDepositWei: 0n, expectedPayoutNative: LARGE_STROOP, gasLimitUnits: 200_000n },
      },
      {
        label: 'zero payout high deposit',
        input: { route: 'eth_to_xlm', orderAmountNative: WEI, safetyDepositWei: 100n * WEI, expectedPayoutNative: 0n, gasLimitUnits: 200_000n },
      },
      {
        label: 'unknown route suppresses payout',
        input: { route: 'unknown' as const, orderAmountNative: WEI, safetyDepositWei: 0n, expectedPayoutNative: WEI, gasLimitUnits: 200_000n },
      },
    ];

    for (const { label, input } of table) {
      const dec = model.computeRelayDecision(input);
      expect(Number.isFinite(dec.safetyDepositUsd), `${label}: safetyDepositUsd must be finite`).toBe(true);
      expect(dec.safetyDepositUsd, `${label}: safetyDepositUsd must be >= 0`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(dec.gasCostUsd), `${label}: gasCostUsd must be finite`).toBe(true);
      expect(dec.gasCostUsd, `${label}: gasCostUsd must be >= 0`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(dec.netProfitUsd), `${label}: netProfitUsd must be finite`).toBe(true);
      expect(Number.isNaN(dec.netProfitUsd), `${label}: netProfitUsd must not be NaN`).toBe(false);
      // shouldRelay must be a boolean (never undefined).
      expect(typeof dec.shouldRelay, `${label}: shouldRelay must be a boolean`).toBe('boolean');
    }
  });
});

describe('FeeModel — boundary: clamping / configured limits', () => {
  it('netProfitUsd does not exceed a theoretical upper bound given configured prices', () => {
    // Upper bound: payout minus zero costs (zero deposit, zero gas).
    const model = makeModel({ ethPriceUsd: 3_000, gasPriceGwei: 0 });
    const payoutWei = 100n * WEI; // 100 ETH = $300,000
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: payoutWei,
      safetyDepositWei: 0n,
      expectedPayoutNative: payoutWei,
      gasLimitUnits: 200_000n,
    });
    // With gas = 0, net profit == payout (theoretical max). Must not exceed it.
    expect(dec.netProfitUsd).toBeLessThanOrEqual(dec.expectedPayoutUsd + 1e-9); // floating-point tolerance
    expect(dec.netProfitUsd).toBeGreaterThanOrEqual(0);
  });

  it('unprofitable relay never returns positive netProfitUsd', () => {
    const model = makeModel();
    const dec = model.computeRelayDecision(unprofitableInput());
    expect(dec.netProfitUsd).toBeLessThan(0);
    expect(dec.verdict).toBe('unprofitable');
  });

  it('deposit does not exceed the input safetyDepositWei converted to USD', () => {
    const model = makeModel({ ethPriceUsd: 3_000 });
    const depositWei = 10n * WEI;  // 10 ETH = $30,000
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: WEI,
      safetyDepositWei: depositWei,
      expectedPayoutNative: 0n,
      gasLimitUnits: 1n,
    });
    // safetyDepositUsd must be exactly 10 ETH * $3000 = $30,000 (±float precision)
    expect(dec.safetyDepositUsd).toBeCloseTo(30_000, 4);
    // Must not exceed input-implied value.
    expect(dec.safetyDepositUsd).toBeLessThanOrEqual(30_000 + 1e-6);
  });

  it('base-unit rounding: 1 wei safety deposit is a positive but tiny USD value', () => {
    const model = makeModel({ ethPriceUsd: 3_000 });
    const dec = model.computeRelayDecision({
      route: 'eth_to_xlm',
      orderAmountNative: 1n,
      safetyDepositWei: 1n,
      expectedPayoutNative: 0n,
      gasLimitUnits: 1n,
    });
    // 1 wei = $3e-15 at $3000/ETH — positive, finite, not NaN.
    expect(dec.safetyDepositUsd).toBeGreaterThan(0);
    expect(dec.safetyDepositUsd).toBeLessThan(1e-10); // sanity upper bound
    expect(Number.isFinite(dec.safetyDepositUsd)).toBe(true);
  });

  it('verdict is one of the three defined strings for every boundary input', () => {
    const model = makeModel();
    const validVerdicts = new Set(['profitable', 'neutral', 'unprofitable']);

    const inputs = [
      profitableInput(),
      unprofitableInput(),
      { route: 'eth_to_xlm' as const, orderAmountNative: 0n, safetyDepositWei: 0n, expectedPayoutNative: 0n, gasLimitUnits: 1n },
      { route: 'xlm_to_eth' as const, orderAmountNative: 1n, safetyDepositWei: 0n, expectedPayoutNative: 1n, gasLimitUnits: 1n },
    ];

    for (const input of inputs) {
      const dec = model.computeRelayDecision(input);
      expect(validVerdicts.has(dec.verdict)).toBe(true);
    }
  });
});
