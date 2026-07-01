import { useState } from 'react';
import type { NetworkModeState } from '../lib/useNetworkMode';
import { isMainnetEnabled } from '../config/networks';
import { t } from '../i18n';

interface Props {
  networkState: NetworkModeState;
}

const MODE_LABEL: Record<'testnet' | 'mainnet', string> = {
  testnet: 'Testnet',
  mainnet: 'Mainnet',
};

const ETH_MODE_FROM_CHAIN: Record<string, string> = {
  '0x1': 'Ethereum Mainnet',
  '0xaa36a7': 'Sepolia Testnet',
};

const STELLAR_MODE_FROM_PASSPHRASE: Record<string, string> = {
  'Public Global Stellar Network ; September 2015': 'Stellar Mainnet',
  'Test SDF Network ; September 2015': 'Stellar Testnet',
};

function describeMetamaskChain(chainId: string | null): string {
  if (!chainId) return 'unknown';
  const key = chainId.toLowerCase();
  return ETH_MODE_FROM_CHAIN[key] || `chain ${chainId}`;
}

function describeFreighterNetwork(passphrase: string | null): string {
  if (!passphrase) return 'unknown';
  return STELLAR_MODE_FROM_PASSPHRASE[passphrase] || passphrase;
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
      metamaskChainId?.toLowerCase() === '0x1') ||
    (freighterConnected &&
      !freighterMatches &&
      freighterNetworkPassphrase === 'Public Global Stellar Network ; September 2015');

  const showSwitchAppToWallet = isMainnetEnabled() || !walletWantsMainnet;

  const onSwitchAppToWallet = async () => {
    setBusy(true);
    try {
      const nextMode: 'testnet' | 'mainnet' =
        metamaskConnected && !metamaskMatches
          ? metamaskChainId?.toLowerCase() === '0x1'
            ? 'mainnet'
            : 'testnet'
          : freighterConnected && !freighterMatches
            ? freighterNetworkPassphrase === 'Public Global Stellar Network ; September 2015'
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
            {t('network.mismatch.title')}
          </div>
          <div className="text-amber-200/90">
            {t('network.mismatch.body', { expected: expectedLabel })}{' '}
            {metamaskConnected && !metamaskMatches && (
              <span>
                {t('network.mismatch.ethMismatch', {
                  actual: metamaskActual,
                  chainId: metamaskChainId ? ` (${metamaskChainId})` : '',
                })}{' '}
              </span>
            )}
            {freighterConnected && !freighterMatches && (
              <span>
                {t('network.mismatch.freighterMismatch', { actual: freighterActual })}{' '}
              </span>
            )}
            {freighterConnected && !freighterMatches && (
              <span className="block mt-1 text-amber-200/75">
                {t('network.mismatch.freighterHint')}
              </span>
            )}
            {t('network.mismatch.signingWillFail')}
          </div>
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={onSwitchWalletToApp}
          disabled={busy}
          className="px-3 py-1.5 rounded-md bg-amber-400/20 hover:bg-amber-400/30 text-amber-50 text-xs font-semibold border border-amber-300/30 transition-colors disabled:opacity-50"
        >
          {t('network.mismatch.switchWallet', { network: expectedLabel })}
        </button>
        {showSwitchAppToWallet && (
          <button
            onClick={onSwitchAppToWallet}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-amber-50 text-xs font-medium border border-white/10 transition-colors disabled:opacity-50"
          >
            {t('network.mismatch.switchApp')}
          </button>
        )}
      </div>
    </div>
  );
}
