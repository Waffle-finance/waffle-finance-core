import {
  Address as SorobanAddress,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  type Keypair,
  type Transaction
} from "@stellar/stellar-sdk";
import { hex32ToBuffer } from "../shared-utils/index.js";

export interface SorobanHTLCClientOptions {
  /** Soroban RPC endpoint, e.g. https://soroban-testnet.stellar.org */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Contract id of the deployed `wafflefinance-htlc` contract. */
  contractId: string;
  /** Allow plain HTTP (for local sandboxes). */
  allowHttp?: boolean;
}

export interface SorobanCreateOrderInput {
  sender: string;
  beneficiary: string;
  refundAddress: string;
  /** Stellar asset contract id (e.g. native asset contract or a SAC). */
  asset: string;
  amount: bigint;
  safetyDeposit: bigint;
  hashlockHex: `0x${string}`;
  timelockSeconds: number;
}

/**
 * Type-safe wrapper around the WaffleFinance Soroban HTLC contract.
 *
 * The class builds the transaction envelopes; signing is delegated to
 * the caller's wallet (Freighter, headless keypair, etc) via a
 * `signTransaction` callback. This avoids the SDK holding any keys.
 */
export class SorobanHTLCClient {
  public readonly contractId: string;
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(opts: SorobanHTLCClientOptions) {
    this.contractId = opts.contractId;
    this.server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.allowHttp ?? false });
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
  }

  private async buildTx(
    callerAccountId: string,
    operation: ReturnType<Contract["call"]>
  ): Promise<Transaction> {
    const account = await this.server.getAccount(callerAccountId);
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase
    })
      .addOperation(operation)
      .setTimeout(180)
      .build();
  }

  /**
   * Build, simulate, sign and submit a `create_order` transaction.
   * Returns the on-chain transaction hash.
   */
  async createOrder(
    input: SorobanCreateOrderInput,
    signer: SorobanSigner
  ): Promise<string> {
    const op = this.contract.call(
      "create_order",
      new SorobanAddress(input.sender).toScVal(),
      new SorobanAddress(input.beneficiary).toScVal(),
      new SorobanAddress(input.refundAddress).toScVal(),
      new SorobanAddress(input.asset).toScVal(),
      nativeToScVal(input.amount, { type: "i128" }),
      nativeToScVal(input.safetyDeposit, { type: "i128" }),
      nativeToScVal(hex32ToBuffer(input.hashlockHex, "hashlock"), { type: "bytes" }),
      nativeToScVal(input.timelockSeconds, { type: "u64" })
    );
    return this.simulateSignSubmit(input.sender, op, signer);
  }

  async claimOrder(
    callerAccountId: string,
    orderId: bigint,
    preimageHex: `0x${string}`,
    signer: SorobanSigner
  ): Promise<string> {
    const op = this.contract.call(
      "claim_order",
      nativeToScVal(orderId, { type: "u64" }),
      nativeToScVal(hex32ToBuffer(preimageHex, "preimage"), { type: "bytes" }),
      new SorobanAddress(callerAccountId).toScVal()
    );
    return this.simulateSignSubmit(callerAccountId, op, signer);
  }

  async refundOrder(
    callerAccountId: string,
    orderId: bigint,
    signer: SorobanSigner
  ): Promise<string> {
    const op = this.contract.call(
      "refund_order",
      nativeToScVal(orderId, { type: "u64" }),
      new SorobanAddress(callerAccountId).toScVal()
    );
    return this.simulateSignSubmit(callerAccountId, op, signer);
  }

  async getOrder(orderId: bigint): Promise<unknown | null> {
    const op = this.contract.call(
      "get_order",
      nativeToScVal(orderId, { type: "u64" })
    );
    const sourceAccount = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
    const account = { accountId: () => sourceAccount, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any;
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase
    })
      .addOperation(op)
      .setTimeout(180)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if ("error" in sim && sim.error) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    const result = (sim as any).result;
    if (!result || !result.retval) return null;
    return scValToNative(result.retval);
  }

  private async simulateSignSubmit(
    sourceAccountId: string,
    op: ReturnType<Contract["call"]>,
    signer: SorobanSigner
  ): Promise<string> {
    let tx = await this.buildTx(sourceAccountId, op);
    const sim = await this.server.simulateTransaction(tx);
    if ("error" in sim && sim.error) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    tx = rpc.assembleTransaction(tx, sim).build();
    const signedXdr = await signer({
      xdr: tx.toXDR(),
      networkPassphrase: this.networkPassphrase,
      publicKey: sourceAccountId
    });
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
    const submitted = await this.server.sendTransaction(signedTx);
    if (submitted.status === "ERROR") {
      throw new Error(`Submit failed: ${submitted.errorResult?.toXDR("base64") ?? "unknown"}`);
    }
    return submitted.hash;
  }
}

/**
 * Callback used by the SDK to delegate signing to whichever wallet the
 * caller is using. Implementations include:
 *
 *   - Freighter API in the browser
 *   - A direct `Keypair.sign()` call for headless services
 *   - WalletConnect bridges
 */
export type SorobanSigner = (req: {
  xdr: string;
  networkPassphrase: string;
  publicKey: string;
}) => Promise<string>;

/**
 * Convenience signer for headless use (resolvers, CI). NEVER use in
 * the browser — exposes the secret key to the calling code.
 */
export function makeKeypairSigner(keypair: Keypair): SorobanSigner {
  return async (req) => {
    const tx = TransactionBuilder.fromXDR(req.xdr, req.networkPassphrase) as Transaction;
    tx.sign(keypair);
    return tx.toXDR();
  };
}
