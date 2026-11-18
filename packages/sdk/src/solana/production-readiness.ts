/**
 * Solana Production Readiness Audit, Gating Checks, and Operations Checklist.
 *
 * This module establishes explicit guardrails for transitioning from Solana devnet
 * assumptions to production/mainnet-beta readiness. It provides:
 * 1. An automated readiness assessment engine comparing devnet vs production requirements.
 * 2. Strict production gating checks that prevent unsafe mainnet executions.
 * 3. A structured operations checklist for Solana settlement flow.
 */

import { PublicKey } from "@solana/web3.js";

/** Set of known placeholder Solana program ID strings. */
const PLACEHOLDER_PROGRAM_IDS = new Set<string>([
  "PLACEHOLDER",
  "YOUR_SOLANA_HTLC_PROGRAM",
  "YOUR_PROGRAM_ID",
  "11111111111111111111111111111111",
  "",
]);

function isPlaceholderProgramId(id?: string): boolean {
  if (!id) return true;
  const trimmed = id.trim();
  return (
    trimmed === "" ||
    PLACEHOLDER_PROGRAM_IDS.has(trimmed) ||
    trimmed.toUpperCase().includes("PLACEHOLDER") ||
    trimmed.toUpperCase().includes("YOUR_")
  );
}

/** Recognized Solana cluster environments. */
export type SolanaEnvironment = "devnet" | "testnet" | "mainnet-beta" | "localnet";

/** Severity / status of a production readiness check. */
export type ReadinessCheckStatus =
  | "passed"
  | "warning"
  | "failed"
  | "manual_verification_required";

/** Category of the production readiness check. */
export type ReadinessCheckCategory =
  | "rpc"
  | "consensus"
  | "fees"
  | "tokens"
  | "wallets"
  | "contracts"
  | "operations";

/** A single production readiness check result. */
export interface SolanaReadinessCheck {
  id: string;
  category: ReadinessCheckCategory;
  title: string;
  devnetAssumption: string;
  mainnetRequirement: string;
  status: ReadinessCheckStatus;
  details: string;
  recommendation: string;
}

/** Comprehensive production readiness report. */
export interface SolanaProductionReadinessReport {
  environment: SolanaEnvironment;
  isProductionReady: boolean;
  timestamp: string;
  checks: SolanaReadinessCheck[];
  summary: {
    passed: number;
    warnings: number;
    failures: number;
    manualVerificationRequired: number;
  };
  blockers: string[];
}

/** Options for evaluating Solana production readiness. */
export interface SolanaReadinessOptions {
  /** Target cluster environment. Default is "devnet". */
  environment?: SolanaEnvironment;
  /** RPC endpoints configured for failover. */
  rpcEndpoints?: string[];
  /** Default commitment level used for confirmation. */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Whether a dynamic compute unit / priority fee strategy is active. */
  hasPriorityFeeStrategy?: boolean;
  /** Configured Solana HTLC Program ID. */
  programId?: string;
  /** Token mints intended for production settlement. */
  tokenMints?: string[];
  /** Whether strict production mode is enforced (fails on any devnet assumptions). */
  strictProductionMode?: boolean;
}

/** Known Devnet-only Token Mints (e.g. devnet USDC faucet). */
export const DEVNET_TOKEN_MINTS = new Set<string>([
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Devnet USDC
  "CpMah17kQEL2wqyMK2qUaLDPVLuGTVQmrZwPpBVZ6Jh2", // Devnet USDT
]);

/** Official Mainnet-Beta Token Mints. */
export const MAINNET_TOKEN_MINTS = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Mainnet USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // Mainnet USDT
  "So11111111111111111111111111111111111111112", // Wrapped SOL
]);

/** Public Devnet RPC Endpoints that should NOT be used in production. */
export const PUBLIC_DEVNET_RPC_ENDPOINTS = [
  "https://api.devnet.solana.com",
  "https://devnet.solana.com",
];

