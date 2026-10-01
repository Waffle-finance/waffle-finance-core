/**
 * WalletStateBanner — Centralized wallet-state UX (issue #771)
 *
 * Surfaces actionable banners for:
 *   1. Chain mismatch (wallet on wrong network)
 *   2. Disconnected wallet (session lost / locked)
 *   3. Account switch detected mid-session
 *
 * One banner per wallet type (MetaMask / Freighter / Phantom) stacked
 * vertically; each banner has a clear action button so the user knows
 * exactly what to do. Transaction submission in BridgeForm is blocked
 * while any wallet is in a mismatch or disconnected state — this component
 * provides the isWalletActionRequired() export for that gate.
 *
 * Usage (in App.tsx):
 * ```tsx
 * import WalletStateBanner, { useWalletState } from './WalletStateBanner';
 *
 * const walletState = useWalletState({ ethWallet, freighterState, solanaWallet });
 * <WalletStateBanner walletState={walletState} />
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, LogOut, RefreshCw, Wifi, WifiOff } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WalletBannerKind =
  | 'chain_mismatch'
  | 'disconnected'
  | 'account_switched'
  | 'wallet_locked';

export interface WalletBannerEntry {
  id: string;
  wallet: 'ethereum' | 'stellar' | 'solana';
  kind: WalletBannerKind;
  message: string;
  hint: string;
  /** Called when the user clicks the primary action button. */
  onAction?: () => void | Promise<void>;
  actionLabel?: string;
}

export interface WalletStateResult {
  banners: WalletBannerEntry[];
  /** True when any wallet condition blocks transaction submission. */
  isBlocked: boolean;
  /** Dismiss a specific banner by id (e.g. after user manually fixed it). */
  dismiss(id: string): void;
}

// ── Wallet state inputs ───────────────────────────────────────────────────────

interface EthWalletLike {
  isConnected: boolean;
  address: string | null;
  errorCode: string | null;
  error: string | null;
  hint: string | null;
  phase: string;
  switchToExpectedChain?: (mode?: 'mainnet' | 'testnet') => void;
  connect?: () => void | Promise<void>;
}

interface FreighterStateLike {
  isConnected: boolean;
  address: string | null;
  errorCode: string | null;
  error: string | null;
  hint: string | null;
  phase: string;
  connect?: () => void | Promise<void>;
}

interface SolanaWalletLike {
  isConnected: boolean;
  address: string | null;
  errorCode: string | null;
  error: string | null;
  hint: string | null;
  phase: string;
  connect?: () => void | Promise<void>;
}

