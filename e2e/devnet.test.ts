/**
 * Live-devnet integration tests for the three HTLC implementations.
 *
 * Each describe block is skipped automatically when the required environment
 * variables are absent — no special flags or test profiles needed.  To run a
 * single chain against its real devnet, export the corresponding variables
 * and invoke `pnpm test` from the e2e package.
 *
 * Required env vars per chain:
 *
 *   EVM (Sepolia):
 *     DEVNET_EVM_RPC_URL          — HTTP RPC endpoint (defaults to publicnode Sepolia)
 *     DEVNET_EVM_PRIVATE_KEY      — hex-encoded 32-byte signer key (REQUIRED)
 *     DEVNET_EVM_CONTRACT_ADDRESS — HTLCEscrow address  (defaults to testnet deployment)
 *     DEVNET_EVM_BENEFICIARY      — claim recipient     (defaults to signer)
 *     DEVNET_EVM_TOKEN            — ERC-20 or 0x000... for native ETH (defaults to ETH)
 *     DEVNET_EVM_AMOUNT           — wei per order       (defaults to 0.001 ETH)
 *
 *   Soroban (Stellar testnet):
 *     DEVNET_STELLAR_RPC_URL      — Soroban RPC URL     (defaults to soroban-testnet.stellar.org)
 *     DEVNET_STELLAR_SECRET_KEY   — Stellar secret key  (REQUIRED)
 *     DEVNET_STELLAR_CONTRACT_ID  — HTLC contract ID    (defaults to testnet deployment)
 *     DEVNET_STELLAR_PASSPHRASE   — network passphrase  (defaults to Stellar testnet)
 *     DEVNET_STELLAR_TOKEN        — asset contract ID   (optional, uses native XLM if absent)
 *
 *   Solana (devnet):
 *     DEVNET_SOLANA_RPC_URL       — cluster URL         (defaults to api.devnet.solana.com)
 *     DEVNET_SOLANA_SECRET_KEY    — base-58 keypair secret (REQUIRED)
 *     DEVNET_SOLANA_PROGRAM_ID    — Anchor program ID   (REQUIRED)
 *     DEVNET_SOLANA_AMOUNT        — lamports per order  (defaults to 1_000_000)
 */

import { describe, expect, it } from "vitest";
import { generateSecret }        from "@wafflefinance/sdk/secrets";
import {
  EvmHtlcDevnet,
  SorobanHtlcDevnet,
  SolanaHtlcDevnet,
  type EvmDevnetConfig,
  type SorobanDevnetConfig,
  type SolanaDevnetConfig,
} from "./devnet-sim.js";
import type { AsyncHtlcSim, Hex } from "./sim.js";

// ── Default testnet addresses from deployments.testnet.json ───────────────────

const SEPOLIA_RPC_DEFAULT    = "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_HTLC_DEFAULT   = "0xb352339BEb146f2699d28D736700B953988bB178";
const SOROBAN_RPC_DEFAULT    = "https://soroban-testnet.stellar.org";
const SOROBAN_HTLC_DEFAULT   = "CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK";
const SOROBAN_PASSPHRASE_DEFAULT = "Test SDF Network ; September 2015";
const SOLANA_RPC_DEFAULT     = "https://api.devnet.solana.com";

// ── Config resolution from environment variables ──────────────────────────────

function evmConfig(): EvmDevnetConfig | null {
  const privateKey = process.env.DEVNET_EVM_PRIVATE_KEY;
  if (!privateKey) return null;
  return {
    rpcUrl:          process.env.DEVNET_EVM_RPC_URL          ?? SEPOLIA_RPC_DEFAULT,
    privateKey:      privateKey as Hex,
    contractAddress: (process.env.DEVNET_EVM_CONTRACT_ADDRESS ?? SEPOLIA_HTLC_DEFAULT) as Hex,
    beneficiary:     process.env.DEVNET_EVM_BENEFICIARY as Hex | undefined,
    token:           process.env.DEVNET_EVM_TOKEN as Hex | undefined,
    amount:          process.env.DEVNET_EVM_AMOUNT
      ? BigInt(process.env.DEVNET_EVM_AMOUNT)
      : undefined,
  };
}

