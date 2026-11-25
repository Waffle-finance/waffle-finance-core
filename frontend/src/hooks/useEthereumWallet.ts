/**
 * useEthereumWallet — wagmi v2 implementation (issue #470)
 *
 * Replaces the previous raw window.ethereum approach with wagmi v2 hooks:
 *   - useAccount        → address, connection status, connector
 *   - useConnect        → trigger wallet connect modal / injected connector
 *   - useDisconnect     → clean wallet disconnect
 *   - useSwitchChain    → programmatic chain switching (wallet_switchEthereumChain)
 *   - useChainId        → currently active chain ID
 *
 * The public API surface is kept intentionally compatible with the old hook so
 * call-sites in App.tsx and BridgeFormContainer.tsx require minimal changes:
 *   { isConnected, address, chainId, isLoading, error, errorCode, hint,
 *     phase, lastTransitionAt, isInstalled, connect, disconnect }
 *
 * Error codes are preserved verbatim so existing tests and UI error paths
 * continue to work without modification.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useChainId,
  useConnectors,
} from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionPhase =
  | 'idle'
  | 'checking'
  | 'requesting_permission'
  | 'connected'
  | 'error';

export interface EthereumWalletState {
  isConnected: boolean;
  address: string | null;
  /** Active chain ID as a lowercase hex string e.g. "0xaa36a7", or null. */
  chainId: string | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  hint: string | null;
  phase: ConnectionPhase;
  lastTransitionAt: number | null;
  /** True when at least one EIP-1193 injected provider (MetaMask) is detected. */
  isInstalled: boolean;
}

// ── Expected chain IDs per app network mode ───────────────────────────────────

const EXPECTED_CHAIN_IDS: Record<string, number[]> = {
  testnet: [sepolia.id],   // 11155111
  mainnet: [mainnet.id],   // 1
};