/** Error thrown when Solana production gating checks fail. */
export class SolanaProductionGatingError extends Error {
  public readonly blockers: string[];
  public readonly report: SolanaProductionReadinessReport;

  constructor(message: string, blockers: string[], report: SolanaProductionReadinessReport) {
    super(message);
    this.name = "SolanaProductionGatingError";
    this.blockers = blockers;
    this.report = report;
  }
}

/**
 * Assesses Solana deployment assumptions against production requirements.
 *
 * @param options - Configuration and environment options to audit.
 * @returns Detailed readiness report with status, blockers, and recommendations.
 */
export function assessSolanaProductionReadiness(
  options: SolanaReadinessOptions = {}
): SolanaProductionReadinessReport {
  const env = options.environment ?? "devnet";
  const rpcEndpoints = options.rpcEndpoints ?? [];
  const commitment = options.commitment ?? "confirmed";
  const hasPriorityFees = options.hasPriorityFeeStrategy ?? false;
  const programId = options.programId;
  const tokenMints = options.tokenMints ?? [];
  const isMainnet = env === "mainnet-beta";

  const checks: SolanaReadinessCheck[] = [];
  const blockers: string[] = [];

  // Check 1: Program ID Configuration & Placeholder Check
  if (!programId || isPlaceholderProgramId(programId)) {
    checks.push({
      id: "program_id_configured",
      category: "contracts",
      title: "Solana HTLC Program ID Configuration",
      devnetAssumption: "Permits placeholder program IDs (e.g. YOUR_SOLANA_HTLC_PROGRAM).",
      mainnetRequirement: "Must be a valid, deployed, and audited Solana Anchor program base58 public key.",
      status: "failed",
      details: `Program ID is missing or set to a placeholder: "${programId ?? ""}".`,
      recommendation: "Deploy the Solana HTLC Anchor program to the target cluster and set SOLANA_HTLC_PROGRAM.",
    });
    blockers.push("Solana HTLC Program ID is not configured or is a placeholder.");
  } else {
    let isValidPk = false;
    try {
      new PublicKey(programId);
      isValidPk = true;
    } catch {
      isValidPk = false;
    }

    if (!isValidPk) {
      checks.push({
        id: "program_id_configured",
        category: "contracts",
        title: "Solana HTLC Program ID Configuration",
        devnetAssumption: "Permissive string check.",
        mainnetRequirement: "Must be a valid 32-byte Ed25519 base58 public key.",
        status: "failed",
        details: `Program ID "${programId}" is not a valid Solana public key.`,
        recommendation: "Verify and set a valid Solana public key for the HTLC program.",
      });
      blockers.push("Solana HTLC Program ID is malformed.");
    } else {
      checks.push({
        id: "program_id_configured",
        category: "contracts",
        title: "Solana HTLC Program ID Configuration",
        devnetAssumption: "Permits placeholder program IDs.",
        mainnetRequirement: "Must be a valid, deployed, and audited Solana Anchor program base58 public key.",
        status: "passed",
        details: `Configured program ID: ${programId}`,
        recommendation: "Ensure the deployed bytecode is verified against repo builds using anchor build --verifiable.",
      });
    }
  }

  // Check 2: RPC Infrastructure & Multi-Endpoint Failover
  const hasPublicDevnetRpc = rpcEndpoints.some((url) =>
    PUBLIC_DEVNET_RPC_ENDPOINTS.some((pub) => url.toLowerCase().includes(pub.toLowerCase()))
  );
  if (isMainnet && (rpcEndpoints.length === 0 || hasPublicDevnetRpc)) {
    checks.push({
      id: "rpc_infrastructure",
      category: "rpc",
      title: "RPC Node Topology & Failover Strategy",
      devnetAssumption: "Single public devnet RPC (https://api.devnet.solana.com) subject to rate limits and downtime.",
      mainnetRequirement: "Dedicated private RPC nodes (e.g. Helius, Triton, QuickNode) with multi-endpoint fallback pool.",
      status: "failed",
      details: hasPublicDevnetRpc
        ? "Public devnet RPC endpoint configured in mainnet-beta environment."
        : "No RPC endpoints configured.",
      recommendation: "Configure at least 2 independent private RPC providers via SolanaRpcProvider.",
    });
    blockers.push("Mainnet requires dedicated private RPC endpoints with multi-endpoint failover.");
  } else if (rpcEndpoints.length <= 1 && isMainnet) {
    checks.push({
      id: "rpc_infrastructure",
      category: "rpc",
      title: "RPC Node Topology & Failover Strategy",
      devnetAssumption: "Single RPC endpoint without automated failover.",
      mainnetRequirement: "At least 2 distinct RPC endpoints configured for automated health check and failover.",
      status: "warning",
      details: "Only 1 RPC endpoint configured for mainnet.",
      recommendation: "Add secondary and tertiary RPC endpoints to prevent single-point-of-failure outages.",
    });
  } else {
    checks.push({
      id: "rpc_infrastructure",
      category: "rpc",
      title: "RPC Node Topology & Failover Strategy",
      devnetAssumption: "Single public devnet endpoint.",
      mainnetRequirement: "Multi-endpoint failover topology.",
      status: "passed",
      details: `${rpcEndpoints.length} RPC endpoint(s) configured.`,
      recommendation: "Monitor RPC latency and error rate metrics continuously.",
    });
  }

  // Check 3: Transaction Finality & Commitment Level
  if (isMainnet && commitment !== "finalized") {
    checks.push({
      id: "commitment_finality",
      category: "consensus",
      title: "Settlement Finality Commitment Level",
      devnetAssumption: "'confirmed' commitment (~400-800ms) with negligible fork probability in devnet.",
      mainnetRequirement: "'finalized' commitment (32+ slots, ~13s) for irreversible financial settlement, or reorg tracking on confirmed.",
      status: "warning",
      details: `Current commitment level is "${commitment}". Financial cross-chain atomic swaps may experience cluster rollbacks before 32 slots.`,
      recommendation: "Use 'finalized' commitment for release of cross-chain assets or enforce confirmation depth checks.",
    });
  } else {
    checks.push({
      id: "commitment_finality",
      category: "consensus",
      title: "Settlement Finality Commitment Level",
      devnetAssumption: "'confirmed' commitment.",
      mainnetRequirement: "'finalized' commitment for financial settlement.",
      status: "passed",
      details: `Configured commitment: ${commitment}`,
      recommendation: "Ensure cross-chain timelocks have sufficient safety buffers (>15 minutes) beyond confirmation latency.",
    });
  }

  // Check 4: Priority Fees & Compute Budget Management
  if (isMainnet && !hasPriorityFees) {
    checks.push({
      id: "priority_fees",
      category: "fees",
      title: "Dynamic Priority Fees & Compute Budget",
      devnetAssumption: "Zero priority fee transactions land reliably on devnet without congestion.",
      mainnetRequirement: "Dynamic ComputeBudgetProgram.setComputeUnitPrice (micro-lamports per CU) to land transactions during network spikes.",
      status: "failed",
      details: "No dynamic priority fee strategy is enabled for mainnet.",
      recommendation: "Implement dynamic priority fees via Helius/Triton getPriorityFeeEstimate or fallback tiered fees.",
    });
    blockers.push("Mainnet transactions require dynamic priority fee management to avoid dropped HTLC claims.");
  } else {
    checks.push({
      id: "priority_fees",
      category: "fees",
      title: "Dynamic Priority Fees & Compute Budget",
      devnetAssumption: "0 priority fees.",
      mainnetRequirement: "Dynamic compute budget instructions.",
      status: "passed",
      details: hasPriorityFees ? "Dynamic priority fee strategy is enabled." : "Devnet standard fee model.",
      recommendation: "Set sensible upper limits on max priority fee per transaction to avoid draining operator balances.",
    });
  }

  // Check 5: Token Mint Validation & Associated Token Accounts
  const devnetMintsFound = tokenMints.filter((m) => DEVNET_TOKEN_MINTS.has(m));
  if (isMainnet && devnetMintsFound.length > 0) {
    checks.push({
      id: "token_mint_validation",
      category: "tokens",
      title: "Token Mint & Associated Token Account (ATA) Validation",
      devnetAssumption: "Devnet mock USDC mint (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU).",
      mainnetRequirement: "Official Mainnet USDC mint (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) with strict decimal precision (6 decimals).",
      status: "failed",
      details: `Found devnet mock token mints configured for mainnet: ${devnetMintsFound.join(", ")}`,
      recommendation: "Replace all devnet token mint addresses with official mainnet SPL token mints.",
    });
    blockers.push(`Devnet token mints detected in mainnet configuration: ${devnetMintsFound.join(", ")}`);
  } else {
    checks.push({
      id: "token_mint_validation",
      category: "tokens",
      title: "Token Mint & Associated Token Account (ATA) Validation",
      devnetAssumption: "Mock token mints.",
      mainnetRequirement: "Verified SPL token mints and idempotent ATA creation.",
      status: "passed",
      details: `${tokenMints.length} token mint(s) checked.`,
      recommendation: "Ensure claiming transactions idempotently create beneficiary ATA if it does not yet exist.",
    });
  }

  // Check 6: Wallet Integration & Cluster Safety Guards
  checks.push({
    id: "wallet_cluster_guard",
    category: "wallets",
    title: "Wallet Cluster Mismatch Detection",
    devnetAssumption: "Developer manually selects Devnet in Phantom/Backpack/Solflare.",
    mainnetRequirement: "App verifies wallet provider cluster or genesis hash to reject transactions if user wallet is on wrong network.",
    status: isMainnet ? "manual_verification_required" : "passed",
    details: "Cluster verification prevents accidental cross-chain lock creation on mismatched networks.",
    recommendation: "Verify client dApp checks window.solana cluster or signs against expected genesis hash.",
  });

  // Check 7: Rent-Exemption & Storage Rent Balances
  checks.push({
    id: "rent_exemption",
    category: "operations",
    title: "Rent-Exempt Order PDA & Account Minimums",
    devnetAssumption: "Air-dropped devnet SOL covers all account creation rent fees.",
    mainnetRequirement: "Operator wallets maintain minimum SOL reserves for HTLC Order PDAs (~0.0025 SOL) and ATAs (~0.00204 SOL).",
    status: isMainnet ? "manual_verification_required" : "passed",
    details: "HTLC order accounts must be rent-exempt; closing the order upon claim/refund returns lamports to the payer.",
    recommendation: "Ensure operator automated wallets are alerted when SOL balance drops below 0.5 SOL.",
  });

  const passed = checks.filter((c) => c.status === "passed").length;
  const warnings = checks.filter((c) => c.status === "warning").length;
  const failures = checks.filter((c) => c.status === "failed").length;
  const manualVerificationRequired = checks.filter(
    (c) => c.status === "manual_verification_required"
  ).length;

  const isProductionReady = failures === 0 && (options.strictProductionMode ? warnings === 0 : true);

  return {
    environment: env,
    isProductionReady,
    timestamp: new Date().toISOString(),
    checks,
    summary: {
      passed,
      warnings,
      failures,
      manualVerificationRequired,
    },
    blockers,
  };
}