function sorobanConfig(): SorobanDevnetConfig | null {
  const secretKey = process.env.DEVNET_STELLAR_SECRET_KEY;
  if (!secretKey) return null;
  return {
    rpcUrl:            process.env.DEVNET_STELLAR_RPC_URL        ?? SOROBAN_RPC_DEFAULT,
    networkPassphrase: process.env.DEVNET_STELLAR_PASSPHRASE     ?? SOROBAN_PASSPHRASE_DEFAULT,
    secretKey,
    contractId:        process.env.DEVNET_STELLAR_CONTRACT_ID    ?? SOROBAN_HTLC_DEFAULT,
    tokenContractId:   process.env.DEVNET_STELLAR_TOKEN,
  };
}

function solanaConfig(): SolanaDevnetConfig | null {
  const secretKey  = process.env.DEVNET_SOLANA_SECRET_KEY;
  const programId  = process.env.DEVNET_SOLANA_PROGRAM_ID;
  if (!secretKey || !programId) return null;
  return {
    rpcUrl:    process.env.DEVNET_SOLANA_RPC_URL ?? SOLANA_RPC_DEFAULT,
    secretKey,
    programId,
    amount:    process.env.DEVNET_SOLANA_AMOUNT
      ? BigInt(process.env.DEVNET_SOLANA_AMOUNT)
      : undefined,
  };
}

// ── Shared devnet scenarios (chain-agnostic) ──────────────────────────────────
//
// These run against a real network so they use longer timeouts and explicit
// awaits, unlike the synchronous in-process simulator tests.

const TIMELOCK_SECONDS = 600; // 10 minutes — shortest the contracts allow

function devnetScenarios(name: string, factory: () => AsyncHtlcSim) {
  describe(`${name} — devnet`, () => {
    it(
      "creates an order and reads it back as Funded",
      async () => {
        const chain  = factory();
        const secret = generateSecret();
        const id     = await chain.createOrder({
          hashlock:        secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });
        const order = await chain.getOrder(id);
        expect(order.id).toBe(id);
        expect(order.status).toBe("Funded");
        expect(order.hashlock.toLowerCase()).toBe(secret.sha256.toLowerCase());
        expect(order.finalisedAt).toBe(0);
      },
      60_000,
    );

    it(
      "claims a funded order with the correct preimage",
      async () => {
        const chain  = factory();
        const secret = generateSecret();
        const id     = await chain.createOrder({
          hashlock:        secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });

        await chain.claimOrder(id, secret.preimage);

        const order = await chain.getOrder(id);
        expect(order.status).toBe("Claimed");
        expect(order.finalisedAt).toBeGreaterThan(0);
      },
      90_000,
    );

    it(
      "rejects a claim with the wrong preimage",
      async () => {
        const chain  = factory();
        const secret = generateSecret();
        const wrong  = generateSecret();
        const id     = await chain.createOrder({
          hashlock:        secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });

        await expect(chain.claimOrder(id, wrong.preimage)).rejects.toThrow();

        const order = await chain.getOrder(id);
        expect(order.status).toBe("Funded");
      },
      90_000,
    );

    it(
      "rejects a double-claim against an already-claimed order",
      async () => {
        const chain  = factory();
        const secret = generateSecret();
        const id     = await chain.createOrder({
          hashlock:        secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });

        await chain.claimOrder(id, secret.preimage);
        await expect(chain.claimOrder(id, secret.preimage)).rejects.toThrow();
      },
      120_000,
    );

    it(
      "order createdAt is a recent unix timestamp",
      async () => {
        const chain    = factory();
        const secret   = generateSecret();
        const beforeTs = Math.floor(Date.now() / 1000) - 60;
        const id       = await chain.createOrder({
          hashlock:        secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });
        const order = await chain.getOrder(id);
        expect(order.createdAt).toBeGreaterThan(beforeTs);
      },
      60_000,
    );

    it(
      "timelockAbsolute is approximately now + timelockSeconds",
      async () => {
        const chain  = factory();
        const secret = generateSecret();
        const before = Math.floor(Date.now() / 1000);
        const id     = await chain.createOrder({
          hashlock:        secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });
        const order = await chain.getOrder(id);
        const expectedDeadline = before + TIMELOCK_SECONDS;
        // Allow ±120 s for block timestamp drift and confirmation latency.
        expect(order.timelockAbsolute).toBeGreaterThan(expectedDeadline - 120);
        expect(order.timelockAbsolute).toBeLessThan(expectedDeadline + 120);
      },
      60_000,
    );

    it("advanceTime is a no-op (does not throw)", () => {
      const chain = factory();
      expect(() => chain.advanceTime(300)).not.toThrow();
    });
  });
}

