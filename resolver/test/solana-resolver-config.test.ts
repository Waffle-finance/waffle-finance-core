/**
 * Resolver config tests for Solana placeholder program IDs (#949).
 *
 * The Solana listener must never confuse a placeholder program identifier
 * with a live deployment. These cases exercise config resolution only —
 * no RPC call is made:
 *
 * - empty / undefined / placeholder IDs → `disabled`, never ready
 * - malformed IDs → throw before listener startup
 * - simulation flag + valid ID → `simulation`, never ready
 * - valid ID → `live` + ready (the mocked live-client path)
 */

import { describe, it, expect } from "vitest";
import {
  resolveSolanaListenerConfig,
  isSolanaProgramIdPlaceholder,
} from "../src/solana-config.js";

const VALID_PROGRAM_ID = "BMAXuAmNZBkCPfzgUw2XYB1vDbnAXx1sr7ewnyfCMtan";

describe("resolveSolanaListenerConfig — placeholder program IDs", () => {
  it.each([undefined, "", "   "])("treats %p as disabled, never ready", (programId) => {
    const resolution = resolveSolanaListenerConfig({ programId });
    expect(resolution.mode).toBe("disabled");
    expect(resolution.ready).toBe(false);
  });

  it.each([
    "PLACEHOLDER",
    "placeholder",
    "  PLACEHOLDER  ",
    "MY_PLACEHOLDER_PROGRAM",
    "YOUR_SOLANA_HTLC_PROGRAM",
    "YOUR_SOLANA_PROGRAM",
    "YOUR_PROGRAM_ID",
    "your_custom_value",
    "11111111111111111111111111111111",
  ])("treats placeholder %p as disabled, never ready", (programId) => {
    expect(isSolanaProgramIdPlaceholder(programId)).toBe(true);
    const resolution = resolveSolanaListenerConfig({ programId });
    expect(resolution.mode).toBe("disabled");
    // A placeholder configuration must never appear as a healthy live integration.
    expect(resolution.ready).toBe(false);
    expect(resolution.mode).not.toBe("live");
  });

  it("treats a malformed (non-placeholder, undecodable) ID as a startup failure", () => {
    expect(() => resolveSolanaListenerConfig({ programId: "not-a-pubkey!!!" })).toThrow(
      /refusing listener startup/
    );
    expect(() => resolveSolanaListenerConfig({ programId: "abc" })).toThrow();
  });

  it("selects simulation mode when forced, even with a valid program ID", () => {
    const resolution = resolveSolanaListenerConfig({
      programId: VALID_PROGRAM_ID,
      simulationMode: true,
    });
    expect(resolution.mode).toBe("simulation");
    expect(resolution.ready).toBe(false);
  });

  it("selects live mode with readiness for a valid program ID (mocked live-client path)", () => {
    const resolution = resolveSolanaListenerConfig({ programId: VALID_PROGRAM_ID });
    expect(resolution.mode).toBe("live");
    expect(resolution.ready).toBe(true);
  });

  it("is independent of live RPC — resolution performs no network I/O", () => {
    // Pure function: no Connection import, no fetch. A valid ID resolves
    // synchronously without any async RPC round-trip.
    const resolution = resolveSolanaListenerConfig({ programId: VALID_PROGRAM_ID });
    expect(resolution).toMatchObject({ mode: "live", ready: true });
  });
});
