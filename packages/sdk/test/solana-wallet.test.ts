import { describe, it, expect, vi } from "vitest";
import { PublicKey, Transaction } from "@solana/web3.js";

import {
  getPhantomProvider,
  formatSolanaAddress,
  createPhantomSigner,
  SolanaWalletLifecycleManager,
  type PhantomSolanaProvider,
} from "../src/solana/wallet.js";

type Handler = (...args: unknown[]) => void;

function createMockPhantom(pubkeyStr = "SoL11111111111111111111111111111111111111112") {
  const handlers: Record<string, Handler[]> = {};
  const provider: PhantomSolanaProvider & { emit: (event: string, ...args: unknown[]) => void } = {
    isPhantom: true,
    publicKey: { toString: () => pubkeyStr, toBase58: () => pubkeyStr },
    isConnected: true,
    network: "devnet",
    connect: vi.fn(async () => ({
      publicKey: { toString: () => pubkeyStr, toBase58: () => pubkeyStr },
    })),
    disconnect: vi.fn(async () => {}),
    signTransaction: vi.fn(async (tx: unknown) => tx),
    signAllTransactions: vi.fn(async (txs: unknown[]) => txs),
    on: vi.fn((event: string, handler: Handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      if (!handlers[event]) return;
      handlers[event] = handlers[event].filter((h) => h !== handler);
    }),
    emit: (event: string, ...args: unknown[]) => {
      const list = handlers[event] ?? [];
      for (const fn of list) {
        fn(...args);
      }
    },
  };
  return provider;
}

describe("Solana wallet - getPhantomProvider", () => {
  it("returns null when window or provider is absent", () => {
    expect(getPhantomProvider(undefined)).toBeNull();
    expect(getPhantomProvider({})).toBeNull();
  });

  it("extracts window.phantom.solana preferentially", () => {
    const phantomSolana = createMockPhantom("SoLPhantomPref");
    const legacySolana = createMockPhantom("SoLLegacy");
    const mockWindow = {
      phantom: { solana: phantomSolana },
      solana: legacySolana,
    };
    const provider = getPhantomProvider(mockWindow);
    expect(provider).toBe(phantomSolana);
  });

  it("falls back to window.solana when phantom.solana is absent", () => {
    const legacySolana = createMockPhantom("SoLLegacyOnly");
    const mockWindow = {
      solana: legacySolana,
    };
    const provider = getPhantomProvider(mockWindow);
    expect(provider).toBe(legacySolana);
  });

  it("rejects provider when isPhantom is false", () => {
    const notPhantom = { ...createMockPhantom(), isPhantom: false };
    const mockWindow = { solana: notPhantom };
    expect(getPhantomProvider(mockWindow)).toBeNull();
  });
});

describe("Solana wallet - formatSolanaAddress", () => {
  it("formats valid base58 strings", () => {
    const addr = "SoL11111111111111111111111111111111111111112";
    expect(formatSolanaAddress(addr)).toBe(addr);
  });

  it("formats PublicKey with toBase58", () => {
    const addr = "SoL11111111111111111111111111111111111111112";
    const pk = { toBase58: () => addr };
    expect(formatSolanaAddress(pk)).toBe(addr);
  });

  it("formats PublicKey with toString", () => {
    const addr = "SoL11111111111111111111111111111111111111112";
    const pk = { toString: () => addr };
    expect(formatSolanaAddress(pk)).toBe(addr);
  });

  it("returns null for empty or invalid values", () => {
    expect(formatSolanaAddress(null)).toBeNull();
    expect(formatSolanaAddress(undefined)).toBeNull();
    expect(formatSolanaAddress("")).toBeNull();
    expect(formatSolanaAddress("short")).toBeNull();
  });
});

describe("Solana wallet - createPhantomSigner", () => {
  it("creates a valid SolanaSigner when connected", async () => {
    const provider = createMockPhantom("SoL11111111111111111111111111111111111111112");
    const signer = createPhantomSigner(provider);

    expect(signer.publicKey).toBeInstanceOf(PublicKey);
    expect(signer.publicKey.toBase58()).toBe("SoL11111111111111111111111111111111111111112");

    const mockTx = new Transaction();
    await signer.signTransaction(mockTx);
    expect(provider.signTransaction).toHaveBeenCalledWith(mockTx);
  });

  it("throws when provider has no publicKey", () => {
    const provider = createMockPhantom();
    provider.publicKey = null;
    expect(() => createPhantomSigner(provider)).toThrow(/not connected/);
  });
});

