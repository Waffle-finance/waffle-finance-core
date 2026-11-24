/**
 * Canonical timelock-boundary model used by the cross-chain asymmetry tests.
 *
 * The protocol invariant (docs/ARCHITECTURE.md, invariant 1) is that the
 * resolver's destination refund window closes BEFORE the user's source refund
 * window opens. Clock skew between chains and destination finality delay both
 * eat into that gap, so announcement/quote construction must reject any
 * configuration that does not leave a minimum safety margin.
 */

/** Bounds enforced by both HTLCEscrow.sol and the Soroban htlc contract. */
export const MIN_TIMELOCK_SECONDS = 300;
export const MAX_TIMELOCK_SECONDS = 24 * 60 * 60;

/** Canonical asymmetric route: 24h source, 12h destination. */
export const CANONICAL_SOURCE_TIMELOCK_SECONDS = 24 * 60 * 60;
export const CANONICAL_DESTINATION_TIMELOCK_SECONDS = 12 * 60 * 60;

/** Supported environmental bounds for the generated scenarios. */
export const MAX_CLOCK_SKEW_SECONDS = 60;
export const MAX_FINALITY_DELAY_SECONDS = 300;
/** Contract-minimum safety margin between the two refund boundaries. */
export const MIN_REFUND_GAP_SECONDS = MIN_TIMELOCK_SECONDS;

export interface TimelockConfiguration {
  sourceTimelockSeconds: number;
  destinationTimelockSeconds: number;
  /** Destination clock minus source clock, in seconds (signed). */
  clockSkewSeconds: number;
  /** Delay before a destination event is considered final. */
  finalityDelaySeconds: number;
}

/** Absolute refund boundaries, measured on a single shared timeline. */
export interface RefundSchedule {
  /** Earliest moment the user can refund the source leg. */
  sourceRefundAt: number;
  /** Earliest moment the resolver can safely refund the destination leg. */
  destinationRefundAt: number;
  /** destinationRefundAt -> sourceRefundAt distance. */
  gapSeconds: number;
}

export function refundSchedule(config: TimelockConfiguration): RefundSchedule {
  const sourceRefundAt = config.sourceTimelockSeconds;
  const destinationRefundAt =
    config.clockSkewSeconds +
    config.destinationTimelockSeconds +
    config.finalityDelaySeconds;
  return {
    sourceRefundAt,
    destinationRefundAt,
    gapSeconds: sourceRefundAt - destinationRefundAt,
  };
}

/** True when a configuration satisfies every supported bound and the invariant. */
export function isSafeTimelockConfiguration(config: TimelockConfiguration): boolean {
  const { sourceTimelockSeconds: src, destinationTimelockSeconds: dst } = config;
  if (!Number.isFinite(src) || !Number.isFinite(dst)) return false;
  if (src < MIN_TIMELOCK_SECONDS || src > MAX_TIMELOCK_SECONDS) return false;
  if (dst < MIN_TIMELOCK_SECONDS || dst > MAX_TIMELOCK_SECONDS) return false;
  if (Math.abs(config.clockSkewSeconds) > MAX_CLOCK_SKEW_SECONDS) return false;
  if (config.finalityDelaySeconds < 0 || config.finalityDelaySeconds > MAX_FINALITY_DELAY_SECONDS) {
    return false;
  }
  return refundSchedule(config).gapSeconds >= MIN_REFUND_GAP_SECONDS;
}

/**
 * Validate at quote/announce construction time. Invalid or too-small gaps
 * throw BEFORE an order is announced to the coordinator.
 */
export function assertSafeTimelockConfiguration(config: TimelockConfiguration): void {
  if (!isSafeTimelockConfiguration(config)) {
    throw new Error(
      `unsafe timelock configuration: src=${config.sourceTimelockSeconds}s ` +
        `dst=${config.destinationTimelockSeconds}s skew=${config.clockSkewSeconds}s ` +
        `finality=${config.finalityDelaySeconds}s ` +
        `(required gap >= ${MIN_REFUND_GAP_SECONDS}s)`,
    );
  }
}

/** Deterministic LCG; property scenarios must be reproducible in CI. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function generateTimelockScenarios(count: number, seed = 1122): TimelockConfiguration[] {
  const next = lcg(seed);
  const scenarios: TimelockConfiguration[] = [];

  for (let i = 0; i < count; i++) {
    const sourceTimelockSeconds =
      MIN_TIMELOCK_SECONDS +
      Math.floor(next() * (MAX_TIMELOCK_SECONDS - MIN_TIMELOCK_SECONDS + 1));
    const destinationTimelockSeconds =
      MIN_TIMELOCK_SECONDS +
      Math.floor(next() * (sourceTimelockSeconds - MIN_TIMELOCK_SECONDS + 1));
    const clockSkewSeconds = Math.round(
      (next() * 2 - 1) * MAX_CLOCK_SKEW_SECONDS,
    );
    const finalityDelaySeconds = Math.floor(next() * (MAX_FINALITY_DELAY_SECONDS + 1));
    scenarios.push({
      sourceTimelockSeconds,
      destinationTimelockSeconds,
      clockSkewSeconds,
      finalityDelaySeconds,
    });
  }

  return scenarios;
}
