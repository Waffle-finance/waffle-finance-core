/**
 * Live-network devnet implementations of AsyncHtlcSim.
 *
 * Each class connects to a real testnet/devnet and submits signed transactions
 * against the deployed HTLC contract.  All three implement the same
 * AsyncHtlcSim interface so the devnet.test.ts scenarios can run in a
 * chain-agnostic loop, mirroring the in-process differential harness in
 * cross-chain.test.ts.
 *
 * Tests are skipped automatically when the required env vars are absent —
 * see devnet.test.ts for the skip conditions.
 */

import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import type { AsyncHtlcSim, CreateOrderInput, Hex, OrderStatus, OrderView } from "./sim.js";

// Type-only, so the runtime `await import("@solana/web3.js")` below stays lazy.
import type { Connection, PublicKey } from "@solana/web3.js";

// Solana account sizes, PDA seeds, and the rent/safety-rail helpers come from
// the SDK so this script cannot drift from the layout the SDK encodes against.
// Previously every one of these was an inline literal (`Buffer.from("state")`,
// the counter offset `8`), so a layout change silently desynchronised the
// devnet harness from the SDK rather than failing a test.
import {
  ORDER_REGISTRY_SEED,
  ORDER_REGISTRY_ACCOUNT_SIZE,
  ANCHOR_DISCRIMINATOR_SIZE,
  readOrderCount,
  getRentExemptMinimum,
  assertPayerCanFund,
  accountSizeFor,
  SolanaAccountInitError,
} from "@wafflefinance/sdk/solana";

// ── HTLCEscrow minimal ABI ────────────────────────────────────────────────────