// ── Devnet opt-in flag and preflight report (issue #969) ──────────────────────
//
// Devnet tests are opt-in: they only run when RUN_DEVNET_E2E === "true".
// When the flag is set but no chain has its prerequisites, the suite fails
// fast with a missing-prerequisite message that names ONLY variable names and
// safe network identifiers — never secret values, RPC tokens, or keys.

const DEVNET_ENABLED = process.env.RUN_DEVNET_E2E === "true";

// Required-variable names per chain (names only — never log values).
const EVM_REQUIRED_VARS = ["DEVNET_EVM_PRIVATE_KEY"] as const;
const STELLAR_REQUIRED_VARS = ["DEVNET_STELLAR_SECRET_KEY"] as const;
const SOLANA_REQUIRED_VARS = ["DEVNET_SOLANA_SECRET_KEY", "DEVNET_SOLANA_PROGRAM_ID"] as const;

// Safe, non-sensitive network identifiers for failure messages.
const SAFE_NETWORKS = {
  evm:     "EVM Sepolia (rpc default: ethereum-sepolia-rpc.publicnode.com)",
  stellar: "Stellar testnet (rpc default: soroban-testnet.stellar.org)",
  solana:  "Solana devnet (rpc default: api.devnet.solana.com)",
} as const;

function missingVars(names: readonly string[]): string[] {
  return names.filter((n) => !process.env[n]);
}

export function devnetPreflightReport(): { enabled: boolean; missing: string[] } {
  if (!DEVNET_ENABLED) return { enabled: false, missing: [] };
  const missing: string[] = [];
  if (!EVM_CFG) for (const n of missingVars(EVM_REQUIRED_VARS)) missing.push(`EVM Sepolia: ${n}`);
  if (!SOROBAN_CFG) for (const n of missingVars(STELLAR_REQUIRED_VARS)) missing.push(`Stellar testnet: ${n}`);
  if (!SOLANA_CFG) for (const n of missingVars(SOLANA_REQUIRED_VARS)) missing.push(`Solana devnet: ${n}`);
  return { enabled: true, missing };
}

describe("devnet preflight", () => {
  it("stays skipped unless RUN_DEVNET_E2E=true", () => {
    if (!DEVNET_ENABLED) return; // opt-in flag absent → devnet suites skip below
    const { missing } = devnetPreflightReport();
    if (missing.length > 0) {
      throw new Error(
        `Devnet preflight failed: RUN_DEVNET_E2E is enabled but prerequisites are missing.\n` +
        `Missing: ${missing.join(", ")}\n` +
        `Networks: ${SAFE_NETWORKS.evm} | ${SAFE_NETWORKS.stellar} | ${SAFE_NETWORKS.solana}\n` +
        `See e2e/DEVNET_SETUP.md for the exact variables to export. ` +
        `(Values are never printed here.)`,
      );
    }
  });
});

