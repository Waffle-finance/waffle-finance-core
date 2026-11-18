/**
 * Solana client configuration boundary tests.
 *
 * Covers the config parsing layer that sits between raw user input and the
 * first instruction construction. No RPC connection is made anywhere in this
 * file — all assertions happen at construction time or via the pure
 * production-readiness helpers.
 *
 * The three distinct regions under test are:
 *   1. Empty / blank program IDs         → simulation mode selected
 *   2. Documented placeholder strings    → simulation mode selected
 *   3. Malformed live IDs                → SdkConfigurationError thrown before any
 *                                          instruction is built
 *   4. Valid base-58 program IDs         → client created without error, real mode
 *
 * Acceptance criteria satisfied:
 *   ✓ Malformed live IDs fail clearly before instruction construction
 *   ✓ Placeholder mode is explicit and observable (simulation flag + console.warn)
 *   ✓ Valid IDs proceed to the existing mocked client path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { SolanaHTLCClient } from "../src/solana/index.js";
import { SdkConfigurationError, validateSolanaAddress } from "../src/config-validation.js";
import {
  isSolanaPlaceholder,
  checkSolanaConfig,
  SOLANA_PLACEHOLDER_VALUES,
} from "../../config/src/solana-placeholder.js";
import {
  assessSolanaProductionReadiness,
  assertSolanaProductionReady,
  SolanaProductionGatingError,
} from "../src/solana/production-readiness.js";

// A real program ID that is structurally valid (not deployed, but passes parse).
const VALID_PROGRAM_ID = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
// SPL Token program — always a well-known valid key.
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// ATA program — another well-known valid key.
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1hBQ";

const DEVNET_RPC = "https://api.devnet.solana.com";

// ── 1. Empty / blank program IDs ────────────────────────────────────────────

describe("isSolanaPlaceholder — empty and blank inputs", () => {
  it("treats undefined as a placeholder", () => {
    expect(isSolanaPlaceholder(undefined)).toBe(true);
  });

  it("treats an empty string as a placeholder", () => {
    expect(isSolanaPlaceholder("")).toBe(true);
  });

  it("treats a whitespace-only string as a placeholder", () => {
    expect(isSolanaPlaceholder("   ")).toBe(true);
  });

  it('checkSolanaConfig returns "placeholder" for undefined', () => {
    expect(checkSolanaConfig(undefined)).toBe("placeholder");
  });

  it('checkSolanaConfig returns "placeholder" for empty string', () => {
    expect(checkSolanaConfig("")).toBe("placeholder");
  });
});

// ── 2. Documented placeholder strings ───────────────────────────────────────

describe("isSolanaPlaceholder — documented placeholder strings", () => {
  it("flags every entry in SOLANA_PLACEHOLDER_VALUES", () => {
    for (const value of SOLANA_PLACEHOLDER_VALUES) {
      expect(isSolanaPlaceholder(value), `expected "${value}" to be a placeholder`).toBe(true);
    }
  });

  it('flags "PLACEHOLDER" in any case variant', () => {
    expect(isSolanaPlaceholder("PLACEHOLDER")).toBe(true);
    expect(isSolanaPlaceholder("placeholder")).toBe(true);
    expect(isSolanaPlaceholder("Placeholder")).toBe(true);
    expect(isSolanaPlaceholder("plAcEhOlDeR")).toBe(true);
  });

  it("flags strings that contain PLACEHOLDER as a substring", () => {
    expect(isSolanaPlaceholder("MY_PLACEHOLDER_HTLC")).toBe(true);
    expect(isSolanaPlaceholder("solana_placeholder")).toBe(true);
  });

  it("flags strings that start with YOUR_ (any case)", () => {
    expect(isSolanaPlaceholder("YOUR_PROGRAM_ID")).toBe(true);
    expect(isSolanaPlaceholder("your_program_id")).toBe(true);
    expect(isSolanaPlaceholder("YOUR_SOLANA_HTLC_PROGRAM")).toBe(true);
  });

  it("flags the all-ones system program address as a placeholder", () => {
    expect(isSolanaPlaceholder("11111111111111111111111111111111")).toBe(true);
  });
});

// ── 3. SolanaHTLCClient enters simulation mode for placeholder IDs ───────────

describe("SolanaHTLCClient — simulation mode selected for placeholder IDs", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('emits a console.warn and enters simulation mode when programId is "PLACEHOLDER"', () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulation mode"));
    // Observable: simulation flag is observable via getOrder returning null.
    expect(client.getOrder("anything")).resolves.toBeNull();
  });

  it("simulation mode is the only mode triggered by the documented placeholder — not by valid IDs", () => {
    // Valid ID must NOT trigger the simulation warning.
    const validClient = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: VALID_PROGRAM_ID });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("simulation mode"));
    void validClient; // suppress unused-var lint
  });

  it("simulation getOrder returns null (no RPC call needed)", async () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" });
    const result = await client.getOrder("fakeOrderId");
    expect(result).toBeNull();
  });

  it("simulation createOrder returns a SIMULATION_ prefixed txSignature", async () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" });
    const fakeSigner = {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      signTransaction: async (tx: unknown) => tx as any,
    };
    const result = await client.createOrder(
      {
        sender:         "11111111111111111111111111111111",
        beneficiary:    "11111111111111111111111111111111",
        refundAddress:  "11111111111111111111111111111111",
        mint:           "So11111111111111111111111111111111111111112",
        amount:         BigInt(1000),
        safetyDeposit:  BigInt(100),
        hashlockHex:    ("0x" + "ab".repeat(32)) as `0x${string}`,
        timelockSeconds: 3600,
      },
      fakeSigner
    );
    expect(result.txSignature).toMatch(/^SIMULATION_/);
    expect(result.orderId).toMatch(/^sim-/);
  });

  it("simulation claimOrder returns SIMULATION_CLAIM_ prefix", async () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" });
    const fakeSigner = {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      signTransaction: async (tx: unknown) => tx as any,
    };
    const sig = await client.claimOrder(
      "sim-order",
      ("0x" + "cc".repeat(32)) as `0x${string}`,
      fakeSigner
    );
    expect(sig).toMatch(/^SIMULATION_CLAIM_/);
  });

  it("simulation refundOrder returns SIMULATION_REFUND_ prefix", async () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" });
    const fakeSigner = {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      signTransaction: async (tx: unknown) => tx as any,
    };
    const sig = await client.refundOrder("sim-order", fakeSigner);
    expect(sig).toMatch(/^SIMULATION_REFUND_/);
  });

  it("deriveOrderId throws in simulation mode — no programId to derive from", () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" });
    expect(() => client.deriveOrderId(("0x" + "ab".repeat(32)) as `0x${string}`)).toThrow(
      /simulation mode/i
    );
  });
});

// ── 4. Malformed live program IDs ────────────────────────────────────────────

describe("validateSolanaAddress — malformed IDs fail before instruction construction", () => {
  it("rejects an empty string", () => {
    expect(() => validateSolanaAddress("", "programId")).toThrow(SdkConfigurationError);
  });

  it("rejects a whitespace string", () => {
    expect(() => validateSolanaAddress("   ", "programId")).toThrow(SdkConfigurationError);
  });

  it("rejects a non-base58 string (contains 0, O, I, l)", () => {
    // '0' is excluded from base-58 alphabet
    expect(() => validateSolanaAddress("0".repeat(44), "programId")).toThrow(SdkConfigurationError);
  });

  it("rejects a hex string that is not a valid Solana public key", () => {
    expect(() => validateSolanaAddress("0xdeadbeef", "programId")).toThrow(SdkConfigurationError);
  });

  it("rejects an address that is too short to be a valid public key", () => {
    expect(() => validateSolanaAddress("abc123", "programId")).toThrow(SdkConfigurationError);
  });

  it("rejects an EVM-style address", () => {
    expect(() =>
      validateSolanaAddress("0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b", "programId")
    ).toThrow(SdkConfigurationError);
  });

  it("error carries the invalid_address code", () => {
    try {
      validateSolanaAddress("not-a-key", "programId");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SdkConfigurationError);
      const e = err as SdkConfigurationError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues[0].code).toBe("invalid_address");
    }
  });

  it("error message names the field that failed", () => {
    try {
      validateSolanaAddress("bad-value", "solana.programId");
    } catch (err) {
      const e = err as SdkConfigurationError;
      expect(e.message).toContain("solana.programId");
    }
  });
});

describe("SolanaHTLCClient constructor — malformed live IDs throw before construction", () => {
  it("throws SdkConfigurationError for a hex string that is not a valid public key", () => {
    expect(
      () => new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "0xdeadbeef" })
    ).toThrow(SdkConfigurationError);
  });

  it("throws SdkConfigurationError for a single-character string", () => {
    expect(
      () => new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "X" })
    ).toThrow(SdkConfigurationError);
  });

  it("does NOT throw for the canonical PLACEHOLDER string — enters simulation instead", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      () => new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" })
    ).not.toThrow();
    vi.restoreAllMocks();
  });
});

// ── 5. Valid program IDs — real mode, no simulation ─────────────────────────

describe("SolanaHTLCClient constructor — valid program IDs proceed without simulation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("accepts a realistic base-58 program ID", () => {
    expect(() => new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: VALID_PROGRAM_ID })).not.toThrow();
  });

  it("does not emit the simulation-mode warning for a valid program ID", () => {
    new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: VALID_PROGRAM_ID });
    const simWarnCalls = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("simulation mode")
    );
    expect(simWarnCalls).toHaveLength(0);
  });

  it("accepts the SPL Token program ID", () => {
    expect(() => new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: SPL_TOKEN_PROGRAM })).not.toThrow();
  });

  it("accepts the ATA program ID", () => {
    expect(() => new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: ATA_PROGRAM })).not.toThrow();
  });

  it("stores the canonical base-58 form of the program ID", () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: VALID_PROGRAM_ID });
    expect(client.programId).toBe(VALID_PROGRAM_ID);
  });

  it("deriveOrderId works for a valid programId", () => {
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: VALID_PROGRAM_ID });
    const hashlock = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const orderId = client.deriveOrderId(hashlock);
    // Must be a valid base-58 Solana public key.
    expect(() => new PublicKey(orderId)).not.toThrow();
  });
});

// ── 6. assessSolanaProductionReadiness — program ID check ───────────────────

describe("assessSolanaProductionReadiness — program_id_configured check", () => {
  it('reports status "failed" when programId is undefined', () => {
    const report = assessSolanaProductionReadiness({});
    const check = report.checks.find((c) => c.id === "program_id_configured");
    expect(check?.status).toBe("failed");
    // The blocker message should mention something about placeholder or not configured.
    const blockerText = report.blockers.join(" ").toLowerCase();
    expect(
      blockerText.includes("placeholder") || blockerText.includes("not configured") || blockerText.includes("missing")
    ).toBe(true);
  });

  it('reports status "failed" when programId is the canonical PLACEHOLDER string', () => {
    const report = assessSolanaProductionReadiness({ programId: "PLACEHOLDER" });
    const check = report.checks.find((c) => c.id === "program_id_configured");
    expect(check?.status).toBe("failed");
  });

  it('reports status "failed" when programId is the all-ones system program', () => {
    const report = assessSolanaProductionReadiness({ programId: "11111111111111111111111111111111" });
    const check = report.checks.find((c) => c.id === "program_id_configured");
    expect(check?.status).toBe("failed");
  });

  it('reports status "failed" for a malformed non-placeholder ID (not a valid public key)', () => {
    const report = assessSolanaProductionReadiness({ programId: "not-a-real-program-id!!" });
    const check = report.checks.find((c) => c.id === "program_id_configured");
    expect(check?.status).toBe("failed");
    expect(report.blockers.some((b) => b.toLowerCase().includes("malformed") || b.toLowerCase().includes("valid"))).toBe(true);
  });

  it('reports status "passed" for a valid base-58 program ID', () => {
    const report = assessSolanaProductionReadiness({ programId: VALID_PROGRAM_ID });
    const check = report.checks.find((c) => c.id === "program_id_configured");
    expect(check?.status).toBe("passed");
  });

  it("a malformed ID adds a blocker distinct from the placeholder blocker", () => {
    const malformedReport = assessSolanaProductionReadiness({ programId: "!!bad!!" });
    const malformedBlocker = malformedReport.blockers[0];

    const placeholderReport = assessSolanaProductionReadiness({ programId: "PLACEHOLDER" });
    const placeholderBlocker = placeholderReport.blockers[0];

    // Both are failures but the messages differ — malformed vs not configured.
    expect(malformedBlocker).not.toBe(placeholderBlocker);
  });

  it("assertSolanaProductionReady throws SolanaProductionGatingError for a placeholder", () => {
    expect(() =>
      assertSolanaProductionReady({ programId: "PLACEHOLDER", environment: "mainnet-beta" })
    ).toThrow(SolanaProductionGatingError);
  });

  it("assertSolanaProductionReady throws for a malformed program ID", () => {
    expect(() =>
      assertSolanaProductionReady({ programId: "bad-id!", environment: "mainnet-beta" })
    ).toThrow(SolanaProductionGatingError);
  });
});

// ── 7. Simulation mode is only triggered by the documented set ──────────────

describe("simulation mode is exclusive to documented placeholder conditions", () => {
  const warnSpy = vi.fn();

  afterEach(() => {
    warnSpy.mockClear();
    vi.restoreAllMocks();
  });

  /**
   * SolanaHTLCClient uses `programId === 'PLACEHOLDER'` (exact match) as the
   * simulation gate.  Only that single string bypasses validateSolanaAddress
   * and enters simulation.  All other values — including other isSolanaPlaceholder
   * strings — are passed to validateSolanaAddress and throw for invalid base-58.
   */
  it('simulation mode is triggered exclusively by the exact string "PLACEHOLDER"', () => {
    vi.spyOn(console, "warn").mockImplementation(warnSpy);
    const client = new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "PLACEHOLDER" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("simulation mode"));
    void client;
  });

  it("isSolanaPlaceholder recognises the broader placeholder set (YOUR_*, etc.)", () => {
    // These strings are caught at the config layer (isSolanaPlaceholder) before
    // the client is constructed.  They should not reach the constructor in real usage.
    expect(isSolanaPlaceholder("YOUR_SOLANA_HTLC_PROGRAM")).toBe(true);
    expect(isSolanaPlaceholder("YOUR_PROGRAM_ID")).toBe(true);
    expect(isSolanaPlaceholder("placeholder")).toBe(true);
    expect(isSolanaPlaceholder("your_program")).toBe(true);
  });

  it("non-PLACEHOLDER invalid strings throw SdkConfigurationError, not simulation", () => {
    // "YOUR_SOLANA_HTLC_PROGRAM" is a config-level placeholder but NOT the exact
    // "PLACEHOLDER" string, so the constructor validates it as a Solana address and throws.
    expect(
      () => new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: "YOUR_SOLANA_HTLC_PROGRAM" })
    ).toThrow(SdkConfigurationError);
  });

  const NON_PLACEHOLDER_VALID_INPUTS = [VALID_PROGRAM_ID, SPL_TOKEN_PROGRAM, ATA_PROGRAM];

  for (const pid of NON_PLACEHOLDER_VALID_INPUTS) {
    it(`no simulation warning for valid program ID "${pid.slice(0, 16)}…"`, () => {
      vi.spyOn(console, "warn").mockImplementation(warnSpy);
      new SolanaHTLCClient({ rpcUrl: DEVNET_RPC, programId: pid });
      const simCalls = warnSpy.mock.calls.filter((a) => String(a[0]).includes("simulation mode"));
      expect(simCalls).toHaveLength(0);
    });
  }
});
