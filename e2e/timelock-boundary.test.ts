import { describe, expect, it } from "vitest";
import { generateSecret } from "@wafflefinance/sdk/secrets";
import { EvmHtlcSim, SorobanHtlcSim, SimError } from "./sim.js";
import {
  assertSafeTimelockConfiguration,
  CANONICAL_DESTINATION_TIMELOCK_SECONDS,
  CANONICAL_SOURCE_TIMELOCK_SECONDS,
  generateTimelockScenarios,
  isSafeTimelockConfiguration,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_FINALITY_DELAY_SECONDS,
  MIN_REFUND_GAP_SECONDS,
  MIN_TIMELOCK_SECONDS,
  refundSchedule,
  type TimelockConfiguration,
} from "./timelock-boundary.js";

describe("cross-chain timelock asymmetry boundaries (#1122)", () => {
  const secret = generateSecret();

  it("accepts the canonical 24h source / 12h destination configuration", () => {
    const config: TimelockConfiguration = {
      sourceTimelockSeconds: CANONICAL_SOURCE_TIMELOCK_SECONDS,
      destinationTimelockSeconds: CANONICAL_DESTINATION_TIMELOCK_SECONDS,
      clockSkewSeconds: MAX_CLOCK_SKEW_SECONDS,
      finalityDelaySeconds: MAX_FINALITY_DELAY_SECONDS,
    };
    expect(() => assertSafeTimelockConfiguration(config)).not.toThrow();
    const schedule = refundSchedule(config);
    expect(schedule.destinationRefundAt).toBeLessThan(schedule.sourceRefundAt);
    expect(schedule.gapSeconds).toBeGreaterThanOrEqual(MIN_REFUND_GAP_SECONDS);
  });

  it("rejects prohibited gap configurations before an order is announced", () => {
    const prohibited: TimelockConfiguration[] = [
      {
        sourceTimelockSeconds: 43_200,
        destinationTimelockSeconds: 43_200, // equal durations: no asymmetry
        clockSkewSeconds: 0,
        finalityDelaySeconds: 0,
      },
      {
        sourceTimelockSeconds: 43_200,
        destinationTimelockSeconds: 60_000, // destination outlasts source
        clockSkewSeconds: 0,
        finalityDelaySeconds: 0,
      },
      {
        sourceTimelockSeconds: 43_200,
        destinationTimelockSeconds: 42_700, // too-small gap
        clockSkewSeconds: MAX_CLOCK_SKEW_SECONDS,
        finalityDelaySeconds: MAX_FINALITY_DELAY_SECONDS,
      },
      {
        sourceTimelockSeconds: MIN_TIMELOCK_SECONDS - 1,
        destinationTimelockSeconds: 300,
        clockSkewSeconds: 0,
        finalityDelaySeconds: 0,
      },
      {
        sourceTimelockSeconds: 86_400,
        destinationTimelockSeconds: 43_200,
        clockSkewSeconds: MAX_CLOCK_SKEW_SECONDS + 1,
        finalityDelaySeconds: 0,
      },
      {
        sourceTimelockSeconds: 86_400,
        destinationTimelockSeconds: 43_200,
        clockSkewSeconds: 0,
        finalityDelaySeconds: MAX_FINALITY_DELAY_SECONDS + 1,
      },
    ];

    for (const config of prohibited) {
      let announced = false;
      expect(() => {
        assertSafeTimelockConfiguration(config); // quote/announce guard
        announced = true;
        new EvmHtlcSim().createOrder({
          hashlock: secret.sha256,
          timelockSeconds: config.sourceTimelockSeconds,
        });
      }).toThrow(/unsafe timelock configuration/);
      expect(announced).toBe(false);
    }
  });

  it("keeps refund ordering safe across every generated valid scenario", () => {
    const scenarios = generateTimelockScenarios(300);
    const valid = scenarios.filter(isSafeTimelockConfiguration);
    expect(valid.length).toBeGreaterThan(50);

    for (const config of valid) {
      const schedule = refundSchedule(config);
      expect(schedule.gapSeconds).toBeGreaterThanOrEqual(MIN_REFUND_GAP_SECONDS);
      expect(schedule.destinationRefundAt).toBeLessThan(schedule.sourceRefundAt);
      expect(() => assertSafeTimelockConfiguration(config)).not.toThrow();

      const source = new EvmHtlcSim();
      const destination = new SorobanHtlcSim();
      const sourceId = source.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: config.sourceTimelockSeconds,
      });
      const destinationId = destination.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: config.destinationTimelockSeconds,
      });

      // Resolver is refunded on the destination leg while the user's source
      // refund protection is still active.
      const resolverElapsed = config.destinationTimelockSeconds + config.finalityDelaySeconds + 1;
      destination.advanceTime(resolverElapsed);
      expect(() => destination.refundOrder(destinationId)).not.toThrow();
      expect(destination.getOrder(destinationId).status).toBe("Refunded");

      const sourceElapsed = resolverElapsed + Math.max(0, config.clockSkewSeconds);
      source.advanceTime(sourceElapsed);
      expect(sourceElapsed).toBeLessThan(config.sourceTimelockSeconds);
      expect(() => source.refundOrder(sourceId)).toThrow(SimError);

      // The user's refund protection opens only after the resolver's window.
      source.advanceTime(config.sourceTimelockSeconds - sourceElapsed + 1);
      expect(() => source.refundOrder(sourceId)).not.toThrow();
      expect(source.getOrder(sourceId).status).toBe("Refunded");
    }
  });

  it("generates reproducible scenarios", () => {
    expect(generateTimelockScenarios(25)).toEqual(generateTimelockScenarios(25));
  });
});