const EVM_CFG = evmConfig();
describe.skipIf(!DEVNET_ENABLED || !EVM_CFG)("EvmHtlcDevnet", () => {
  devnetScenarios("EVM Sepolia", () => new EvmHtlcDevnet(EVM_CFG!));

  it(
    "second createOrder produces a strictly larger order ID",
    async () => {
      const chain  = new EvmHtlcDevnet(EVM_CFG!);
      const secret = generateSecret();
      const id1    = await chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const id2    = await chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      expect(id2).toBeGreaterThan(id1);
    },
    120_000,
  );
});

// ── Soroban (Stellar testnet) ─────────────────────────────────────────────────

const SOROBAN_CFG = sorobanConfig();
describe.skipIf(!DEVNET_ENABLED || !SOROBAN_CFG)("SorobanHtlcDevnet", () => {
  devnetScenarios("Soroban testnet", () => new SorobanHtlcDevnet(SOROBAN_CFG!));

  it(
    "sha256 hashlock satisfies the Soroban contract (sha256-only check)",
    async () => {
      const chain  = new SorobanHtlcDevnet(SOROBAN_CFG!);
      const secret = generateSecret();
      const id     = await chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      await expect(chain.claimOrder(id, secret.preimage)).resolves.not.toThrow();
      expect((await chain.getOrder(id)).status).toBe("Claimed");
    },
    90_000,
  );
});

// ── Solana (devnet) ───────────────────────────────────────────────────────────

const SOLANA_CFG = solanaConfig();
describe.skipIf(!DEVNET_ENABLED || !SOLANA_CFG)("SolanaHtlcDevnet", () => {
  devnetScenarios("Solana devnet", () => new SolanaHtlcDevnet(SOLANA_CFG!));

  it(
    "sha256 hashlock satisfies the Solana program (sha256-only check)",
    async () => {
      const chain  = new SolanaHtlcDevnet(SOLANA_CFG!);
      const secret = generateSecret();
      const id     = await chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      await expect(chain.claimOrder(id, secret.preimage)).resolves.not.toThrow();
      expect((await chain.getOrder(id)).status).toBe("Claimed");
    },
    90_000,
  );
});

// ── Cross-chain devnet round-trip (EVM ↔ Soroban) ────────────────────────────

describe.skipIf(!DEVNET_ENABLED || !EVM_CFG || !SOROBAN_CFG)(
  "Cross-chain devnet round-trip — EVM ↔ Soroban",
  () => {
    it(
      "one sha256 hashlock unlocks both Sepolia and Stellar testnet with the same preimage",
      async () => {
        const evm     = new EvmHtlcDevnet(EVM_CFG!);
        const soroban = new SorobanHtlcDevnet(SOROBAN_CFG!);
        const secret  = generateSecret();

        const evmId     = await evm.createOrder({     hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
        const sorobanId = await soroban.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

        await evm.claimOrder(evmId, secret.preimage);
        await soroban.claimOrder(sorobanId, secret.preimage);

        expect((await evm.getOrder(evmId)).status).toBe("Claimed");
        expect((await soroban.getOrder(sorobanId)).status).toBe("Claimed");
      },
      180_000,
    );
  },
);

// ── Cross-chain devnet round-trip (EVM ↔ Solana) ─────────────────────────────

describe.skipIf(!DEVNET_ENABLED || !EVM_CFG || !SOLANA_CFG)(
  "Cross-chain devnet round-trip — EVM ↔ Solana",
  () => {
    it(
      "sha256 hashlock satisfies both Sepolia HTLCEscrow and Solana HTLC program",
      async () => {
        const evm    = new EvmHtlcDevnet(EVM_CFG!);
        const solana = new SolanaHtlcDevnet(SOLANA_CFG!);
        const secret = generateSecret();

        const evmId    = await evm.createOrder({    hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
        const solanaId = await solana.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

        await evm.claimOrder(evmId, secret.preimage);
        await solana.claimOrder(solanaId, secret.preimage);

        expect((await evm.getOrder(evmId)).status).toBe("Claimed");
        expect((await solana.getOrder(solanaId)).status).toBe("Claimed");
      },
      180_000,
    );
  },
);
