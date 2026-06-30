import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  parseEventLogs
} from "viem";
import { HTLC_ESCROW_ABI } from "./abi.js";
import { escrowNativeValue } from "../shared-utils/index.js";

export { HTLC_ESCROW_ABI } from "./abi.js";

export interface EthereumHTLCClientOptions {
  /** Address of the deployed HTLCEscrow contract. */
  address: Address;
  publicClient: PublicClient;
  /** Optional wallet client. Read-only operations don't need it. */
  walletClient?: WalletClient;
}

export interface CreateOrderInput {
  beneficiary: Address;
  refundAddress: Address;
  /** address(0) for native ETH, ERC20 address otherwise. */
  token: Address;
  /** Amount in atomic units (wei for ETH, token decimals otherwise). */
  amount: bigint;
  safetyDeposit: bigint;
  /** 32-byte digest, sha256(preimage) or keccak256(preimage). */
  hashlock: Hex;
  /** Timelock duration in seconds (added to block.timestamp). */
  timelockSeconds: bigint;
}

export interface OrderData {
  sender: Address;
  beneficiary: Address;
  refundAddress: Address;
  token: Address;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: Hex;
  timelock: bigint;
  createdAt: bigint;
  finalisedAt: bigint;
  status: 0 | 1 | 2;
  preimageKeccak: Hex;
}

const NATIVE_ETH_TOKEN = "0x0000000000000000000000000000000000000000";

/**
 * Type-safe wrapper around the WaffleFinance `HTLCEscrow` contract.
 *
 * The class intentionally avoids hiding viem — both `publicClient` and
 * `walletClient` are passed in directly so callers can plug in any
 * wallet (MetaMask, WalletConnect, headless private key, etc).
 */
export class EthereumHTLCClient {
  public readonly address: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;

  constructor(opts: EthereumHTLCClientOptions) {
    this.address = opts.address;
    this.publicClient = opts.publicClient;
    this.walletClient = opts.walletClient;
  }

  private requireWallet(): WalletClient {
    if (!this.walletClient) {
      throw new Error("This operation requires a wallet client (signer).");
    }
    return this.walletClient;
  }

  /**
   * Create (fund) an HTLC order on the escrow.
   *
   * Transaction value (`msg.value`) semantics enforced by the contract:
   *
   * - **Native ETH** (`token === address(0)`): `value` must equal
   *   `amount + safetyDeposit` exactly. This wrapper computes it for you.
   * - **ERC20** (`token` is a token address): `value` must equal the
   *   `safetyDeposit` only (the deposit is always paid in ETH); the token
   *   `amount` is pulled via `transferFrom`. **The caller MUST approve this
   *   escrow for at least `amount` of `token` before calling** — otherwise
   *   the contract reverts with `InsufficientAllowance(allowance, required)`.
   *
   * The contract validates the ERC20 flow up-front and reverts with a
   * targeted reason rather than an opaque token failure:
   * - `InvalidToken` — `token` is not a deployed contract.
   * - `InsufficientAllowance(allowance, required)` — approval too small.
   * - `InsufficientBalance(balance, required)` — caller can't cover `amount`.
   * - `InvalidValue` — `msg.value` did not match the rules above.
   *
   * These are decodable via {@link HTLC_ESCROW_ABI}; the `simulateContract`
   * call below surfaces them before any gas is spent on-chain.
   */
  async createOrder(input: CreateOrderInput): Promise<{ txHash: Hex; orderId: bigint }> {
    const wallet = this.requireWallet();
    const account = wallet.account;
    if (!account) {
      throw new Error("walletClient.account is required to send transactions");
    }
    const value = escrowNativeValue({
      token: input.token,
      nativeToken: NATIVE_ETH_TOKEN,
      amount: input.amount,
      safetyDeposit: input.safetyDeposit
    });

    const { request, result } = await this.publicClient.simulateContract({
      address: this.address,
      abi: HTLC_ESCROW_ABI,
      functionName: "createOrder",
      args: [
        input.beneficiary,
        input.refundAddress,
        input.token,
        input.amount,
        input.safetyDeposit,
        input.hashlock,
        input.timelockSeconds
      ],
      account: account.address,
      value
    });

    const txHash = await wallet.writeContract(request);
    return { txHash, orderId: result as bigint };
  }

  async claimOrder(orderId: bigint, preimage: Hex): Promise<Hex> {
    const wallet = this.requireWallet();
    if (!wallet.account) throw new Error("walletClient.account is required");
    const { request } = await this.publicClient.simulateContract({
      address: this.address,
      abi: HTLC_ESCROW_ABI,
      functionName: "claimOrder",
      args: [orderId, preimage],
      account: wallet.account.address
    });
    return wallet.writeContract(request);
  }

  async refundOrder(orderId: bigint): Promise<Hex> {
    const wallet = this.requireWallet();
    if (!wallet.account) throw new Error("walletClient.account is required");
    const { request } = await this.publicClient.simulateContract({
      address: this.address,
      abi: HTLC_ESCROW_ABI,
      functionName: "refundOrder",
      args: [orderId],
      account: wallet.account.address
    });
    return wallet.writeContract(request);
  }

  async getOrder(orderId: bigint): Promise<OrderData> {
    const result = (await this.publicClient.readContract({
      address: this.address,
      abi: HTLC_ESCROW_ABI,
      functionName: "getOrder",
      args: [orderId]
    })) as OrderData;
    return result;
  }

  /**
   * Helper to extract the `orderId` from a `createOrder` tx receipt.
   */
  async waitForOrderCreation(txHash: Hex): Promise<bigint> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    const events = parseEventLogs({
      abi: HTLC_ESCROW_ABI,
      eventName: "OrderCreated",
      logs: receipt.logs
    });
    const first = events[0];
    if (!first) throw new Error("OrderCreated event not found in receipt");
    return first.args.orderId as bigint;
  }
}
