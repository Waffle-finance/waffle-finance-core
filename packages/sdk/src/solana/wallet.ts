/**
 * Standardized Phantom and Solana wallet connection lifecycle manager.
 * Provides unified account-change listeners, disconnect/reconnect handling,
 * error classification, and signer delegation for SDK and frontend usage.
 */

import { PublicKey, Transaction } from "@solana/web3.js";
import type { SolanaSigner } from "./index.js";

export type SolanaConnectionPhase =
  | "idle"
  | "checking"
  | "requesting_permission"
  | "connected"
  | "error";

export interface PhantomSolanaProvider {
  isPhantom?: boolean;
  publicKey: { toString(): string; toBase58?(): string } | null;
  isConnected: boolean;
  network?: string;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{
    publicKey: { toString(): string; toBase58?(): string };
  }>;
  disconnect(): Promise<void>;
  signTransaction(tx: unknown): Promise<unknown>;
  signAllTransactions(txs: unknown[]): Promise<unknown[]>;
  on(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
}

export interface SolanaWalletState {
  isConnected: boolean;
  address: string | null;
  publicKey: PublicKey | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  hint: string | null;
  phase: SolanaConnectionPhase;
  lastTransitionAt: number | null;
  isInstalled: boolean;
}

export type SolanaWalletErrorCode =
  | "phantom_unavailable"
  | "wallet_locked"
  | "network_mismatch"
  | "phantom_connect_failed"
  | "user_rejected";

export interface SolanaWalletLifecycleOptions {
  expectedNetwork?: "devnet" | "mainnet-beta" | "testnet";
  autoConnect?: boolean;
  targetWindow?: unknown;
}

export const INITIAL_SOLANA_WALLET_STATE: SolanaWalletState = Object.freeze({
  isConnected: false,
  address: null,
  publicKey: null,
  isLoading: false,
  error: null,
  errorCode: null,
  hint: null,
  phase: "idle",
  lastTransitionAt: null,
  isInstalled: false,
});

/**
 * Safely extract Phantom Solana provider from global window context.
 * Prefers modern window.phantom.solana over legacy window.solana.
 */
export function getPhantomProvider(
  targetWindow?: unknown
): PhantomSolanaProvider | null {
  const win =
    targetWindow ?? (typeof window !== "undefined" ? window : undefined);
  if (!win || typeof win !== "object") return null;

  const w = win as {
    phantom?: { solana?: PhantomSolanaProvider };
    solana?: PhantomSolanaProvider;
  };

  const provider = w.phantom?.solana ?? w.solana;
  return provider?.isPhantom ? provider : null;
}

/**
 * Convert any public key representation into a standard base58 string.
 */
export function formatSolanaAddress(pubkey: unknown): string | null {
  if (!pubkey) return null;
  if (typeof pubkey === "string") {
    const trimmed = pubkey.trim();
    return trimmed.length >= 32 && trimmed.length <= 44 ? trimmed : null;
  }
  if (typeof pubkey === "object") {
    const obj = pubkey as { toBase58?: () => string; toString?: () => string };
    if (typeof obj.toBase58 === "function") {
      return obj.toBase58();
    }
    if (typeof obj.toString === "function") {
      const res = obj.toString();
      return res && res !== "[object Object]" ? res : null;
    }
  }
  return null;
}

/**
 * Create a SolanaSigner delegate from a connected Phantom provider.
 */
export function createPhantomSigner(
  provider: PhantomSolanaProvider
): SolanaSigner {
  if (!provider.publicKey) {
    throw new Error(
      "Phantom provider is not connected: public key is null"
    );
  }

  const address = formatSolanaAddress(provider.publicKey);
  if (!address) {
    throw new Error("Invalid public key on Phantom provider");
  }

  const pk =
    provider.publicKey instanceof PublicKey
      ? provider.publicKey
      : new PublicKey(address);

  return {
    publicKey: pk,
    signTransaction: async (tx: Transaction): Promise<Transaction> => {
      const signed = await provider.signTransaction(tx);
      return signed as Transaction;
    },
  };
}

/**
 * Standardized manager for Phantom Solana wallet lifecycle.
 * Manages event binding, state transitions, disconnect, reconnect,
 * and account-switching without memory leaks or stale closures.
 */
export class SolanaWalletLifecycleManager {
  private state: SolanaWalletState;
  private readonly listeners = new Set<(state: SolanaWalletState) => void>();
  private readonly provider: PhantomSolanaProvider | null;
  private readonly expectedNetwork: string;
  private boundConnectHandler: ((pubkey?: unknown) => void) | null = null;
  private boundAccountChangedHandler: ((pubkey?: unknown) => void) | null = null;
  private boundDisconnectHandler: (() => void) | null = null;

  constructor(options: SolanaWalletLifecycleOptions = {}) {
    this.expectedNetwork = options.expectedNetwork ?? "devnet";
    this.provider = getPhantomProvider(options.targetWindow);

    this.state = {
      ...INITIAL_SOLANA_WALLET_STATE,
      isInstalled: Boolean(this.provider),
    };

    if (this.provider) {
      this.attachEventListeners();
      if (options.autoConnect) {
        this.reconnectSilently();
      }
    }
  }

  public getState(): SolanaWalletState {
    return this.state;
  }

  public getProvider(): PhantomSolanaProvider | null {
    return this.provider;
  }

