import { describe, it, expect } from "vitest";
import {
  assessSolanaProductionReadiness,
  assertSolanaProductionReady,
  SolanaProductionGatingError,
  DEVNET_TOKEN_MINTS,
  MAINNET_TOKEN_MINTS,
  PUBLIC_DEVNET_RPC_ENDPOINTS,
  SOLANA_SETTLEMENT_OPERATIONS_CHECKLIST,
} from "../src/solana/production-readiness.js";

describe("Solana Production Readiness Audit & Gating", () => {
  const validMainnetProgramId = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const validPrivateRpc = "https://solana-mainnet.g.alchemy.com/v2/my-api-key";
  const secondaryPrivateRpc = "https://mainnet.helius-rpc.com/?api-key=my-api-key";

  describe("assessSolanaProductionReadiness", () => {
    it("should report non-production readiness when programId is placeholder or missing", () => {
      const report = assessSolanaProductionReadiness({
        environment: "devnet",
        programId: "PLACEHOLDER",
      });

      expect(report.isProductionReady).toBe(false);
      expect(report.summary.failures).toBeGreaterThanOrEqual(1);
      expect(report.blockers).toContain(
        "Solana HTLC Program ID is not configured or is a placeholder."
      );
      const programCheck = report.checks.find((c) => c.id === "program_id_configured");
      expect(programCheck?.status).toBe("failed");
    });

    it("should pass devnet assessment with valid program ID and devnet endpoints", () => {
      const report = assessSolanaProductionReadiness({
        environment: "devnet",
        programId: validMainnetProgramId,
        rpcEndpoints: ["https://api.devnet.solana.com"],
        commitment: "confirmed",
      });

      expect(report.isProductionReady).toBe(true);
      expect(report.summary.failures).toBe(0);
      expect(report.blockers).toHaveLength(0);
    });

    it("should fail mainnet assessment if using public devnet RPC endpoint", () => {
      const report = assessSolanaProductionReadiness({
        environment: "mainnet-beta",
        programId: validMainnetProgramId,
        rpcEndpoints: ["https://api.devnet.solana.com"],
        commitment: "finalized",
        hasPriorityFeeStrategy: true,
      });

      expect(report.isProductionReady).toBe(false);
      const rpcCheck = report.checks.find((c) => c.id === "rpc_infrastructure");
      expect(rpcCheck?.status).toBe("failed");
      expect(report.blockers).toContain(
        "Mainnet requires dedicated private RPC endpoints with multi-endpoint failover."
      );
    });

    it("should warn on mainnet if only 1 RPC endpoint is configured", () => {
      const report = assessSolanaProductionReadiness({
        environment: "mainnet-beta",
        programId: validMainnetProgramId,
        rpcEndpoints: [validPrivateRpc],
        commitment: "finalized",
        hasPriorityFeeStrategy: true,
      });

      const rpcCheck = report.checks.find((c) => c.id === "rpc_infrastructure");
      expect(rpcCheck?.status).toBe("warning");
      expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
      expect(report.isProductionReady).toBe(true); // warnings don't block unless strictProductionMode is true
    });

    it("should fail under strictProductionMode when warnings exist", () => {
      const report = assessSolanaProductionReadiness({
        environment: "mainnet-beta",
        programId: validMainnetProgramId,
        rpcEndpoints: [validPrivateRpc], // single endpoint -> warning
        commitment: "confirmed", // confirmed commitment on mainnet -> warning
        hasPriorityFeeStrategy: true,
        strictProductionMode: true,
      });

      expect(report.isProductionReady).toBe(false);
    });

    it("should fail mainnet assessment without priority fees strategy", () => {
      const report = assessSolanaProductionReadiness({
        environment: "mainnet-beta",
        programId: validMainnetProgramId,
        rpcEndpoints: [validPrivateRpc, secondaryPrivateRpc],
        commitment: "finalized",
        hasPriorityFeeStrategy: false,
      });

      expect(report.isProductionReady).toBe(false);
      const feeCheck = report.checks.find((c) => c.id === "priority_fees");
      expect(feeCheck?.status).toBe("failed");
      expect(report.blockers).toContain(
        "Mainnet transactions require dynamic priority fee management to avoid dropped HTLC claims."
      );
    });

    it("should detect devnet mock token mints in mainnet configuration", () => {
      const devnetUsdc = Array.from(DEVNET_TOKEN_MINTS)[0];
      const report = assessSolanaProductionReadiness({
        environment: "mainnet-beta",
        programId: validMainnetProgramId,
        rpcEndpoints: [validPrivateRpc, secondaryPrivateRpc],
        commitment: "finalized",
        hasPriorityFeeStrategy: true,
        tokenMints: [devnetUsdc],
      });

      expect(report.isProductionReady).toBe(false);
      const tokenCheck = report.checks.find((c) => c.id === "token_mint_validation");
      expect(tokenCheck?.status).toBe("failed");
      expect(report.blockers.some((b) => b.includes("Devnet token mints detected"))).toBe(true);
    });

    it("should pass fully production-ready mainnet configuration", () => {
      const mainnetUsdc = Array.from(MAINNET_TOKEN_MINTS)[0];
      const report = assessSolanaProductionReadiness({
        environment: "mainnet-beta",
        programId: validMainnetProgramId,
        rpcEndpoints: [validPrivateRpc, secondaryPrivateRpc],
        commitment: "finalized",
        hasPriorityFeeStrategy: true,
        tokenMints: [mainnetUsdc],
      });

      expect(report.isProductionReady).toBe(true);
      expect(report.summary.failures).toBe(0);
      expect(report.summary.warnings).toBe(0);
      expect(report.blockers).toHaveLength(0);
    });
  });

  describe("assertSolanaProductionReady", () => {
    it("should throw SolanaProductionGatingError when configuration is not production ready", () => {
      expect(() =>
        assertSolanaProductionReady({
          environment: "mainnet-beta",
          programId: "PLACEHOLDER",
        })
      ).toThrow(SolanaProductionGatingError);
    });

    it("should include detailed report and blockers in thrown error", () => {
      try {
        assertSolanaProductionReady({
          environment: "mainnet-beta",
          programId: "PLACEHOLDER",
        });
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SolanaProductionGatingError);
        const gatingErr = err as SolanaProductionGatingError;
        expect(gatingErr.blockers.length).toBeGreaterThan(0);
        expect(gatingErr.report.environment).toBe("mainnet-beta");
      }
    });

    it("should not throw for a valid production configuration", () => {
      expect(() =>
        assertSolanaProductionReady({
          environment: "mainnet-beta",
          programId: validMainnetProgramId,
          rpcEndpoints: [validPrivateRpc, secondaryPrivateRpc],
          commitment: "finalized",
          hasPriorityFeeStrategy: true,
          tokenMints: [Array.from(MAINNET_TOKEN_MINTS)[0]],
        })
      ).not.toThrow();
    });
  });

  describe("SOLANA_SETTLEMENT_OPERATIONS_CHECKLIST", () => {
    it("should contain all required operational phases", () => {
      const phases = SOLANA_SETTLEMENT_OPERATIONS_CHECKLIST.map((p) => p.phase);
      expect(phases.some((p) => p.includes("Pre-Deployment"))).toBe(true);
      expect(phases.some((p) => p.includes("RPC Infrastructure"))).toBe(true);
      expect(phases.some((p) => p.includes("Token Mint"))).toBe(true);
      expect(phases.some((p) => p.includes("Settlement Execution"))).toBe(true);
      expect(phases.some((p) => p.includes("Incident Response"))).toBe(true);
    });

    it("should have critical items identified", () => {
      const allItems = SOLANA_SETTLEMENT_OPERATIONS_CHECKLIST.flatMap((p) => p.items);
      const criticalItems = allItems.filter((i) => i.criticality === "CRITICAL");
      expect(criticalItems.length).toBeGreaterThanOrEqual(4);
    });
  });
});
