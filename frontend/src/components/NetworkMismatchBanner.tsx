import { useState } from 'react';
import type { NetworkModeState } from '../lib/useNetworkMode';
import { getNetworkConfigForMode, isMainnetEnabled } from '../config/networks';

interface Props {
  networkState: NetworkModeState;
}

const MODE_LABEL: Record<'testnet' | 'mainnet', string> = {
  testnet: 'Testnet',
  mainnet: 'Mainnet',
};

const MAINNET_CONFIG = getNetworkConfigForMode('mainnet');
const TESTNET_CONFIG = getNetworkConfigForMode('testnet');

const ETH_MODE_FROM_CHAIN: Record<string, string> = {
  [`0x${BigInt(MAINNET_CONFIG.ethereum.id).toString(16)}`]: MAINNET_CONFIG.ethereum.displayName,
  [`0x${BigInt(TESTNET_CONFIG.ethereum.id).toString(16)}`]: TESTNET_CONFIG.ethereum.displayName,
};

function describeMetamaskChain(chainId: string | null): string {
  if (!chainId) return 'unknown';
  const key = chainId.toLowerCase();
  return ETH_MODE_FROM_CHAIN[key] || `chain ${chainId}`;
}

function describeFreighterNetwork(passphrase: string | null): string {
  if (!passphrase) return 'unknown';
  if (passphrase === MAINNET_CONFIG.stellar.networkPassphrase) {
    return MAINNET_CONFIG.stellar.displayName;
  }
  if (passphrase === TESTNET_CONFIG.stellar.networkPassphrase) {
    return TESTNET_CONFIG.stellar.displayName;
  }
  return passphrase;
}

function isMainnetWallet(metamaskChainId: string | null, freighterNetworkPassphrase: string | null): boolean {
  const mainnetChainId = `0x${BigInt(MAINNET_CONFIG.ethereum.id).toString(16)}`;
  return (
    metamaskChainId?.toLowerCase() === mainnetChainId ||
    freighterNetworkPassphrase === MAINNET_CONFIG.stellar.networkPassphrase
  );
}

export default function NetworkMismatchBanner({ networkState }: Props) {
  const [busy, setBusy] = useState(false);
  const {
    mode,
    metamaskConnected,
    metamaskMatches,
    metamaskChainId,
    freighterConnected,
    freighterMatches,
    freighterNetworkPassphrase,
    hasAnyMismatch,
    setMode,
    syncWalletsToAppMode,
    refreshWalletNetworks,
  } = networkState;

  if (!hasAnyMismatch) {
    return null;
  }

  const expectedLabel = MODE_LABEL[mode];
  const metamaskActual = describeMetamaskChain(metamaskChainId);
  const freighterActual = describeFreighterNetwork(freighterNetworkPassphrase);

  const walletWantsMainnet =
    (metamaskConnected &&
      !metamaskMatches &&
      isMainnetWallet(metamaskChainId, null)) ||
    (freighterConnected &&
      !freighterMatches &&
      isMainnetWallet(null, freighterNetworkPassphrase));

  const showSwitchAppToWallet = isMainnetEnabled() || !walletWantsMainnet;

  const onSwitchAppToWallet = async () => {
    setBusy(true);
    try {
      const nextMode: 'testnet' | 'mainnet' =
        metamaskConnected && !metamaskMatches
          ? isMainnetWallet(metamaskChainId, null)
            ? 'mainnet'
            : 'testnet'
          : freighterConnected && !freighterMatches
            ? isMainnetWallet(null, freighterNetworkPassphrase)
              ? 'mainnet'
              : 'testnet'
            : mode;
      if (nextMode !== mode) {
        await setMode(nextMode);
      } else {
        refreshWalletNetworks();
      }
    } finally {
      setBusy(false);
    }
  };

  const onSwitchWalletToApp = async () => {
    setBusy(true);
    try {
      await syncWalletsToAppMode();
      refreshWalletNetworks();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-amber-500/15 border-y border-amber-400/40 text-amber-100 px-6 py-3 flex flex-col md:flex-row items-start md:items-center gap-3 justify-between">
      <div className="flex items-start gap-3 text-sm">
        <span className="mt-0.5">⚠</span>
        <div>
          <div className="font-semibold">
            Your wallet network does not match the app network.
          </div>
          <div className="text-amber-200/90">
            App is set to <b>{expectedLabel}</b>.{' '}
            {metamaskConnected && !metamaskMatches && (
              <span>
                Ethereum wallet is on <b>{metamaskActual}</b>
                {metamaskChainId ? ` (${metamaskChainId})` : ''}.{' '}
              </span>
            )}
            {freighterConnected && !freighterMatches && (
              <span>
                Freighter is on <b>{freighterActual}</b>.{' '}
              </span>
            )}
            {freighterConnected && !freighterMatches && (
              <span className="block mt-1 text-amber-200/75">
                Switch Freighter to <b>{getNetworkConfigForMode(mode).stellar.displayName}</b> in the extension if needed.
              </span>
            )}
            Balances and signing will fail until they match.
          </div>
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={onSwitchWalletToApp}
          disabled={busy}
          className="px-3 py-1.5 rounded-md bg-amber-400/20 hover:bg-amber-400/30 text-amber-50 text-xs font-semibold border border-amber-300/30 transition-colors disabled:opacity-50"
        >
          Switch wallet to {expectedLabel}
        </button>
        {showSwitchAppToWallet && (
          <button
            onClick={onSwitchAppToWallet}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-amber-50 text-xs font-medium border border-white/10 transition-colors disabled:opacity-50"
          >
            Switch app to wallet
          </button>
        )}
      </div>
    </div>
  );
}