  public subscribe(listener: (state: SolanaWalletState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private updateState(patch: Partial<SolanaWalletState>): void {
    const nextState: SolanaWalletState = {
      ...this.state,
      ...patch,
      lastTransitionAt: Date.now(),
      phase: patch.phase ?? this.state.phase,
    };
    this.state = nextState;
    for (const listener of this.listeners) {
      listener(nextState);
    }
  }

  private attachEventListeners(): void {
    if (!this.provider) return;

    this.boundConnectHandler = (pubkey?: unknown) => {
      const key = pubkey ?? this.provider?.publicKey;
      const addr = formatSolanaAddress(key);
      if (!addr) return;

      let pk: PublicKey | null = null;
      try {
        pk = new PublicKey(addr);
      } catch {
        pk = null;
      }

      this.updateState({
        isConnected: true,
        address: addr,
        publicKey: pk,
        error: null,
        errorCode: null,
        hint: null,
        phase: "connected",
        isLoading: false,
      });
    };

    this.boundAccountChangedHandler = (pubkey?: unknown) => {
      const addr = formatSolanaAddress(pubkey);
      if (!addr) {
        this.updateState({
          isConnected: false,
          address: null,
          publicKey: null,
          error: null,
          errorCode: null,
          hint: null,
          phase: "idle",
          isLoading: false,
        });
        return;
      }

      let pk: PublicKey | null = null;
      try {
        pk = new PublicKey(addr);
      } catch {
        pk = null;
      }

      this.updateState({
        isConnected: true,
        address: addr,
        publicKey: pk,
        error: null,
        errorCode: null,
        hint: null,
        phase: "connected",
        isLoading: false,
      });
    };

    this.boundDisconnectHandler = () => {
      this.updateState({
        isConnected: false,
        address: null,
        publicKey: null,
        phase: "idle",
        isLoading: false,
      });
    };

    this.provider.on("connect", this.boundConnectHandler);
    this.provider.on("accountChanged", this.boundAccountChangedHandler);
    this.provider.on("disconnect", this.boundDisconnectHandler);
  }

  public async reconnectSilently(): Promise<boolean> {
    if (!this.provider) {
      this.updateState({ isInstalled: false, phase: "idle" });
      return false;
    }

    this.updateState({ isInstalled: true, phase: "checking" });
    try {
      const resp = await this.provider.connect({ onlyIfTrusted: true });
      const addr = formatSolanaAddress(resp.publicKey);
      if (!addr) {
        this.updateState({ phase: "idle" });
        return false;
      }

      let pk: PublicKey | null = null;
      try {
        pk = new PublicKey(addr);
      } catch {
        pk = null;
      }

      this.updateState({
        isConnected: true,
        address: addr,
        publicKey: pk,
        error: null,
        errorCode: null,
        hint: null,
        phase: "connected",
      });
      return true;
    } catch {
      this.updateState({ phase: "idle" });
      return false;
    }
  }

  public async connect(): Promise<SolanaWalletState> {
    if (!this.provider) {
      this.updateState({
        phase: "error",
        error: "Phantom wallet not found. Install it at https://phantom.app",
        errorCode: "phantom_unavailable",
        hint: "Install the Phantom browser extension and reload the page.",
        isLoading: false,
      });
      return this.state;
    }

    this.updateState({
      isLoading: true,
      error: null,
      errorCode: null,
      hint: null,
      phase: "requesting_permission",
    });

    try {
      const resp = await this.provider.connect();
      const addr = formatSolanaAddress(resp.publicKey);

      const providerNetwork = this.provider.network;
      const isMismatch =
        providerNetwork &&
        providerNetwork !== this.expectedNetwork;

      if (isMismatch) {
        this.updateState({
          isConnected: false,
          address: null,
          publicKey: null,
          isLoading: false,
          phase: "error",
          errorCode: "network_mismatch",
          error: `Phantom is connected to "${providerNetwork}" but this app expects "${this.expectedNetwork}".`,
          hint: `Switch Phantom to ${this.expectedNetwork} in Settings -> Network and retry.`,
        });
        return this.state;
      }

      let pk: PublicKey | null = null;
      if (addr) {
        try {
          pk = new PublicKey(addr);
        } catch {
          pk = null;
        }
      }

      this.updateState({
        isConnected: Boolean(addr),
        address: addr,
        publicKey: pk,
        isLoading: false,
        error: null,
        errorCode: null,
        hint: null,
        phase: "connected",
      });
      return this.state;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const lc = msg.toLowerCase();

      const isLocked = lc.includes("locked");
      if (isLocked) {
        this.updateState({
          isLoading: false,
          phase: "error",
          errorCode: "wallet_locked",
          error: "Phantom is locked. Please unlock it and try again.",
          hint: "Open Phantom, enter your password to unlock, then retry.",
        });
        return this.state;
      }

      this.updateState({
        isLoading: false,
        phase: "error",
        errorCode: "phantom_connect_failed",
        error: msg || "Phantom connection failed",
        hint: "Check the Phantom popup. If you denied access, approve it and retry.",
      });
      return this.state;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.provider) {
      try {
        await this.provider.disconnect();
      } catch {
        // Disconnect failures from the provider are non-fatal for local state reset
      }
    }

    this.updateState({
      isConnected: false,
      address: null,
      publicKey: null,
      isLoading: false,
      error: null,
      errorCode: null,
      hint: null,
      phase: "idle",
    });
  }

  public destroy(): void {
    if (this.provider) {
      if (this.boundConnectHandler) {
        this.provider.removeListener("connect", this.boundConnectHandler);
      }
      if (this.boundAccountChangedHandler) {
        this.provider.removeListener(
          "accountChanged",
          this.boundAccountChangedHandler
        );
      }
      if (this.boundDisconnectHandler) {
        this.provider.removeListener("disconnect", this.boundDisconnectHandler);
      }
    }
    this.listeners.clear();
  }
}
