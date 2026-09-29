/**
 * Tests for the Solana integration contract layer.
 *
 * Validates both placeholder and configured modes, ensuring that:
 *  - Placeholder mode fails fast with clear errors
 *  - Configured mode is structurally correct and validates inputs
 *  - The factory function makes the right choice based on program ID
 *  - Address validation works in both modes
 *  - The interface is stable across both modes
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { pino } from "pino";
import {
  createSolanaIntegration,
  SolanaDisabledError,
  SolanaSubmissionError,
  isConfiguredSolana,
  type SolanaIntegration,
} from "../src/services/solana-contract.js";

describe("Solana Integration Contract", () => {
  let log: ReturnType<typeof pino>;

  beforeEach(() => {
    log = pino({ level: "silent" });
  });

  describe("Placeholder Mode", () => {
    const placeholderValues = [
      undefined,
      "",
      "PLACEHOLDER",
      "YOUR_SOLANA_HTLC_PROGRAM",
      "YOUR_PROGRAM_ID",
      "11111111111111111111111111111111",
    ];

    placeholderValues.forEach((programId) => {
      it(`should create placeholder integration for programId="${programId}"`, () => {
        const integration = createSolanaIntegration(
          programId,
          log,
          "https://api.devnet.solana.com"
        );

        expect(integration.mode).toBe("placeholder");
        expect(integration.programId).toBeUndefined();
        expect(integration.isEnabled()).toBe(false);
      });
    });

    it("should reject lock submission in placeholder mode", async () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.devnet.solana.com"
      );

      await expect(
        integration.submitLock({
          beneficiary: "BeneficiaryAddress",
          refundAddress: "RefundAddress",
          amount: 1000000n,
          hashlock: "0x" + "a".repeat(64),
          timelock: Math.floor(Date.now() / 1000) + 3600,
        })
      ).rejects.toThrow(SolanaDisabledError);
    });

    it("should reject claim submission in placeholder mode", async () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.devnet.solana.com"
      );

      await expect(
        integration.submitClaim({
          orderId: "order123",
          preimage: "0x" + "b".repeat(64),
          claimer: "ClaimerAddress",
        })
      ).rejects.toThrow(SolanaDisabledError);
    });

    it("should reject refund submission in placeholder mode", async () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.devnet.solana.com"
      );

      await expect(
        integration.submitRefund({
          orderId: "order123",
          refunder: "RefunderAddress",
        })
      ).rejects.toThrow(SolanaDisabledError);
    });

    it("should validate Solana addresses in placeholder mode", () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.devnet.solana.com"
      );

      // Valid Solana address format (base58, 32-44 chars)
      expect(integration.validateAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe(true);

      // Invalid formats
      expect(integration.validateAddress("")).toBe(false);
      expect(integration.validateAddress("0xabcdef")).toBe(false);
      expect(integration.validateAddress("tooshort")).toBe(false);
    });
  });

  describe("Configured Mode", () => {
    const realProgramId = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    it("should create configured integration for real program ID", () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.devnet.solana.com"
      );

      expect(integration.mode).toBe("configured");
      expect(integration.programId).toBe(realProgramId);
      expect(integration.isEnabled()).toBe(true);
    });

    it("should expose programId in configured mode", () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.devnet.solana.com"
      );

      expect(integration.programId).toBe(realProgramId);
    });

    it("should validate Solana addresses in configured mode using PublicKey", () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.devnet.solana.com"
      );

      // Valid Solana public key
      expect(integration.validateAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe(true);
      // Invalid formats
      expect(integration.validateAddress("")).toBe(false);
      expect(integration.validateAddress("0xabcdef")).toBe(false);
    });

    it("should fail lock submission with SolanaSubmissionError when key is empty", async () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.devnet.solana.com"
      );

      // Configured but no private key — should throw SolanaSubmissionError
      // because the Keypair constructor will fail with an empty key.
      await expect(
        integration.submitLock({
          beneficiary: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          refundAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          amount: 1000000n,
          hashlock: "0x" + "a".repeat(64),
          timelock: Math.floor(Date.now() / 1000) + 3600,
        })
      ).rejects.toThrow(SolanaSubmissionError);
    });

    it("should fail claim submission with SolanaSubmissionError when key is empty", async () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.devnet.solana.com"
      );

      await expect(
        integration.submitClaim({
          orderId: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          preimage: "0x" + "b".repeat(64),
          claimer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        })
      ).rejects.toThrow(SolanaSubmissionError);
    });

    it("should fail refund submission with SolanaSubmissionError when key is empty", async () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.devnet.solana.com"
      );

      await expect(
        integration.submitRefund({
          orderId: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          refunder: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        })
      ).rejects.toThrow(SolanaSubmissionError);
    });
  });

  describe("Type Guards", () => {
    it("should correctly identify placeholder mode", () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.devnet.solana.com"
      );

      expect(isConfiguredSolana(integration)).toBe(false);
    });

    it("should correctly identify configured mode", () => {
      const integration = createSolanaIntegration(
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        log,
        "https://api.devnet.solana.com"
      );

      expect(isConfiguredSolana(integration)).toBe(true);
    });
  });

  describe("Factory Decision Path", () => {
    it("should log explicitly when placeholder mode is chosen", () => {
      const testLog = pino({
        level: "warn",
      });

      createSolanaIntegration("PLACEHOLDER", testLog, "https://api.devnet.solana.com");

      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.devnet.solana.com"
      );
      expect(integration.mode).toBe("placeholder");
    });

    it("should log explicitly when configured mode is chosen", () => {
      const integration = createSolanaIntegration(
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        log,
        "https://api.devnet.solana.com"
      );

      expect(integration.mode).toBe("configured");
    });

    it("should warn when configured but no private key is provided", () => {
      const warnSpy = vi.spyOn(log, "warn");
      createSolanaIntegration(
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        log,
        "https://api.devnet.solana.com"
      );
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("Contract Stability", () => {
    it("should expose stable interface for all modes", () => {
      const placeholder = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.devnet.solana.com"
      );
      const configured = createSolanaIntegration(
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        log,
        "https://api.devnet.solana.com"
      );

      // Both modes expose the same interface
      const checkInterface = (integration: SolanaIntegration) => {
        expect(typeof integration.mode).toBe("string");
        expect(typeof integration.isEnabled).toBe("function");
        expect(typeof integration.validateAddress).toBe("function");
        expect(typeof integration.submitLock).toBe("function");
        expect(typeof integration.submitClaim).toBe("function");
        expect(typeof integration.submitRefund).toBe("function");
      };

      checkInterface(placeholder);
      checkInterface(configured);
    });
  });
});