const HTLC_ESCROW_ABI = [
  {
    name: "createOrder",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "beneficiary",     type: "address" },
      { name: "refundAddress",   type: "address" },
      { name: "token",           type: "address" },
      { name: "amount",          type: "uint256" },
      { name: "safetyDeposit",   type: "uint256" },
      { name: "hashlock",        type: "bytes32" },
      { name: "timelockSeconds", type: "uint64"  },
    ],
    outputs: [{ name: "orderId", type: "uint256" }],
  },
  {
    name: "claimOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId",  type: "uint256" },
      { name: "preimage", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    name: "refundOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "getOrder",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "sender",        type: "address" },
          { name: "beneficiary",   type: "address" },
          { name: "refundAddress", type: "address" },
          { name: "token",         type: "address" },
          { name: "amount",        type: "uint256" },
          { name: "safetyDeposit", type: "uint256" },
          { name: "hashlock",      type: "bytes32" },
          { name: "timelock",      type: "uint64"  },
          { name: "createdAt",     type: "uint64"  },
          { name: "finalisedAt",   type: "uint64"  },
          { name: "status",        type: "uint8"   },
          { name: "preimageKeccak",type: "bytes32" },
        ],
      },
    ],
  },
  {
    name: "OrderCreated",
    type: "event",
    inputs: [
      { name: "orderId",       type: "uint256", indexed: true  },
      { name: "sender",        type: "address", indexed: true  },
      { name: "beneficiary",   type: "address", indexed: true  },
      { name: "token",         type: "address", indexed: false },
      { name: "amount",        type: "uint256", indexed: false },
      { name: "safetyDeposit", type: "uint256", indexed: false },
      { name: "hashlock",      type: "bytes32", indexed: false },
      { name: "timelock",      type: "uint64",  indexed: false },
    ],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

// ── EVM Devnet ────────────────────────────────────────────────────────────────

export interface EvmDevnetConfig {
  /** HTTP RPC URL for Sepolia (or any EVM-compatible testnet). */
  rpcUrl: string;
  /** Hex-encoded 32-byte private key of the signer. */
  privateKey: Hex;
  /** Deployed HTLCEscrow contract address. */
  contractAddress: Hex;
  /** Recipient on claim. Defaults to the signer address. */
  beneficiary?: Hex;
  /** Recipient on refund. Defaults to the signer address. */
  refundAddress?: Hex;
  /** ERC-20 token address, or ZERO_ADDRESS for native ETH. */
  token?: Hex;
  /** Amount to lock per order (wei for ETH, raw units for ERC-20). */
  amount?: bigint;
  /** Safety deposit in wei forwarded alongside native-ETH orders. */
  safetyDeposit?: bigint;
}

/**
 * Live Sepolia implementation of AsyncHtlcSim.
 *
 * Submits signed viem transactions to a real Sepolia node and parses the
 * OrderCreated event from the receipt to recover on-chain order IDs.
 * advanceTime is a no-op — the chain's own block timestamp is authoritative.
 */
export class EvmHtlcDevnet implements AsyncHtlcSim {
  readonly name = "evm" as const;

  private readonly cfg: Required<EvmDevnetConfig>;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;

  constructor(config: EvmDevnetConfig) {
    const account = privateKeyToAccount(config.privateKey);
    const signerAddress = account.address as Hex;

    this.cfg = {
      rpcUrl:          config.rpcUrl,
      privateKey:      config.privateKey,
      contractAddress: config.contractAddress,
      beneficiary:     config.beneficiary   ?? signerAddress,
      refundAddress:   config.refundAddress ?? signerAddress,
      token:           config.token         ?? ZERO_ADDRESS,
      amount:          config.amount        ?? 1_000_000_000_000_000n, // 0.001 ETH
      safetyDeposit:   config.safetyDeposit ?? 0n,
    };

    this.publicClient = createPublicClient({
      chain:     sepolia,
      transport: http(config.rpcUrl),
    });

    this.walletClient = createWalletClient({
      account,
      chain:     sepolia,
      transport: http(config.rpcUrl),
    });
  }

  advanceTime(_seconds: number): void { /* no-op on live networks */ }

  async createOrder(input: CreateOrderInput): Promise<bigint> {
    const isNativeEth = this.cfg.token === ZERO_ADDRESS;
    const value = isNativeEth
      ? this.cfg.amount + this.cfg.safetyDeposit
      : this.cfg.safetyDeposit;

    const txHash = await this.walletClient.writeContract({
      address:      this.cfg.contractAddress,
      abi:          HTLC_ESCROW_ABI,
      functionName: "createOrder",
      args: [
        this.cfg.beneficiary,
        this.cfg.refundAddress,
        this.cfg.token,
        this.cfg.amount,
        this.cfg.safetyDeposit,
        input.hashlock as `0x${string}`,
        BigInt(input.timelockSeconds),
      ],
      value,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({ abi: HTLC_ESCROW_ABI, logs: receipt.logs });
    const created = logs.find((l) => l.eventName === "OrderCreated");
    if (!created) throw new Error("OrderCreated event not found in receipt");
    return (created.args as { orderId: bigint }).orderId;
  }

  async claimOrder(id: bigint, preimage: Hex): Promise<void> {
    const preimageBytes = `0x${preimage.slice(2)}` as `0x${string}`;
    const txHash = await this.walletClient.writeContract({
      address:      this.cfg.contractAddress,
      abi:          HTLC_ESCROW_ABI,
      functionName: "claimOrder",
      args:         [id, preimageBytes],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  async refundOrder(id: bigint): Promise<void> {
    const txHash = await this.walletClient.writeContract({
      address:      this.cfg.contractAddress,
      abi:          HTLC_ESCROW_ABI,
      functionName: "refundOrder",
      args:         [id],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  async getOrder(id: bigint): Promise<OrderView> {
    const raw = await this.publicClient.readContract({
      address:      this.cfg.contractAddress,
      abi:          HTLC_ESCROW_ABI,
      functionName: "getOrder",
      args:         [id],
    }) as {
      hashlock:    `0x${string}`;
      timelock:    bigint;
      status:      number;
      createdAt:   bigint;
      finalisedAt: bigint;
    };

    const STATUS: OrderStatus[] = ["Funded", "Claimed", "Refunded"];
    return {
      id,
      hashlock:         raw.hashlock as Hex,
      timelockAbsolute: Number(raw.timelock),
      status:           STATUS[raw.status] ?? "Funded",
      createdAt:        Number(raw.createdAt),
      finalisedAt:      Number(raw.finalisedAt),
    };
  }
}

// ── Soroban Devnet ────────────────────────────────────────────────────────────

export interface SorobanDevnetConfig {
  /** Soroban RPC URL (e.g. https://soroban-testnet.stellar.org). */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Stellar secret key (S…) for the signer account. */
  secretKey: string;
  /** Soroban contract ID (C… bech32 address). */
  contractId: string;
  /** Amount to lock per order in stroops (1 XLM = 10_000_000). */
  amount?: bigint;
  /** Safety deposit in stroops. */
  safetyDeposit?: bigint;
  /** Stellar asset contract address for the token (defaults to native XLM SAC). */
  tokenContractId?: string;
}

/**
 * Live Stellar testnet implementation of AsyncHtlcSim.
 *
 * Invokes the wafflefinance-htlc Soroban contract via the Stellar RPC using
 * @stellar/stellar-sdk. The signer is a funded testnet keypair whose secret
 * key is supplied in SorobanDevnetConfig.secretKey.
 *
 * advanceTime is a no-op — the network's ledger sequence advances on its own.
 */
export class SorobanHtlcDevnet implements AsyncHtlcSim {
  readonly name = "soroban" as const;

  private readonly cfg: Required<SorobanDevnetConfig>;

  constructor(config: SorobanDevnetConfig) {
    this.cfg = {
      rpcUrl:            config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      secretKey:         config.secretKey,
      contractId:        config.contractId,
      amount:            config.amount        ?? 10_000_000n,     // 1 XLM
      safetyDeposit:     config.safetyDeposit ?? 0n,
      tokenContractId:   config.tokenContractId ?? "",
    };
  }

  advanceTime(_seconds: number): void { /* no-op on live networks */ }

  private async sdk() {
    // Dynamic import so the test suite does not hard-require stellar-sdk
    // when only EVM or Solana devnet tests are running.
    return import("@stellar/stellar-sdk");
  }

  async createOrder(input: CreateOrderInput): Promise<bigint> {
    const sdk = await this.sdk();
    const keypair = sdk.Keypair.fromSecret(this.cfg.secretKey);
    const server  = new sdk.rpc.Server(this.cfg.rpcUrl, { allowHttp: false });
    const contract = new sdk.Contract(this.cfg.contractId);

    const hashlockBytes = Buffer.from(input.hashlock.slice(2), "hex");

    const account = await server.getAccount(keypair.publicKey());

    const tx = new sdk.TransactionBuilder(account, {
      fee:               "1000000",
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "create_order",
          sdk.nativeToScVal(Number(this.cfg.amount), { type: "i128" }),
          sdk.Address.fromString(keypair.publicKey()).toScVal(),
          sdk.Address.fromString(keypair.publicKey()).toScVal(),
          sdk.xdr.ScVal.scvBytes(hashlockBytes),
          sdk.nativeToScVal(input.timelockSeconds, { type: "u64" }),
          this.cfg.tokenContractId
            ? sdk.Address.fromString(this.cfg.tokenContractId).toScVal()
            : sdk.xdr.ScVal.scvVoid(),
          sdk.nativeToScVal(Number(this.cfg.safetyDeposit), { type: "i128" }),
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);

    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
      throw new Error(`Soroban sendTransaction failed: ${JSON.stringify(sendResult.errorResult)}`);
    }

    // Poll until confirmed.
    let getResult: Awaited<ReturnType<typeof server.getTransaction>>;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      getResult = await server.getTransaction(sendResult.hash);
      if (getResult.status !== "NOT_FOUND") break;
    }
    getResult = getResult!;

    if (getResult.status !== "SUCCESS") {
      throw new Error(`Soroban transaction failed: ${getResult.status}`);
    }

    // The contract returns the new order ID as u64.
    const returnVal = getResult.returnValue;
    if (!returnVal || returnVal.switch().name !== "scvU64") {
      throw new Error("create_order did not return a u64 order ID");
    }
    return BigInt(returnVal.u64().toString());
  }

  async claimOrder(id: bigint, preimage: Hex): Promise<void> {
    const sdk = await this.sdk();
    const keypair  = sdk.Keypair.fromSecret(this.cfg.secretKey);
    const server   = new sdk.rpc.Server(this.cfg.rpcUrl, { allowHttp: false });
    const contract = new sdk.Contract(this.cfg.contractId);

    const preimageBytes = Buffer.from(preimage.slice(2), "hex");
    const account = await server.getAccount(keypair.publicKey());

    const tx = new sdk.TransactionBuilder(account, {
      fee:               "1000000",
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "claim_order",
          sdk.nativeToScVal(Number(id), { type: "u64" }),
          sdk.xdr.ScVal.scvBytes(preimageBytes),
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
      throw new Error(`Soroban claimOrder failed: ${JSON.stringify(sendResult.errorResult)}`);
    }
    await this.waitForSuccess(server, sendResult.hash);
  }

  async refundOrder(id: bigint): Promise<void> {
    const sdk = await this.sdk();
    const keypair  = sdk.Keypair.fromSecret(this.cfg.secretKey);
    const server   = new sdk.rpc.Server(this.cfg.rpcUrl, { allowHttp: false });
    const contract = new sdk.Contract(this.cfg.contractId);

    const account = await server.getAccount(keypair.publicKey());

    const tx = new sdk.TransactionBuilder(account, {
      fee:               "1000000",
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "refund_order",
          sdk.nativeToScVal(Number(id), { type: "u64" }),
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
      throw new Error(`Soroban refundOrder failed: ${JSON.stringify(sendResult.errorResult)}`);
    }
    await this.waitForSuccess(server, sendResult.hash);
  }

  async getOrder(id: bigint): Promise<OrderView> {
    const sdk = await this.sdk();
    const server   = new sdk.rpc.Server(this.cfg.rpcUrl, { allowHttp: false });
    const contract = new sdk.Contract(this.cfg.contractId);
    const keypair  = sdk.Keypair.fromSecret(this.cfg.secretKey);

    const account = await server.getAccount(keypair.publicKey());
    const tx = new sdk.TransactionBuilder(account, {
      fee:               "1000000",
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(contract.call("get_order", sdk.nativeToScVal(Number(id), { type: "u64" })))
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);
    if (!("results" in simResult) || !simResult.results?.[0]) {
      throw new Error("get_order simulation returned no result");
    }

    const retVal = sdk.xdr.ScVal.fromXDR(simResult.results[0].xdr, "base64");
    return this.decodeOrderScVal(id, retVal, sdk);
  }

  private decodeOrderScVal(id: bigint, val: unknown, sdk: Awaited<ReturnType<SorobanHtlcDevnet["sdk"]>>): OrderView {
    // The order is a Soroban map. Extract fields by key.
    const map = (val as sdk.xdr.ScVal).map() ?? [];
    const get = (key: string) => {
      const entry = map.find((e: sdk.xdr.ScMapEntry) => e.key().sym() === key);
      return entry ? entry.val() : undefined;
    };

    const statusSymbol = get("status")?.sym() ?? "Funded";
    const STATUS_MAP: Record<string, OrderStatus> = {
      Active:    "Funded",
      Claimed:   "Claimed",
      Refunded:  "Refunded",
    };
    const hashlockBytes = get("hashlock")?.bytes() as Buffer | undefined;

    return {
      id,
      hashlock:         hashlockBytes
        ? (`0x${hashlockBytes.toString("hex")}` as Hex)
        : ("0x" + "00".repeat(32)) as Hex,
      timelockAbsolute: Number(get("timelock")?.u64()?.toString() ?? 0),
      status:           STATUS_MAP[statusSymbol] ?? "Funded",
      createdAt:        Number(get("created_at")?.u64()?.toString() ?? 0),
      finalisedAt:      Number(get("finalised_at")?.u64()?.toString() ?? 0),
    };
  }

  private async waitForSuccess(
    server: InstanceType<Awaited<ReturnType<SorobanHtlcDevnet["sdk"]>>["rpc"]["Server"]>,
    hash: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const result = await server.getTransaction(hash);
      if (result.status === "SUCCESS") return;
      if (result.status !== "NOT_FOUND") {
        throw new Error(`Soroban transaction failed: ${result.status}`);
      }
    }
    throw new Error("Soroban transaction timed out waiting for confirmation");
  }
}

// ── Solana Devnet ─────────────────────────────────────────────────────────────

export interface SolanaDevnetConfig {
  /** Solana cluster URL (e.g. https://api.devnet.solana.com). */
  rpcUrl: string;
  /** 64-byte keypair secret as a Uint8Array or base-58 string. */
  secretKey: Uint8Array | string;
  /** Deployed HTLC Anchor program ID (base-58). */
  programId: string;
  /**
   * Amount to lock per order in lamports.
   *
   * This is the *amount under escrow*, not rent. The rent the payer must cover
   * on top of it is always queried from the cluster at submission time via
   * `getMinimumBalanceForRentExemption` — it is never assumed.
   */
  amount?: bigint;
}

/**
 * Anchor discriminator for an instruction named `name` using the global
 * namespace convention: sha256("global:<name>")[0..8].
 */
function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function writeBigInt64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/**
 * Live Solana devnet implementation of AsyncHtlcSim.
 *
 * Submits Anchor program instructions to the Solana HTLC program using
 * @solana/web3.js.  Order accounts are program-derived from the on-chain
 * order counter so each createOrder call stores a predictable PDA.
 *
 * advanceTime is a no-op — the Solana runtime's clock is authoritative.
 */
export class SolanaHtlcDevnet implements AsyncHtlcSim {
  readonly name = "solana" as const;

  private readonly cfg: Required<SolanaDevnetConfig>;

  constructor(config: SolanaDevnetConfig) {
    this.cfg = {
      rpcUrl:    config.rpcUrl,
      secretKey: config.secretKey,
      programId: config.programId,
      amount:    config.amount ?? 1_000_000n, // 0.001 SOL
    };
  }

  advanceTime(_seconds: number): void { /* no-op on live networks */ }

  private async solana() {
    return import("@solana/web3.js");
  }

  private async makeKeypair(web3: Awaited<ReturnType<SolanaHtlcDevnet["solana"]>>) {
    const { secretKey } = this.cfg;
    if (typeof secretKey === "string") {
      const { default: bs58 } = await import("bs58");
      return web3.Keypair.fromSecretKey(bs58.decode(secretKey));
    }
    return web3.Keypair.fromSecretKey(secretKey);
  }

async createOrder(input: CreateOrderInput): Promise<bigint> {
    const web3 = await this.solana();
    const keypair   = await this.makeKeypair(web3);
    const conn      = new web3.Connection(this.cfg.rpcUrl, "confirmed");
    const programId = new web3.PublicKey(this.cfg.programId);

    // ── Registry (order counter) ────────────────────────────────────────────
    // Seed and size come from the SDK's shared table, not literals. An absent
    // state account means the program has never been initialised, so the
    // counter starts at 1 — a documented, deliberate default.
    const [statePda] = web3.PublicKey.findProgramAddressSync(
      [ORDER_REGISTRY_SEED],
      programId,
    );
    const stateAccount = await conn.getAccountInfo(statePda);
    const nextId = stateAccount ? readOrderCount(stateAccount.data) : 1n;

    const [orderPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), writeBigInt64LE(nextId)],
      programId,
    );

    // ── Preflight: rent from the cluster + payer solvency ───────────────────
    // Both run before the transaction is built so a mis-sized account or an
    // under-funded keypair fails with a named shortfall instead of an opaque
    // runtime error after fees are spent.
    await this.assertCanFundOrder(conn, keypair.publicKey, orderPda);

    const hashlockBytes = Buffer.from(input.hashlock.slice(2), "hex");
    const data = Buffer.concat([
      anchorDiscriminator("create_order"),
      writeBigInt64LE(this.cfg.amount),                          // amount (u64)
      writeBigInt64LE(BigInt(input.timelockSeconds)),             // timelock_seconds (u64)
      hashlockBytes,                                             // hashlock [u8; 32]
    ]);

    const ix = new web3.TransactionInstruction({
      programId,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  }, // sender
        { pubkey: keypair.publicKey, isSigner: false, isWritable: false }, // beneficiary
        { pubkey: orderPda,          isSigner: false, isWritable: true  }, // order account
        { pubkey: statePda,          isSigner: false, isWritable: true  }, // global state
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new web3.Transaction().add(ix);
    await web3.sendAndConfirmTransaction(conn, tx, [keypair], { commitment: "confirmed" });
    return nextId;
  }

  /**
   * Verify the payer can cover the order account's rent plus the escrow amount
   * and the transaction fee, using the cluster's own rent table.
   *
   * Sizes come from the SDK's shared field table rather than byte counts, so
   * the figure fed to the rent calculation is the same number the SDK encodes
   * against. Rent is never assumed or hardcoded.
   */
  private async assertCanFundOrder(
    conn: Connection,
    payer: PublicKey,
    orderPda: PublicKey
  ): Promise<void> {
    const orderSize = accountSizeFor("htlcOrder");
    const registrySize = ORDER_REGISTRY_ACCOUNT_SIZE;

    // A size at or below the bare discriminator means the layout table itself is
    // broken. Fail with both numbers rather than quoting rent for nonsense.
    if (orderSize <= ANCHOR_DISCRIMINATOR_SIZE || registrySize <= ANCHOR_DISCRIMINATOR_SIZE) {
      throw new SolanaAccountInitError(
        "InvalidAccountSize",
        `Solana account size configuration is broken: order ${orderSize} bytes, ` +
        `registry ${registrySize} bytes (the Anchor discriminator alone is ` +
        `${ANCHOR_DISCRIMINATOR_SIZE}). Fix SOLANA_ANCHOR_ACCOUNT_LAYOUTS in ` +
        `@wafflefinance/sdk/src/solana/account-sizing.ts.`
      );
    }

    // Rent for BOTH accounts this transaction touches: the order PDA, and the
    // registry when it has not been created yet.
    const [orderRent, registryRent] = await Promise.all([
      getRentExemptMinimum(conn, orderSize),
      getRentExemptMinimum(conn, registrySize),
    ]);

    const balance = BigInt(await conn.getBalance(payer, "confirmed"));
    assertPayerCanFund({
      payer,
      account: `order ${orderPda.toBase58()}`,
      rentLamports: orderRent + registryRent,
      amountLamports: this.cfg.amount,
      signatureCount: 1,
      balanceLamports: balance,
    });
  }

  async claimOrder(id: bigint, preimage: Hex): Promise<void> {
    const web3 = await this.solana();
    const keypair   = await this.makeKeypair(web3);
    const conn      = new web3.Connection(this.cfg.rpcUrl, "confirmed");
    const programId = new web3.PublicKey(this.cfg.programId);

    const [orderPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), writeBigInt64LE(id)],
      programId,
    );

    const preimageBytes = Buffer.from(preimage.slice(2), "hex");
    const data = Buffer.concat([
      anchorDiscriminator("claim_order"),
      writeBigInt64LE(id),
      preimageBytes,
    ]);

    const ix = new web3.TransactionInstruction({
      programId,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  }, // claimer
        { pubkey: orderPda,          isSigner: false, isWritable: true  }, // order account
      ],
      data,
    });

    const tx = new web3.Transaction().add(ix);
    await web3.sendAndConfirmTransaction(conn, tx, [keypair], { commitment: "confirmed" });
  }

  async refundOrder(id: bigint): Promise<void> {
    const web3 = await this.solana();
    const keypair   = await this.makeKeypair(web3);
    const conn      = new web3.Connection(this.cfg.rpcUrl, "confirmed");
    const programId = new web3.PublicKey(this.cfg.programId);

    const [orderPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), writeBigInt64LE(id)],
      programId,
    );

    const data = Buffer.concat([
      anchorDiscriminator("refund_order"),
      writeBigInt64LE(id),
    ]);

    const ix = new web3.TransactionInstruction({
      programId,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  }, // sender/refund recipient
        { pubkey: orderPda,          isSigner: false, isWritable: true  }, // order account
      ],
      data,
    });

    const tx = new web3.Transaction().add(ix);
    await web3.sendAndConfirmTransaction(conn, tx, [keypair], { commitment: "confirmed" });
  }

  async getOrder(id: bigint): Promise<OrderView> {
    const web3 = await this.solana();
    const conn      = new web3.Connection(this.cfg.rpcUrl, "confirmed");
    const programId = new web3.PublicKey(this.cfg.programId);

    const [orderPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order"), writeBigInt64LE(id)],
      programId,
    );

    const info = await conn.getAccountInfo(orderPda);
    if (!info) throw new Error(`Order account not found for id=${id}`);

    // ⚠ KNOWN DIVERGENCE — do not "fix" this without a program decision.
    //
    // This harness targets a *different* on-chain order layout than the SDK IDL
    // (`packages/sdk/src/solana/idl/htlc.ts`), and the two cannot both match one
    // deployed program:
    //
    //   here: seeds [b"order", u64_le(id)], 56-byte create_order, 65-byte account
    //   SDK:  seeds [b"order", hashlock_32],   64-byte create_order, 227-byte account
    //
    // The offsets below are left exactly as the live devnet program defines
    // them. Reconciling them is a product decision (see
    // docs/SOLANA_ACCOUNT_INIT_RENT_AUDIT.md §2.2 F15), not a cleanup — so the
    // divergence is asserted here rather than papered over.
    //
    // Anchor account layout (after 8-byte discriminator):
    //   hashlock:         [u8; 32]   — bytes 8..40
    //   timelock_absolute: u64 LE    — bytes 40..48
    //   created_at:        u64 LE    — bytes 48..56
    //   finalised_at:      u64 LE    — bytes 56..64
    //   status:            u8        — byte 64
    const d = info.data;

    // Smallest byte index the reads below touch. Buffer.readBigUInt64LE on a
    // short buffer does not throw — it yields 0 — so without this guard a
    // truncated account silently reports "funded at time 0", which would let a
    // claim/refund scenario pass against a corrupt account.
    const REQUIRED_BYTES = 65;
    if (d.length < REQUIRED_BYTES) {
      throw new Error(
        `Solana order account ${orderPda.toBase58()} (id=${id}) is ${d.length} bytes; ` +
        `this harness's layout needs at least ${REQUIRED_BYTES} ` +
        `(${ANCHOR_DISCRIMINATOR_SIZE} discriminator + 57 field bytes). The account is ` +
        `truncated or was created by a different program version. ` +
        `The SDK's declared size for an HtlcOrder is ${accountSizeFor("htlcOrder")} bytes — ` +
        `if this account is meant to be a full HtlcOrder, the deployed program's ` +
        `space = ... disagrees with the SDK IDL.`
      );
    }

    const hashlock       = `0x${d.subarray(8,  40).toString("hex")}` as Hex;
    const timelockAbs    = Number(d.readBigUInt64LE(40));
    const createdAt      = Number(d.readBigUInt64LE(48));
    const finalisedAt    = Number(d.readBigUInt64LE(56));
    const statusByte     = d[64];
    const STATUS: OrderStatus[] = ["Funded", "Claimed", "Refunded"];

    return {
      id,
      hashlock,
      timelockAbsolute: timelockAbs,
      status:           STATUS[statusByte] ?? "Funded",
      createdAt,
      finalisedAt,
    };
  }
}
