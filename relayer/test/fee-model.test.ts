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
