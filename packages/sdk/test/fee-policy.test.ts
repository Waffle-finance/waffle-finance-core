import { describe, expect, it } from "vitest";

import {
  estimateRouteFee,
  getRouteFeePolicy,
  type RouteFeeEstimate,
} from "../src/index.js";

describe("route fee policy", () => {
  it("returns deterministic low-fee and high-fee estimates for the same route", () => {
    const lowFee = estimateRouteFee("eth_to_xlm:native:wafflefinance-htlc", {
      gasEstimate: 1n,
      protocolFee: 1n,
      expectedRelayCost: 2n,
      minSafetyDeposit: 3n,
    });

    const highFee = estimateRouteFee("eth_to_xlm:native:wafflefinance-htlc", {
      gasEstimate: 100n,
      protocolFee: 25n,
      expectedRelayCost: 80n,
      minSafetyDeposit: 50n,
    });

    expect(lowFee.totalEstimatedCost).toBe(1n + 2n + 3n + 1n);
    expect(highFee.totalEstimatedCost).toBe(100n + 80n + 50n + 25n);
    expect(highFee.totalEstimatedCost).toBeGreaterThan(lowFee.totalEstimatedCost);
  });

  it("uses route-aware assumptions across the supported chain matrix", () => {
    const ethToXlm = getRouteFeePolicy("eth_to_xlm:native:wafflefinance-htlc");
    const ethToSol = getRouteFeePolicy("eth_to_sol:native:wafflefinance-htlc");
    const solToEth = getRouteFeePolicy("sol_to_eth:native:wafflefinance-htlc");

    expect(ethToXlm.routeId).toBe("eth_to_xlm:native:wafflefinance-htlc");
    expect(ethToXlm.assumptions).toContain("ethereum submission and stellar settlement");
    expect(ethToSol.assumptions).toContain("ethereum submission and solana settlement");
    expect(solToEth.assumptions).toContain("solana submission and ethereum settlement");
  });

  it("exposes the fee estimate contract to consumers", () => {
    const estimate = estimateRouteFee("eth_to_sol:native:wafflefinance-htlc", {
      gasEstimate: 5n,
      protocolFee: 4n,
      expectedRelayCost: 6n,
      minSafetyDeposit: 7n,
    });

    const expected: RouteFeeEstimate = {
      routeId: "eth_to_sol:native:wafflefinance-htlc",
      gasEstimate: 5n,
      protocolFee: 4n,
      minSafetyDeposit: 7n,
      expectedRelayCost: 6n,
      totalEstimatedCost: 22n,
      assumptions: ["ethereum submission and solana settlement", "native safety deposit on source leg"],
    };

    expect(estimate).toEqual(expected);
  });
});
