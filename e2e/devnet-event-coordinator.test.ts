/**
 * Opt-in live devnet event-to-coordinator integration suite (#1124).
 *
 * Set RUN_DEVNET_E2E=true plus the env vars below to enable the transaction
 * test. It is skipped by default, so the normal unit-test command stays
 * deterministic. The chain-safety checks always run and never make a network
 * call.
 *
 * Required for the live case:
 *   DEVNET_COORDINATOR_URL       coordinator base URL (e.g. http://localhost:3001)
 *   DEVNET_EVM_PRIVATE_KEY       funded Sepolia signer
 *   DEVNET_TEST_DST_ADDRESS      valid Stellar address for the announced leg
 * Optional:
 *   DEVNET_EVM_RPC_URL           Sepolia RPC (default: publicnode)
 *   DEVNET_EVM_CONTRACT_ADDRESS  HTLCEscrow deployment
 *   DEVNET_EVM_CHAIN_ID          must be 11155111
 *   DEVNET_COORDINATOR_API_KEY   bearer token for announce requests
 */

import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { generateSecret } from "@wafflefinance/sdk/secrets";
import {
  assertDevnetRpcAllowed,
  buildDevnetAnnouncePayload,
  devnetCleanupRecord,
  DEVNET_FINALITY_CONFIRMATIONS,
} from "./devnet-coordinator-support.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DEFAULT_CONTRACT = "0xb352339BEb146f2699d28D736700B953988bB178" as const;
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

const MINIMAL_HTLC_ABI = [
  {
    name: "createOrder",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "beneficiary", type: "address" },
      { name: "refundAddress", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "safetyDeposit", type: "uint256" },
      { name: "hashlock", type: "bytes32" },
      { name: "timelockSeconds", type: "uint64" },
    ],
    outputs: [{ name: "orderId", type: "uint256" }],
  },
  {
    name: "OrderCreated",
    type: "event",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "beneficiary", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "safetyDeposit", type: "uint256", indexed: false },
      { name: "hashlock", type: "bytes32", indexed: false },
      { name: "timelock", type: "uint64", indexed: false },
    ],
  },
] as const;