/**
 * Asserts that the Solana environment and configuration are production ready.
 * Throws a `SolanaProductionGatingError` if any blocking checks fail.
 *
 * @param options - Configuration options to check.
 * @throws {SolanaProductionGatingError} if not production ready.
 */
export function assertSolanaProductionReady(options: SolanaReadinessOptions = {}): void {
  const report = assessSolanaProductionReadiness(options);
  if (!report.isProductionReady) {
    throw new SolanaProductionGatingError(
      `Solana production readiness gating failed with ${report.summary.failures} blocker(s):\n- ${report.blockers.join(
        "\n- "
      )}`,
      report.blockers,
      report
    );
  }
}

/**
 * Standard Operational Checklist for Solana HTLC Cross-Chain Settlement.
 * Useful for DevOps, node operators, and auditors before opening mainnet traffic.
 */
export const SOLANA_SETTLEMENT_OPERATIONS_CHECKLIST = [
  {
    phase: "1. Pre-Deployment & Key Management",
    items: [
      {
        id: "OP-SOL-01",
        description: "Solana HTLC Anchor program compiled with anchor build --verifiable and verified on-chain via solana-verify.",
        criticality: "CRITICAL",
      },
      {
        id: "OP-SOL-02",
        description: "Program upgrade authority transferred to a multi-sig (e.g. Squads Protocol) or locked for immutable deployment.",
        criticality: "CRITICAL",
      },
      {
        id: "OP-SOL-03",
        description: "Relayer / Operator hot wallet private keys stored in secure secret manager (AWS KMS, HashiCorp Vault) and never committed to code.",
        criticality: "CRITICAL",
      },
    ],
  },
  {
    phase: "2. RPC Infrastructure & Failover",
    items: [
      {
        id: "OP-SOL-04",
        description: "Primary and secondary private RPC providers configured with fallback circuit breakers enabled.",
        criticality: "HIGH",
      },
      {
        id: "OP-SOL-05",
        description: "Websocket subscription endpoints (wss://) tested for real-time account and slot change notifications.",
        criticality: "HIGH",
      },
      {
        id: "OP-SOL-06",
        description: "RPC latency monitoring and error rate alerting thresholds configured in Prometheus/Datadog.",
        criticality: "MEDIUM",
      },
    ],
  },
  {
    phase: "3. Token Mint & ATA Lifecycle",
    items: [
      {
        id: "OP-SOL-07",
        description: "Official SPL Token mint addresses validated against Mainnet token lists (e.g. USDC EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).",
        criticality: "CRITICAL",
      },
      {
        id: "OP-SOL-08",
        description: "Idempotent ATA creation instruction (createAssociatedTokenAccountIdempotent) included in claim flows to prevent missing ATA reverts.",
        criticality: "HIGH",
      },
      {
        id: "OP-SOL-09",
        description: "Vault and operator SOL balance minimums configured with low-balance alerts (>0.5 SOL).",
        criticality: "HIGH",
      },
    ],
  },
  {
    phase: "4. Settlement Execution & Confirmation",
    items: [
      {
        id: "OP-SOL-10",
        description: "Dynamic priority fee pricing strategy (micro-lamports per CU) configured to prevent dropped transactions during high cluster load.",
        criticality: "CRITICAL",
      },
      {
        id: "OP-SOL-11",
        description: "Cross-chain counterparty settlement strictly waits for 'finalized' commitment (or 32+ confirmed slots) before releasing peer chain assets.",
        criticality: "CRITICAL",
      },
      {
        id: "OP-SOL-12",
        description: "Timelock durations on Solana orders configured with minimum 15-minute buffer relative to counterparty chain timelocks.",
        criticality: "HIGH",
      },
    ],
  },
  {
    phase: "5. Incident Response & Emergency Operations",
    items: [
      {
        id: "OP-SOL-13",
        description: "Automated refund monitoring cron active to reclaim expired HTLCs after timelock expiry.",
        criticality: "HIGH",
      },
      {
        id: "OP-SOL-14",
        description: "Runbook established for handling Solana cluster halts or severe congestion degradation.",
        criticality: "MEDIUM",
      },
    ],
  },
] as const;
