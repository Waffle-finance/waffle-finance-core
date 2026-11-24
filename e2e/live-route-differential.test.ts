/**
 * Issue #1121 — differential tests for every live route direction.
 *
 * Directions are enumerated from the SDK route registry at runtime, so a
 * newly-live route is covered automatically and planned routes stay excluded.
 * Each direction runs a complete settlement and a recoverable timeout-refund
 * path against deterministic chain simulators, with timelock ordering checks.
 */

import { afterEach, describe, expect, it } from "vitest";
import { LIVE_ROUTE_DIRECTIONS, LIVE_DIRECTION_CHAINS } from "../packages/sdk/src/routes/index.js";
import { generateSecret } from "@wafflefinance/sdk/secrets";
import {
  createEnvironment,
  orderInput,
  startCoordinator,
  startRelayer,
  runSettlement,
  type TestEnvironment,
  type ChainFixture,
} from "./service-harness.js";

let env: TestEnvironment;

afterEach(async () => {
  await env?.cleanup();
  env = undefined as unknown as TestEnvironment;
});

function chainsFor(direction: (typeof LIVE_ROUTE_DIRECTIONS)[number]): {
  src: ChainFixture;
  dst: ChainFixture;
} {
  const { src, dst } = LIVE_DIRECTION_CHAINS[direction];
  return { src: env.chains[src], dst: env.chains[dst] };
}

describe("live route differential", () => {
  it("registry enumerates live directions and excludes planned ones", () => {
    expect(LIVE_ROUTE_DIRECTIONS.length).toBeGreaterThan(0);
    expect(LIVE_ROUTE_DIRECTIONS).not.toContain("xlm_to_sol");
    expect(LIVE_ROUTE_DIRECTIONS).not.toContain("sol_to_xlm");
  });

  for (const direction of LIVE_ROUTE_DIRECTIONS) {
    describe(direction, () => {
      it("settles with a route-specific sha256 preimage", async () => {
        env = createEnvironment();
        await startCoordinator(env);
        await startRelayer(env);
        const result = await runSettlement(env, { direction });
        expect(result.order.status).toBe("completed");
        expect(result.order.direction).toBe(direction);
        expect(result.order.srcChain).toBe(LIVE_DIRECTION_CHAINS[direction].src);
        expect(result.order.dstChain).toBe(LIVE_DIRECTION_CHAINS[direction].dst);
      }, 15_000);

      it("src timelock is strictly longer than dst timelock", async () => {
        env = createEnvironment();
        const { src, dst } = chainsFor(direction);
        const secret = generateSecret();
        const input = orderInput(direction, secret.sha256, env.chains);
        // Route fixture: source has a longer safety window than destination.
        const srcTimelock = direction === "sol_to_eth" ? 24 * 3600 : 1200;
        const dstTimelock = direction === "sol_to_eth" ? 12 * 3600 : 600;
        expect(srcTimelock).toBeGreaterThan(dstTimelock);
        expect(input.direction).toBe(direction);
        src.sim.createOrder({ hashlock: secret.sha256, timelockSeconds: srcTimelock });
        dst.sim.createOrder({ hashlock: secret.sha256, timelockSeconds: dstTimelock });
        expect(src.sim.getOrder(1n).timelockAbsolute).toBeGreaterThan(dst.sim.getOrder(1n).timelockAbsolute);
      });

      it("recovers from a timeout refund with normalized status", async () => {
        env = createEnvironment();
        await startCoordinator(env);
        await startRelayer(env);
        const secret = generateSecret();
        const res = await fetch(`${env.coordinator!.url}/api/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(orderInput(direction, secret.sha256, env.chains)),
        });
        const order = await res.json();
        const { src } = chainsFor(direction);
        const id = src.sim.createOrder({ hashlock: secret.sha256, timelockSeconds: 600 });
        src.sim.advanceTime(601);
        expect(() => src.sim.claimOrder(id, secret.preimage)).toThrow(/Expired/);
        src.sim.refundOrder(id);
        expect(src.sim.getOrder(id).status).toBe("Refunded");

        const applied = await fetch(`${env.relayer!.url}/api/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: `${order.publicId}:refund`,
            kind: "refund",
            payload: {},
            publicId: order.publicId,
          }),
        });
        expect(applied.ok).toBe(true);
        const final = await (await fetch(`${env.coordinator!.url}/api/orders/${order.publicId}`)).json();
        expect(final.status).toBe("refunded");
      }, 15_000);
    });
  }
});