interface UseWalletStateOptions {
  ethWallet: EthWalletLike;
  freighterState: FreighterStateLike;
  solanaWallet: SolanaWalletLike;
  networkMode?: 'testnet' | 'mainnet';
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWalletState({
  ethWallet,
  freighterState,
  solanaWallet,
  networkMode = 'testnet',
}: UseWalletStateOptions): WalletStateResult {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const prevEthAddress = useRef<string | null>(null);
  const prevStellarAddress = useRef<string | null>(null);
  const prevSolanaAddress = useRef<string | null>(null);

  // Track account switches mid-session
  const [accountSwitches, setAccountSwitches] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Ethereum account switch
    if (
      ethWallet.isConnected &&
      ethWallet.address &&
      prevEthAddress.current &&
      prevEthAddress.current !== ethWallet.address
    ) {
      setAccountSwitches((s) => new Set(s).add('eth_switched'));
    }
    if (ethWallet.address) prevEthAddress.current = ethWallet.address;
  }, [ethWallet.isConnected, ethWallet.address]);

  useEffect(() => {
    // Stellar account switch
    if (
      freighterState.isConnected &&
      freighterState.address &&
      prevStellarAddress.current &&
      prevStellarAddress.current !== freighterState.address
    ) {
      setAccountSwitches((s) => new Set(s).add('stellar_switched'));
    }
    if (freighterState.address) prevStellarAddress.current = freighterState.address;
  }, [freighterState.isConnected, freighterState.address]);

  useEffect(() => {
    // Solana account switch
    if (
      solanaWallet.isConnected &&
      solanaWallet.address &&
      prevSolanaAddress.current &&
      prevSolanaAddress.current !== solanaWallet.address
    ) {
      setAccountSwitches((s) => new Set(s).add('solana_switched'));
    }
    if (solanaWallet.address) prevSolanaAddress.current = solanaWallet.address;
  }, [solanaWallet.isConnected, solanaWallet.address]);

  // Clear account-switch banner once addresses settle (user accepted the switch)
  useEffect(() => {
    if (!accountSwitches.has('eth_switched')) return;
    const t = window.setTimeout(
      () => setAccountSwitches((s) => { const n = new Set(s); n.delete('eth_switched'); return n; }),
      8_000
    );
    return () => window.clearTimeout(t);
  }, [accountSwitches]);
  useEffect(() => {
    if (!accountSwitches.has('stellar_switched')) return;
    const t = window.setTimeout(
      () => setAccountSwitches((s) => { const n = new Set(s); n.delete('stellar_switched'); return n; }),
      8_000
    );
    return () => window.clearTimeout(t);
  }, [accountSwitches]);
  useEffect(() => {
    if (!accountSwitches.has('solana_switched')) return;
    const t = window.setTimeout(
      () => setAccountSwitches((s) => { const n = new Set(s); n.delete('solana_switched'); return n; }),
      8_000
    );
    return () => window.clearTimeout(t);
  }, [accountSwitches]);

  const dismiss = useCallback((id: string) => {
    setDismissed((d) => new Set(d).add(id));
  }, []);

  // Build banner list
  const banners: WalletBannerEntry[] = [];

  // ── Ethereum ───────────────────────────────────────────────────────────────

  const ethCode = ethWallet.errorCode;

  if (ethCode === 'network_mismatch' && !dismissed.has('eth_mismatch')) {
    const expectedNet = networkMode === 'mainnet' ? 'Ethereum Mainnet' : 'Sepolia Testnet';
    banners.push({
      id: 'eth_mismatch',
      wallet: 'ethereum',
      kind: 'chain_mismatch',
      message: `MetaMask is on the wrong network — switch to ${expectedNet}.`,
      hint: ethWallet.hint ?? `Open MetaMask and switch to ${expectedNet}.`,
      actionLabel: `Switch to ${expectedNet}`,
      onAction: () => ethWallet.switchToExpectedChain?.(networkMode),
    });
  }

  if (
    (ethCode === 'wallet_locked' || ethCode === 'metamask_unavailable') &&
    !dismissed.has('eth_locked')
  ) {
    banners.push({
      id: 'eth_locked',
      wallet: 'ethereum',
      kind: 'wallet_locked',
      message: ethWallet.error ?? 'MetaMask is locked or unavailable.',
      hint: ethWallet.hint ?? 'Unlock MetaMask and reconnect.',
      actionLabel: 'Reconnect',
      onAction: () => ethWallet.connect?.(),
    });
  }

  if (
    ethCode === 'metamask_connect_failed' &&
    !dismissed.has('eth_connect_failed')
  ) {
    banners.push({
      id: 'eth_connect_failed',
      wallet: 'ethereum',
      kind: 'disconnected',
      message: ethWallet.error ?? 'MetaMask connection failed.',
      hint: ethWallet.hint ?? 'Check MetaMask and try again.',
      actionLabel: 'Retry',
      onAction: () => ethWallet.connect?.(),
    });
  }

  if (accountSwitches.has('eth_switched') && !dismissed.has('eth_switched')) {
    banners.push({
      id: 'eth_switched',
      wallet: 'ethereum',
      kind: 'account_switched',
      message: 'MetaMask account changed mid-session.',
      hint: 'Verify you are using the correct Ethereum address before submitting transactions.',
      actionLabel: 'Got it',
      onAction: () => setAccountSwitches((s) => { const n = new Set(s); n.delete('eth_switched'); return n; }),
    });
  }

  // ── Stellar / Freighter ────────────────────────────────────────────────────

  const stellarCode = freighterState.errorCode;

  if (stellarCode === 'network_mismatch' && !dismissed.has('stellar_mismatch')) {
    const expectedNet = networkMode === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet';
    banners.push({
      id: 'stellar_mismatch',
      wallet: 'stellar',
      kind: 'chain_mismatch',
      message: `Freighter is on the wrong network — switch to ${expectedNet}.`,
      hint: freighterState.hint ?? `Open Freighter → Settings → Network and switch to ${expectedNet}.`,
      actionLabel: 'How to fix',
    });
  }

  if (
    (stellarCode === 'wallet_locked' || stellarCode === 'freighter_unavailable') &&
    !dismissed.has('stellar_locked')
  ) {
    banners.push({
      id: 'stellar_locked',
      wallet: 'stellar',
      kind: 'wallet_locked',
      message: freighterState.error ?? 'Freighter is locked or unavailable.',
      hint: freighterState.hint ?? 'Unlock Freighter and reconnect.',
      actionLabel: 'Reconnect',
      onAction: () => freighterState.connect?.(),
    });
  }

  if (accountSwitches.has('stellar_switched') && !dismissed.has('stellar_switched')) {
    banners.push({
      id: 'stellar_switched',
      wallet: 'stellar',
      kind: 'account_switched',
      message: 'Freighter account changed mid-session.',
      hint: 'Verify you are using the correct Stellar address before submitting transactions.',
      actionLabel: 'Got it',
      onAction: () => setAccountSwitches((s) => { const n = new Set(s); n.delete('stellar_switched'); return n; }),
    });
  }

  // ── Solana / Phantom ───────────────────────────────────────────────────────

  const solanaCode = solanaWallet.errorCode;

  if (solanaCode === 'network_mismatch' && !dismissed.has('solana_mismatch')) {
    const expectedNet = networkMode === 'mainnet' ? 'mainnet-beta' : 'devnet';
    banners.push({
      id: 'solana_mismatch',
      wallet: 'solana',
      kind: 'chain_mismatch',
      message: `Phantom is on the wrong network — switch to Solana ${expectedNet}.`,
      hint: solanaWallet.hint ?? `Open Phantom → Settings → Network → ${expectedNet}.`,
      actionLabel: 'How to fix',
    });
  }

  if (
    (solanaCode === 'wallet_locked' || solanaCode === 'phantom_unavailable') &&
    !dismissed.has('solana_locked')
  ) {
    banners.push({
      id: 'solana_locked',
      wallet: 'solana',
      kind: 'wallet_locked',
      message: solanaWallet.error ?? 'Phantom is locked or unavailable.',
      hint: solanaWallet.hint ?? 'Unlock Phantom and reconnect.',
      actionLabel: 'Reconnect',
      onAction: () => solanaWallet.connect?.(),
    });
  }

  if (accountSwitches.has('solana_switched') && !dismissed.has('solana_switched')) {
    banners.push({
      id: 'solana_switched',
      wallet: 'solana',
      kind: 'account_switched',
      message: 'Phantom account changed mid-session.',
      hint: 'Verify you are using the correct Solana address before submitting transactions.',
      actionLabel: 'Got it',
      onAction: () => setAccountSwitches((s) => { const n = new Set(s); n.delete('solana_switched'); return n; }),
    });
  }

  // Filter dismissed
  const visible = banners.filter((b) => !dismissed.has(b.id));

  const isBlocked = visible.some(
    (b) => b.kind === 'chain_mismatch' || b.kind === 'wallet_locked'
  );

  return { banners: visible, isBlocked, dismiss };
}

