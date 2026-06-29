import { describe, it, expect } from "vitest";
import { getRouteCapability } from "../src/capability.js";

describe("capability matrix", () => {
  it("fully supports ethereum <-> stellar routes on both networks", () => {
    const r1 = getRouteCapability("ethereum", "stellar", "wafflefinance-htlc", "testnet");
    expect(r1.status).toBe("supported");

    const r2 = getRouteCapability("stellar", "ethereum", "wafflefinance-htlc", "mainnet");
    expect(r2.status).toBe("supported");
  });

  it("blocks intra-chain transfers", () => {
    const r1 = getRouteCapability("ethereum", "ethereum", "wafflefinance-htlc", "testnet");
    expect(r1.status).toBe("unsupported");
    expect(r1.reason).toContain("Intra-chain transfers on ethereum are not supported");

    const r2 = getRouteCapability("stellar", "stellar", "wafflefinance-htlc", "mainnet");
    expect(r2.status).toBe("unsupported");
  });

  it("handles solana on testnet as partially supported (simulation mode)", () => {
    const r1 = getRouteCapability("ethereum", "solana", "wafflefinance-htlc", "testnet");
    expect(r1.status).toBe("partially-supported");
    expect(r1.reason).toContain("Simulation Mode on Testnet");

    const r2 = getRouteCapability("solana", "stellar", "wafflefinance-htlc", "testnet");
    expect(r2.status).toBe("partially-supported");
  });

  it("blocks solana on mainnet", () => {
    const r1 = getRouteCapability("ethereum", "solana", "wafflefinance-htlc", "mainnet");
    expect(r1.status).toBe("unsupported");
    expect(r1.reason).toContain("Solana swaps are not supported on Mainnet yet");

    const r2 = getRouteCapability("solana", "stellar", "wafflefinance-htlc", "mainnet");
    expect(r2.status).toBe("unsupported");
  });

  it("blocks unsupported route adapters (cctp-v2, axelar-its)", () => {
    const r1 = getRouteCapability("ethereum", "stellar", "cctp-v2", "testnet");
    expect(r1.status).toBe("unsupported");
    expect(r1.reason).toContain("under development");

    const r2 = getRouteCapability("ethereum", "stellar", "axelar-its", "mainnet");
    expect(r2.status).toBe("unsupported");
  });

  it("handles invalid route combinations as unsupported", () => {
    // E.g., if someone tries to check some random unsupported combination
    const r1 = getRouteCapability("unknown" as any, "ethereum", "wafflefinance-htlc", "testnet");
    expect(r1.status).toBe("unsupported");
    expect(r1.reason).toContain("is not supported");
  });
});
