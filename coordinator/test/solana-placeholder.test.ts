/**
 * Tests for Solana placeholder detection in the coordinator context.
 *
 * Covers:
 *  - The shared isSolanaPlaceholder / checkSolanaConfig utilities imported
 *    from @wafflefinance/config (ensures the coordinator uses the same
 *    logic as the relayer — no drift)
 *  - SolanaListener.start() early-return guard for every placeholder variant
 *  - All SOLANA_PLACEHOLDER_VALUES entries are recognised
 *  - Real program addresses are not flagged
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import {
  isSolanaPlaceholder,
  checkSolanaConfig,
  SOLANA_PLACEHOLDER_VALUES,
} from "../src/config.js";
import { SolanaListener } from "../src/listeners/solana-listener.js";
import type { CoordinatorConfig } from "../src/config.js";

// ─── Shared utility tests (mirror relayer/test/solana-config.test.ts) ────────
// These ensure coordinator and relayer share the exact same detection logic
// with no divergence.

describe("isSolanaPlaceholder — undefined / blank", () => {
  it("returns true for undefined", () => {
    expect(isSolanaPlaceholder(undefined)).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(isSolanaPlaceholder("")).toBe(true);
  });

  it("returns true for whitespace-only string", () => {
    expect(isSolanaPlaceholder("   ")).toBe(true);
  });
});

describe("isSolanaPlaceholder — known placeholder set", () => {
  it("flags every entry in SOLANA_PLACEHOLDER_VALUES", () => {
    for (const value of SOLANA_PLACEHOLDER_VALUES) {
      expect(isSolanaPlaceholder(value), `should flag: "${value}"`).toBe(true);
    }
  });

  it("flags PLACEHOLDER case-insensitively", () => {
    expect(isSolanaPlaceholder("placeholder")).toBe(true);
    expect(isSolanaPlaceholder("Placeholder")).toBe(true);
    expect(isSolanaPlaceholder("PLACEHOLDER")).toBe(true);
  });

  it("flags the all-ones system program address", () => {
    expect(isSolanaPlaceholder("11111111111111111111111111111111")).toBe(true);
  });
});

describe("isSolanaPlaceholder — substring / prefix rules", () => {
  it("flags strings that contain PLACEHOLDER as a substring", () => {
    expect(isSolanaPlaceholder("MY_PLACEHOLDER_PROGRAM")).toBe(true);
    expect(isSolanaPlaceholder("solana_placeholder_value")).toBe(true);
  });

  it("flags strings that start with YOUR_ (case-insensitive)", () => {
    expect(isSolanaPlaceholder("YOUR_PROGRAM_ID_HERE")).toBe(true);
    expect(isSolanaPlaceholder("your_program")).toBe(true);
    expect(isSolanaPlaceholder("YOUR_CUSTOM_HTLC_PROGRAM")).toBe(true);
  });
});

describe("isSolanaPlaceholder — real program addresses", () => {
  it("returns false for a realistic base-58 Solana program ID", () => {
    expect(isSolanaPlaceholder("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe(false);
  });

  it("returns false for the SPL Token program", () => {
    expect(isSolanaPlaceholder("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe(false);
  });
});

describe("checkSolanaConfig", () => {
  it('returns "placeholder" for undefined', () => {
    expect(checkSolanaConfig(undefined)).toBe("placeholder");
  });

  it('returns "placeholder" for the canonical PLACEHOLDER string', () => {
    expect(checkSolanaConfig("PLACEHOLDER")).toBe("placeholder");
  });

  it('returns "placeholder" for the system program all-ones address', () => {
    expect(checkSolanaConfig("11111111111111111111111111111111")).toBe("placeholder");
  });

  it('returns "configured" for a realistic base-58 program ID', () => {
    expect(checkSolanaConfig("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe("configured");
  });
});

// ─── SolanaListener.start() guard ─────────────────────────────────────────────

// Mock @solana/web3.js so SolanaListener can be instantiated without a real
// Connection (we only test the start() guard — no actual RPC calls needed).
vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(() => ({})),
  PublicKey: vi.fn((id: string) => ({ toBase58: () => id })),
}));

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "silent",
  corsOrigin: "*",
  pollIntervalMs: 1,
  ethereum: {
    rpcUrl: "https://rpc.test",
    chainId: 11_155_111,
    htlcEscrow: null,
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: "https://soroban.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: "Test",
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: {
    rpcUrl: "https://solana.test",
    programId: "PLACEHOLDER",
    commitment: "confirmed",
  },
};

const SILENT_LOG = pino({ level: "silent" });

// Minimal OrderService stub — only start() is under test, no DB needed.
const stubOrders = {} as any;

describe("SolanaListener.start() — placeholder guard", () => {
  it('does not start the poll loop when programId is "PLACEHOLDER"', () => {
    const listener = new SolanaListener(BASE_CFG, stubOrders, SILENT_LOG);
    // loop() is private and async; if start() returned early, `stopped` stays
    // false and nothing polls. We verify indirectly by checking the warn log.
    const warnSpy = vi.spyOn(listener["log"], "warn");
    listener.start();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ programId: "PLACEHOLDER" }),
      expect.stringContaining("placeholder")
    );
  });

  it("does not start the poll loop for every known placeholder value", () => {
    for (const placeholder of SOLANA_PLACEHOLDER_VALUES) {
      const cfg = { ...BASE_CFG, solana: { ...BASE_CFG.solana, programId: placeholder } };
      const listener = new SolanaListener(cfg, stubOrders, SILENT_LOG);
      const warnSpy = vi.spyOn(listener["log"], "warn");
      listener.start();
      expect(
        warnSpy,
        `expected warn for placeholder "${placeholder}"`
      ).toHaveBeenCalled();
    }
  });

  it("does not start the poll loop for empty programId", () => {
    const cfg = { ...BASE_CFG, solana: { ...BASE_CFG.solana, programId: "" } };
    const listener = new SolanaListener(cfg, stubOrders, SILENT_LOG);
    const warnSpy = vi.spyOn(listener["log"], "warn");
    listener.start();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("does not start the poll loop for whitespace programId", () => {
    const cfg = { ...BASE_CFG, solana: { ...BASE_CFG.solana, programId: "   " } };
    const listener = new SolanaListener(cfg, stubOrders, SILENT_LOG);
    const warnSpy = vi.spyOn(listener["log"], "warn");
    listener.start();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("starts the poll loop (calls info, not warn) when programId is a real address", () => {
    const realProgramId = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const cfg = { ...BASE_CFG, solana: { ...BASE_CFG.solana, programId: realProgramId } };
    const listener = new SolanaListener(cfg, stubOrders, SILENT_LOG);
    const infoSpy = vi.spyOn(listener["log"], "info");
    const warnSpy = vi.spyOn(listener["log"], "warn");

    listener.start();

    // Must log info (starting), not warn (disabled).
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ program: realProgramId }),
      expect.stringContaining("starting")
    );
    // Placeholder warn must NOT have fired.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("placeholder")
    );

    listener.stop();
  });
});