// ── Banner kind metadata ──────────────────────────────────────────────────────

const KIND_META: Record<WalletBannerKind, { icon: typeof AlertTriangle; colorClass: string; borderClass: string; iconClass: string }> = {
  chain_mismatch: {
    icon: AlertTriangle,
    colorClass: 'bg-amber-500/12',
    borderClass: 'border-amber-400/35',
    iconClass: 'text-amber-400',
  },
  disconnected: {
    icon: WifiOff,
    colorClass: 'bg-red-500/10',
    borderClass: 'border-red-400/30',
    iconClass: 'text-red-400',
  },
  wallet_locked: {
    icon: LogOut,
    colorClass: 'bg-red-500/10',
    borderClass: 'border-red-400/30',
    iconClass: 'text-red-400',
  },
  account_switched: {
    icon: RefreshCw,
    colorClass: 'bg-sky-500/10',
    borderClass: 'border-sky-400/30',
    iconClass: 'text-sky-400',
  },
};

const WALLET_LABEL: Record<WalletBannerEntry['wallet'], string> = {
  ethereum: 'MetaMask',
  stellar: 'Freighter',
  solana: 'Phantom',
};

// ── Component ─────────────────────────────────────────────────────────────────

interface WalletStateBannerProps {
  walletState: WalletStateResult;
}

export default function WalletStateBanner({ walletState }: WalletStateBannerProps) {
  const { banners, dismiss } = walletState;

  if (banners.length === 0) return null;

  return (
    <div
      className="w-full flex flex-col gap-0"
      role="region"
      aria-label="Wallet state notifications"
    >
      {banners.map((banner) => {
        const meta = KIND_META[banner.kind];
        const Icon = meta.icon;
        const walletLabel = WALLET_LABEL[banner.wallet];

        return (
          <div
            key={banner.id}
            role="alert"
            aria-live="polite"
            className={`w-full ${meta.colorClass} border-y ${meta.borderClass} px-4 py-2.5 flex items-start md:items-center justify-between gap-3`}
          >
            {/* Left — icon + text */}
            <div className="flex items-start md:items-center gap-2.5 flex-1 min-w-0">
              <Icon
                className={`h-4 w-4 shrink-0 mt-0.5 md:mt-0 ${meta.iconClass}`}
                aria-hidden="true"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold text-white leading-snug">
                  <span className="text-slate-400 font-normal mr-1.5">{walletLabel}</span>
                  {banner.message}
                </span>
                {banner.hint && (
                  <span className="text-xs text-slate-400 mt-0.5 truncate md:whitespace-normal">
                    {banner.hint}
                  </span>
                )}
              </div>
            </div>

            {/* Right — action + dismiss */}
            <div className="flex items-center gap-1.5 shrink-0">
              {banner.onAction && banner.actionLabel && (
                <button
                  type="button"
                  onClick={() => {
                    banner.onAction?.();
                  }}
                  className={`text-xs font-semibold px-3 py-1 rounded-full border transition-colors
                    ${meta.borderClass} bg-white/5 hover:bg-white/10 text-white`}
                >
                  {banner.actionLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(banner.id)}
                aria-label="Dismiss notification"
                className="h-6 w-6 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Guard helper (for BridgeForm) ─────────────────────────────────────────────

/**
 * Returns true when any wallet condition should block transaction submission.
 * Import this in BridgeForm to gate the submit button.
 *
 * @example
 * const walletState = useWalletState({ ethWallet, freighterState, solanaWallet });
 * const canSubmit = !walletState.isBlocked;
 */
export { type WalletStateResult };