describe("Solana wallet - SolanaWalletLifecycleManager", () => {
  it("initializes with disconnected state when provider absent", () => {
    const manager = new SolanaWalletLifecycleManager({ targetWindow: {} });
    expect(manager.getState().isConnected).toBe(false);
    expect(manager.getState().isInstalled).toBe(false);
    expect(manager.getState().phase).toBe("idle");
  });

  it("connects and exposes address when provider is available", async () => {
    const provider = createMockPhantom("SoLUser111111111111111111111111111111111111");
    const manager = new SolanaWalletLifecycleManager({
      targetWindow: { phantom: { solana: provider } },
      expectedNetwork: "devnet",
    });

    const state = await manager.connect();
    expect(state.isConnected).toBe(true);
    expect(state.address).toBe("SoLUser111111111111111111111111111111111111");
    expect(state.phase).toBe("connected");
  });

  it("handles disconnect and subsequent reconnect cleanly", async () => {
    const provider = createMockPhantom("SoLUserReconnect111111111111111111111111111");
    const manager = new SolanaWalletLifecycleManager({
      targetWindow: { phantom: { solana: provider } },
      expectedNetwork: "devnet",
    });

    await manager.connect();
    expect(manager.getState().isConnected).toBe(true);

    await manager.disconnect();
    expect(manager.getState().isConnected).toBe(false);
    expect(manager.getState().address).toBeNull();
    expect(manager.getState().phase).toBe("idle");

    await manager.connect();
    expect(manager.getState().isConnected).toBe(true);
    expect(manager.getState().address).toBe("SoLUserReconnect111111111111111111111111111");
    expect(manager.getState().phase).toBe("connected");
  });

  it("updates address on accountChanged event and resets on null", () => {
    const provider = createMockPhantom("SoLInitialAccount11111111111111111111111111");
    const manager = new SolanaWalletLifecycleManager({
      targetWindow: { phantom: { solana: provider } },
    });

    const nextAccount = "SoLSwitchedAccount2222222222222222222222222";
    provider.emit("accountChanged", { toString: () => nextAccount });

    expect(manager.getState().isConnected).toBe(true);
    expect(manager.getState().address).toBe(nextAccount);
    expect(manager.getState().phase).toBe("connected");

    provider.emit("accountChanged", null);
    expect(manager.getState().isConnected).toBe(false);
    expect(manager.getState().address).toBeNull();
    expect(manager.getState().phase).toBe("idle");
  });

  it("cleans up event listeners when destroyed", () => {
    const provider = createMockPhantom();
    const manager = new SolanaWalletLifecycleManager({
      targetWindow: { phantom: { solana: provider } },
    });

    manager.destroy();
    expect(provider.removeListener).toHaveBeenCalledWith("connect", expect.any(Function));
    expect(provider.removeListener).toHaveBeenCalledWith("accountChanged", expect.any(Function));
    expect(provider.removeListener).toHaveBeenCalledWith("disconnect", expect.any(Function));
  });

  it("detects network mismatch", async () => {
    const provider = createMockPhantom();
    provider.network = "mainnet-beta";
    const manager = new SolanaWalletLifecycleManager({
      targetWindow: { phantom: { solana: provider } },
      expectedNetwork: "devnet",
    });

    const state = await manager.connect();
    expect(state.isConnected).toBe(false);
    expect(state.errorCode).toBe("network_mismatch");
    expect(state.phase).toBe("error");
  });

  it("detects wallet locked error", async () => {
    const provider = createMockPhantom();
    provider.connect = vi.fn(async () => {
      throw new Error("Wallet is locked");
    });
    const manager = new SolanaWalletLifecycleManager({
      targetWindow: { phantom: { solana: provider } },
    });

    const state = await manager.connect();
    expect(state.isConnected).toBe(false);
    expect(state.errorCode).toBe("wallet_locked");
    expect(state.phase).toBe("error");
  });
});
