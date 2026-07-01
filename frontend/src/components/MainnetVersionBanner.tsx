import type { NetworkModeState } from '../lib/useNetworkMode';
import { t } from '../i18n';

interface Props {
  networkState: NetworkModeState;
}

/**
 * Shown only when the app is in mainnet mode (requires VITE_MAINNET_ENABLED=true).
 * Explains that the on-chain stack on mainnet is the v1 single-relayer bridge,
 * while v2 is live on testnet. Not rendered in the default testnet-only public UI.
 */
export default function MainnetVersionBanner({ networkState }: Props) {
  if (networkState.mode !== 'mainnet') return null;

  return (
    <div className="w-full bg-blue-500/10 border-y border-blue-400/30 text-blue-100 px-6 py-3 flex flex-col md:flex-row items-start md:items-center gap-3 justify-between text-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5">ℹ</span>
        <div>
          <div className="font-semibold text-blue-100">
            {t('network.mainnetBanner.title')}
          </div>
          <div className="text-blue-200/90">
            {t('network.mainnetBanner.body')}
          </div>
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={() => networkState.setMode('testnet')}
          className="px-3 py-1.5 rounded-md bg-blue-400/20 hover:bg-blue-400/30 text-blue-50 text-xs font-semibold border border-blue-300/30 transition-colors"
        >
          {t('network.mainnetBanner.button')}
        </button>
      </div>
    </div>
  );
}
