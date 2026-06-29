/**
 * walletCompat.ts
 *
 * Shared utility for browser wallet extension compatibility.
 *
 * Problems solved:
 *  1. Multiple EIP-1193 providers may be injected simultaneously (e.g. MetaMask
 *     + Coinbase Wallet both running). Some environments expose them via
 *     `window.ethereum.providers[]`.
 *  2. Different provider implementations support different RPC methods.
 *  3. Some providers don't implement `removeListener`, causing runtime errors.
 *  4. Solana wallets beyond Phantom (Solflare, Backpack) need detection.
 *
 * This module is pure (no React, no side-effects) so every function is
 * straightforward to unit-test.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal EIP-1193 provider shape. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  // Provider-identity flags injected by various extensions
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  isRainbow?: boolean;
  isTrust?: boolean;
  isOkxWallet?: boolean;
  // Multi-provider array (present when several extensions coexist)
  providers?: Eip1193Provider[];
}

export interface DetectedEthProvider {
  provider: Eip1193Provider;
  /** Human-readable wallet name inferred from provider flags. */
  walletName: string;
}

/** Minimal Solana wallet provider shape. */
export interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey: { toString(): string } | null;
  isConnected: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signTransaction(tx: unknown): Promise<unknown>;
  signAllTransactions(txs: unknown[]): Promise<unknown[]>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface DetectedSolanaProvider {
  provider: SolanaProvider;
  /** Human-readable wallet name inferred from provider flags. */
  walletName: string;
}

export interface EthCapabilities {
  /** Provider supports `wallet_switchEthereumChain`. */
  supportsChainSwitch: boolean;
  /** Provider supports `wallet_watchAsset`. */
  supportsWatchAsset: boolean;
  /** Provider exposes a working `removeListener` method. */
  supportsRemoveListener: boolean;
}

// ---------------------------------------------------------------------------
// Ethereum / EIP-1193
// ---------------------------------------------------------------------------

/**
 * Infer a human-readable name from provider identity flags.
 */
export function getEthWalletName(provider: Eip1193Provider): string {
  if (provider.isBraveWallet)    return 'Brave Wallet';
  if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider.isRainbow)        return 'Rainbow';
  if (provider.isTrust)          return 'Trust Wallet';
  if (provider.isOkxWallet)      return 'OKX Wallet';
  if (provider.isMetaMask)       return 'MetaMask';
  return 'Ethereum Wallet';
}

/**
 * Select the "best" EIP-1193 provider from the set of candidates.
 *
 * Priority order (opinionated, most-user-expected first):
 *   MetaMask > Coinbase > Brave > Rainbow > Trust > OKX > first available
 *
 * When multiple extensions are installed, browsers (e.g. Chrome with MetaMask +
 * Coinbase) merge providers into `window.ethereum.providers[]`.
 */
export function pickBestEthProvider(candidates: Eip1193Provider[]): Eip1193Provider {
  const order: Array<keyof Eip1193Provider> = [
    'isMetaMask',
    'isCoinbaseWallet',
    'isBraveWallet',
    'isRainbow',
    'isTrust',
    'isOkxWallet',
  ];
  for (const flag of order) {
    const match = candidates.find((p) => !!p[flag]);
    if (match) return match;
  }
  return candidates[0];
}

/**
 * Detect the best available EIP-1193 provider from `window.ethereum`.
 *
 * Returns `null` when no Ethereum wallet extension is present.
 */
export function detectEthereumProvider(): DetectedEthProvider | null {
  if (typeof window === 'undefined') return null;

  const raw = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!raw || typeof raw.request !== 'function') return null;

  // Some environments expose multiple injected providers as an array.
  const candidates: Eip1193Provider[] =
    Array.isArray(raw.providers) && raw.providers.length > 0
      ? raw.providers
      : [raw];

  const provider = pickBestEthProvider(candidates);
  return { provider, walletName: getEthWalletName(provider) };
}

/**
 * Probe which optional RPC/provider capabilities are available without
 * actually sending a user-visible request.
 *
 * All probes are purely structural — we check for API existence, not
 * actually call the methods.
 */
export function probeEthCapabilities(provider: Eip1193Provider): EthCapabilities {
  // `wallet_switchEthereumChain` is not universally supported (e.g. some
  // read-only providers or very old extensions). We can't truly know without
  // calling it, so we check for a few known non-supporting flags.
  const supportsChainSwitch =
    typeof provider.request === 'function' &&
    // Brave Wallet before ~2022 didn't implement wallet_switchEthereumChain
    !((provider as { _isBraveWalletLegacy?: boolean })._isBraveWalletLegacy);

  const supportsWatchAsset = typeof provider.request === 'function';

  const supportsRemoveListener = typeof provider.removeListener === 'function';

  return { supportsChainSwitch, supportsWatchAsset, supportsRemoveListener };
}

/**
 * Safely attach a provider event listener.
 */
export function safeAddListener(
  provider: Eip1193Provider,
  event: string,
  handler: (...args: unknown[]) => void,
): void {
  try {
    provider.on?.(event, handler);
  } catch {
    // Some providers throw on unknown events — ignore.
  }
}

/**
 * Safely remove a provider event listener, guarding against providers that
 * don't implement `removeListener` (e.g. Brave built-in wallet < v1.55).
 */
export function safeRemoveListener(
  provider: Eip1193Provider,
  event: string,
  handler: (...args: unknown[]) => void,
): void {
  try {
    provider.removeListener?.(event, handler);
  } catch {
    // Ignore — the listener simply won't be cleaned up in degraded mode.
  }
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

/**
 * Infer a human-readable name from a Solana provider's identity flags.
 */
export function getSolanaWalletName(provider: SolanaProvider): string {
  if (provider.isSolflare) return 'Solflare';
  if (provider.isBackpack) return 'Backpack';
  if (provider.isPhantom)  return 'Phantom';
  return 'Solana Wallet';
}

/**
 * Detect the best available Solana provider.
 *
 * Check order:
 *   1. `window.phantom.solana`   (Phantom — namespaced, preferred)
 *   2. `window.solflare`         (Solflare)
 *   3. `window.backpack`         (Backpack)
 *   4. `window.solana`           (generic / Phantom legacy)
 *
 * Returns `null` when no Solana wallet extension is installed.
 */
export function detectSolanaProvider(): DetectedSolanaProvider | null {
  if (typeof window === 'undefined') return null;

  const w = window as unknown as {
    phantom?: { solana?: SolanaProvider };
    solflare?: SolanaProvider;
    backpack?: SolanaProvider;
    solana?: SolanaProvider;
  };

  const candidates: Array<SolanaProvider | undefined> = [
    w.phantom?.solana,
    w.solflare,
    w.backpack,
    w.solana,
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate.connect === 'function' &&
      typeof candidate.on === 'function'
    ) {
      return { provider: candidate, walletName: getSolanaWalletName(candidate) };
    }
  }

  return null;
}

/**
 * Safely remove a Solana provider event listener.
 */
export function safeRemoveSolanaListener(
  provider: SolanaProvider,
  event: string,
  handler: (...args: unknown[]) => void,
): void {
  try {
    provider.removeListener?.(event, handler);
  } catch {
    // Ignore.
  }
}