describe("devnet chain-id safety (no network calls)", () => {
  it("rejects mainnet RPC URLs and chain ids", () => {
    expect(() =>
      assertDevnetRpcAllowed("https://eth-mainnet.g.alchemy.com/v2/key", 1),
    ).toThrow(/mainnet/);
    expect(() =>
      assertDevnetRpcAllowed("https://rpc.ankr.com/eth", 1),
    ).toThrow(/mainnet/);
    expect(() =>
      assertDevnetRpcAllowed("https://eth-mainnet.g.alchemy.com/v2/key", 11_155_111),
    ).toThrow(/mainnet/);
  });

  it("rejects non-testnet chain ids even on a testnet-looking URL", () => {
    expect(() => assertDevnetRpcAllowed(DEFAULT_RPC, 10)).toThrow(/unsupported devnet chain id/);
  });

  it("accepts explicit Sepolia configuration", () => {
    expect(() => assertDevnetRpcAllowed(DEFAULT_RPC, 11_155_111)).not.toThrow();
  });

  it("records cleanup and provider-failure behavior", () => {
    const record = devnetCleanupRecord({
      txHash: "0x" + "ab".repeat(32),
      orderId: "wf_0x" + "cd".repeat(32),
      providerFailure: true,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    expect(record).toMatchObject({
      action: "refund_after_timelock",
      providerFailure: true,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    expect(record.txHash).not.toBe(record.orderId);
  });
});

const liveEnabled =
  process.env.RUN_DEVNET_E2E === "true" &&
  Boolean(process.env.DEVNET_COORDINATOR_URL) &&
  Boolean(process.env.DEVNET_EVM_PRIVATE_KEY) &&
  Boolean(process.env.DEVNET_TEST_DST_ADDRESS);

describe.skipIf(!liveEnabled)("devnet event → coordinator ingestion (#1124)", () => {
  it(
    "announces an order, submits a real tx, and observes the normalized coordinator state after finality",
    async () => {
      const coordinatorUrl = process.env.DEVNET_COORDINATOR_URL!.replace(/\/$/, "");
      const rpcUrl = process.env.DEVNET_EVM_RPC_URL ?? DEFAULT_RPC;
      const chainId = Number(process.env.DEVNET_EVM_CHAIN_ID ?? "11155111");
      const contract = (process.env.DEVNET_EVM_CONTRACT_ADDRESS ?? DEFAULT_CONTRACT) as Address;

      // Guard runs before any transaction is submitted.
      assertDevnetRpcAllowed(rpcUrl, chainId);

      const account = privateKeyToAccount(process.env.DEVNET_EVM_PRIVATE_KEY as Hex);
      const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
      const walletClient = createWalletClient({
        account,
        chain: sepolia,
        transport: http(rpcUrl),
      });

      const secret = generateSecret();
      const announce = buildDevnetAnnouncePayload({
        hashlock: secret.sha256,
        signerAddress: account.address,
        destinationAddress: process.env.DEVNET_TEST_DST_ADDRESS!,
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (process.env.DEVNET_COORDINATOR_API_KEY) {
        headers.authorization = `Bearer ${process.env.DEVNET_COORDINATOR_API_KEY}`;
      }

      const announceResponse = await fetch(`${coordinatorUrl}/api/orders/announce`, {
        method: "POST",
        headers,
        body: JSON.stringify(announce),
        signal: AbortSignal.timeout(30_000),
      });
      if (!announceResponse.ok) {
        throw new Error(`announce failed: ${announceResponse.status} ${await announceResponse.text()}`);
      }
      const announced = (await announceResponse.json()) as { id: string };
      expect(announced.id).toMatch(/^wf_0x[0-9a-f]{64}$/);

      let txHash: Hex | undefined;
      let chainOrderId: string | undefined;
      try {
        txHash = await walletClient.writeContract({
          address: contract,
          abi: MINIMAL_HTLC_ABI,
          functionName: "createOrder",
          args: [
            account.address,
            account.address,
            ZERO_ADDRESS,
            1_000_000_000_000_000n,
            0n,
            secret.sha256,
            600n,
          ],
          value: 1_000_000_000_000_000n,
        });

        // Explicit finality wait: the coordinator's 12-confirmation queue must
        // be past the transaction before it can ingest the event.
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: DEVNET_FINALITY_CONFIRMATIONS,
          timeout: 180_000,
        });
        expect(receipt.status).toBe("success");

        const created = parseEventLogs({
          abi: MINIMAL_HTLC_ABI,
          logs: receipt.logs,
          eventName: "OrderCreated",
        })[0];
        expect(created).toBeDefined();
        chainOrderId = (created!.args as { orderId: bigint }).orderId.toString();
        expect(((created!.args as { hashlock: Hex }).hashlock).toLowerCase()).toBe(secret.sha256);

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let observed: Record<string, any> | undefined;
        while (Date.now() < deadline) {
          const response = await fetch(`${coordinatorUrl}/api/orders/${announced.id}`, {
            headers,
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) observed = (await response.json()) as Record<string, any>;
          if (
            observed?.src?.lockTx?.toLowerCase() === txHash.toLowerCase() &&
            observed?.src?.orderId === chainOrderId
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        expect(observed, "coordinator never returned the ingested order").toBeDefined();
        expect(observed!.id).toBe(announced.id);
        expect(observed!.hashlock).toBe(secret.sha256);
        expect(observed!.src.orderId).toBe(chainOrderId);
        expect(observed!.src.lockTx.toLowerCase()).toBe(txHash.toLowerCase());
        expect(observed!.status).toBe("src_locked");
      } catch (error) {
        // Record timeout/provider-failure behavior with the identifiers needed
        // for cleanup; the disposable lock refunds itself after its 10m timelock.
        console.info(
          "devnet event-coordinator cleanup",
          devnetCleanupRecord({
            txHash: txHash ?? "not-submitted",
            orderId: announced.id,
            providerFailure: true,
            timeoutMs: POLL_TIMEOUT_MS,
          }),
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }

      console.info(
        "devnet event-coordinator cleanup",
        devnetCleanupRecord({
          txHash: txHash!,
          orderId: announced.id,
          providerFailure: false,
          timeoutMs: POLL_TIMEOUT_MS,
        }),
      );
    },
    300_000,
  );
});