/** Convert a wagmi numeric chain ID to the canonical lowercase hex string. */
function toHexChainId(id: number): string {
  return `0x${id.toString(16)}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useEthereumWallet() {
  // ── wagmi v2 primitives ─────────────────────────────────────────────────
  const { address, isConnected, isConnecting, isReconnecting } = useAccount();
  const { connectAsync, isPending: connectPending, error: connectError } = useConnect();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { switchChainAsync, isPending: switchPending, error: switchError } = useSwitchChain();
  const activeChainId = useChainId();
  const connectors = useConnectors();

  // ── Derived state ───────────────────────────────────────────────────────
  const hexChainId = activeChainId ? toHexChainId(activeChainId) : null;

  /** True when an injected EIP-1193 provider (MetaMask) is registered with wagmi. */
  const isInstalled = useMemo(
    () => connectors.some((c) => c.type === 'injected'),
    [connectors],
  );

  // ── Local error / hint state ────────────────────────────────────────────
  // wagmi surfaces raw connector errors; we translate them into the
  // structured error codes the rest of the app already understands.
  const [localError, setLocalError] = useState<{
    message: string;
    code: string;
    hint: string;
  } | null>(null);

  // Clear local error whenever the account connects successfully.
  useEffect(() => {
    if (isConnected) {
      setLocalError(null);
    }
  }, [isConnected]);

  // Translate wagmi connect errors into structured codes.
  useEffect(() => {
    if (!connectError) return;

    const msg = connectError.message ?? '';
    const code = providerErrorCode(connectError) ?? 0;

    if (code === -32002 || msg.includes('already pending')) {
      setLocalError({
        code: 'wallet_locked',
        message: 'MetaMask is locked. Please unlock it and try again.',
        hint: 'Open MetaMask, enter your password to unlock, then retry.',
      });
    } else if (code === 4001 || msg.toLowerCase().includes('rejected')) {
      setLocalError({
        code: 'metamask_connect_failed',
        message: connectError.message ?? 'MetaMask connection failed',
        hint: 'You rejected the connection request in MetaMask.',
      });
    } else if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no provider')) {
      setLocalError({
        code: 'metamask_unavailable',
        message: 'MetaMask not found.',
        hint: 'Install MetaMask from metamask.io and reload the page.',
      });
    } else {
      setLocalError({
        code: 'metamask_connect_failed',
        message: connectError.message ?? 'MetaMask connection failed',
        hint: 'Check the MetaMask popup and try again.',
      });
    }
  }, [connectError]);

  // Translate wagmi switch-chain errors.
  useEffect(() => {
    if (!switchError) return;
    const code = providerErrorCode(switchError) ?? 0;
    if (code === 4001 || switchError.message?.toLowerCase().includes('rejected')) {
      setLocalError({
        code: 'network_mismatch',
        message: 'Network switch rejected by user.',
        hint: 'Accept the network switch request in MetaMask and try again.',
      });
    } else {
      setLocalError({
        code: 'network_mismatch',
        message: switchError.message ?? 'Network switch failed.',
        hint: 'Switch the network manually in MetaMask and try again.',
      });
    }
  }, [switchError]);

  // ── Network-mismatch detection ──────────────────────────────────────────
  // Run a network-mismatch check after a successful connection so the UI
  // surfaces an actionable error when the wallet is on the wrong chain.
  useEffect(() => {
    if (!isConnected || !activeChainId) return;

    const networkMode =
      (import.meta as any).env?.VITE_NETWORK_MODE ??
      (import.meta as any).env?.VITE_NETWORK ??
      'testnet';
    const expectedIds = EXPECTED_CHAIN_IDS[networkMode] ?? EXPECTED_CHAIN_IDS['testnet'];

    if (!expectedIds.includes(activeChainId)) {
      const expected = networkMode === 'mainnet' ? 'Ethereum Mainnet' : 'Sepolia testnet';
      setLocalError({
        code: 'network_mismatch',
        message: `MetaMask is connected to the wrong network (chain ID ${toHexChainId(activeChainId)}).`,
        hint: `Switch MetaMask to ${expected} and try again.`,
      });
    } else {
      // Chain is correct — clear any stale network-mismatch error.
      setLocalError((prev) =>
        prev?.code === 'network_mismatch' ? null : prev,
      );
    }
  }, [isConnected, activeChainId]);

  // ── Derived phase ───────────────────────────────────────────────────────
  const phase: ConnectionPhase = useMemo(() => {
    if (localError) return 'error';
    if (isConnected) return 'connected';
    if (isConnecting || isReconnecting || connectPending) return 'requesting_permission';
    if (!isInstalled) return 'idle';
    return 'idle';
  }, [localError, isConnected, isConnecting, isReconnecting, connectPending, isInstalled]);

  const isLoading = isConnecting || isReconnecting || connectPending || switchPending;

  // ── connect() ───────────────────────────────────────────────────────────
  // Prefer the injected (MetaMask) connector; fall back to the first available.
  const connect_ = useCallback(async (): Promise<boolean> => {
    setLocalError(null);

    if (!isInstalled) {
      setLocalError({
        code: 'metamask_unavailable',
        message: 'MetaMask not found.',
        hint: 'Install MetaMask from metamask.io and reload the page.',
      });
      return false;
    }

    const injected = connectors.find((c) => c.type === 'injected') ?? connectors[0];
    if (!injected) {
      setLocalError({
        code: 'metamask_unavailable',
        message: 'No wallet connector found.',
        hint: 'Install MetaMask and reload.',
      });
      return false;
    }

    try {
      await connectAsync({ connector: injected });
      return true;
    } catch (err: unknown) {
      // Wagmi rejects connectAsync for connector errors; retain its message
      // here so callers waiting on connect() see the same failure promptly.
      const code = providerErrorCode(err);
      const message = err instanceof Error ? err.message : 'MetaMask connection failed';
      if (code === -32002 || message.toLowerCase().includes('already pending')) {
        setLocalError({
          code: 'wallet_locked',
          message: 'MetaMask is locked. Please unlock it and try again.',
          hint: 'Open MetaMask, enter your password to unlock, then retry.',
        });
      } else if (code === 4001 || message.toLowerCase().includes('rejected')) {
        setLocalError({
          code: 'metamask_connect_failed',
          message,
          hint: 'You rejected the connection request in MetaMask.',
        });
      } else if (message.toLowerCase().includes('not found') || message.toLowerCase().includes('no provider')) {
        setLocalError({
          code: 'metamask_unavailable',
          message: 'MetaMask not found.',
          hint: 'Install MetaMask from metamask.io and reload the page.',
        });
      } else {
        setLocalError({
          code: 'metamask_connect_failed',
          message,
          hint: 'Check the MetaMask popup and try again.',
        });
      }
      return false;
    }
  }, [connectAsync, connectors, isInstalled]);

  // ── disconnect() ────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    setLocalError(null);
    wagmiDisconnect();
  }, [wagmiDisconnect]);

  // ── switchToExpectedChain() ─────────────────────────────────────────────
  // Exposed so callers (e.g. BridgeFormContainer) can programmatically
  // request a chain switch without triggering a full reconnect.
  const switchToExpectedChain = useCallback(
    async (networkMode: 'mainnet' | 'testnet' = 'testnet') => {
      const targetId = networkMode === 'mainnet' ? mainnet.id : sepolia.id;
      await switchChainAsync({ chainId: targetId });
    },
    [switchChainAsync],
  );

  // ── Return ──────────────────────────────────────────────────────────────
  return {
    // State
    isConnected,
    address: address ?? null,
    chainId: hexChainId,
    isLoading,
    error: localError?.message ?? null,
    errorCode: localError?.code ?? null,
    hint: localError?.hint ?? null,
    phase,
    lastTransitionAt: null, // retained for API compat; wagmi manages its own timestamps
    isInstalled,
    // Actions
    connect: connect_,
    disconnect,
    switchToExpectedChain,
  };
}

function providerErrorCode(error: unknown): number | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'number') return value.code;
    current = value.cause;
  }
  return undefined;
}
