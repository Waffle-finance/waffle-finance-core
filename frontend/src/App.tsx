import { useState, useEffect, useRef } from 'react'
import BridgeForm from './components/BridgeForm'
import DarkVeil from './components/DarkVeil'
import TransactionHistory from './components/TransactionHistory'
import { ToastContainer, useToast } from './components/Toast'
import { useFreighter } from './hooks/useFreighter'
import { useSolanaWallet } from './hooks/useSolanaWallet'
import { useEthereumWallet } from './hooks/useEthereumWallet'
import { useNetworkMode } from './lib/useNetworkMode'
import { pingBackendWake } from './lib/wakeBackend'
import { isMainnetEnabled } from './config/networks'
import { featureFlags } from './config/feature-flags'
import NetworkMismatchBanner from './components/NetworkMismatchBanner'
import MainnetVersionBanner from './components/MainnetVersionBanner'
import {
  Activity,
  ArrowRightLeft,
  ChevronDown,
  ExternalLink,
  History,
  LockKeyhole,
  RadioTower,
  ShieldCheck,
  Wallet,
  Zap,
} from 'lucide-react'


function App() {
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<'bridge' | 'history'>('bridge');
  const [showIntro, setShowIntro] = useState(() => {
    return sessionStorage.getItem('wafflefinance:intro-seen') !== 'true';
  });
  const [introLogoReady, setIntroLogoReady] = useState(false);
  const [introClosing, setIntroClosing] = useState(false);
  const introStartedAt = useRef(Date.now());

  const ethWallet = useEthereumWallet();
  const ethAddress = ethWallet.address || '';

  // Freighter hook usage
  const {
    isConnected: stellarConnected,
    address: stellarAddress,
    isLoading: stellarLoading,
    error: stellarError,
    errorCode: stellarErrorCode,
    hint: stellarHint,
    phase: stellarPhase,
    connect: connectFreighter,
    disconnect: disconnectFreighter,
    signTransaction: signStellarTransaction,
  } = useFreighter();

  // Phantom / Solana hook
  const {
    isConnected: solanaConnected,
    address: solanaAddress,
    isLoading: solanaLoading,
    isInstalled: phantomInstalled,
    error: solanaError,
    errorCode: solanaErrorCode,
    hint: solanaHint,
    phase: solanaPhase,
    connect: connectPhantom,
    disconnect: disconnectPhantom,
  } = useSolanaWallet();

  // Toast hook
  const toast = useToast();

  // Tell the relayer someone is browsing (keeps pollers attentive, no RPC until swap).
  useEffect(() => {
    pingBackendWake();
    const refreshMs = 4 * 60_000;
    const id = window.setInterval(pingBackendWake, refreshMs);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!showIntro || !introLogoReady) {
      return;
    }

    sessionStorage.setItem('wafflefinance:intro-seen', 'true');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const originalIntroDuration = prefersReducedMotion ? 250 : 3500;
    const logoVisibleDelay = prefersReducedMotion ? 0 : 1000;
    const fadeDuration = prefersReducedMotion ? 0 : 500;
    const elapsed = Date.now() - introStartedAt.current;
    const closeDelay = Math.max(originalIntroDuration - elapsed, logoVisibleDelay);

    const closeTimer = window.setTimeout(() => {
      setIntroClosing(true);
    }, closeDelay);

    const removeTimer = window.setTimeout(() => {
      setShowIntro(false);
    }, closeDelay + fadeDuration);

    return () => {
      window.clearTimeout(closeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [showIntro, introLogoReady]);

  // MetaMask connection is handled by useEthereumWallet hook

  // Single source of truth for testnet/mainnet across URL + MetaMask + Freighter.
  // Replaces the previous local `currentNetwork` state and 2s page-reload hack
  // that allowed URL and wallet to drift apart.
  const networkState = useNetworkMode({
    ethAddress: ethAddress || undefined,
    stellarAddress: stellarAddress || undefined,
  });
  const currentNetwork = networkState.mode;

  const toggleNetwork = async () => {
    if (!isMainnetEnabled()) {
      return;
    }

    const newNetwork = currentNetwork === 'testnet' ? 'mainnet' : 'testnet';
    const result = await networkState.setMode(newNetwork);

    if (!result.ok) {
      if (result.reason === 'user-rejected') {
        toast.warning('Network change cancelled', 'You declined the wallet switch — app is still on ' + (currentNetwork === 'mainnet' ? 'Mainnet' : 'Testnet') + '.');
      } else {
        toast.error('Network switch failed', 'Please switch your wallet network manually, then click the toggle again.');
      }
      return;
    }

    toast.success(
      'Network mode changed',
      `Switched to ${newNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'} mode`,
    );
  };



  // MetaMask connection - Using hook
  const connectMetaMask = async () => {
    setIsConnecting(true);
    try {
      await ethWallet.connect();
      setShowWalletMenu(false);
    } catch (error: any) {
      console.error('MetaMask connection error:', error);
    } finally {
      setIsConnecting(false);
    }
  };

  // Freighter connection - Using hook
  const handleFreighterConnect = async () => {
    try {
      await connectFreighter();
      setShowWalletMenu(false);
    } catch (error: any) {
      console.error('Freighter connection error:', error);
    }
  };

  // Wallet disconnect
  const disconnectWallets = () => {
    ethWallet.disconnect();
    disconnectFreighter();
    disconnectPhantom();
    setShowWalletMenu(false);
  };

  const isWalletsConnected = ethAddress && stellarConnected;
  const hasAnyConnection = ethAddress || stellarConnected || solanaConnected;
  const connectionLabel = isWalletsConnected ? 'Connected' : hasAnyConnection ? 'Partial' : 'Connect Wallet';
  const walletError = [ethWallet.error, stellarError, solanaError].filter(Boolean).join('  ·  ');
  const walletDiagnostics = [
    `MetaMask: ${ethWallet.phase}${ethWallet.errorCode ? ` (${ethWallet.errorCode})` : ''}`,
    `Freighter: ${stellarPhase}${stellarErrorCode ? ` (${stellarErrorCode})` : ''}`,
    `Phantom: ${solanaPhase}${solanaErrorCode ? ` (${solanaErrorCode})` : ''}`,
  ];

  return (
    <div className="app-shell min-h-screen text-white flex flex-col">
      {showIntro && (
        <div
          className={`intro-screen${introLogoReady ? ' intro-screen--ready' : ''}${introClosing ? ' intro-screen--closing' : ''}`}
          aria-label="WaffleFinance loading"
        >
          <div className="intro-card">
            <div className="intro-rail">
              <div className="intro-node intro-node-eth">
                <img src="/images/eth.png" alt="" />
              </div>
              <div className="intro-logo-wrap">
                <img
                  src="/images/wafflefinance-logo.svg"
                  alt="WaffleFinance"
                  className="intro-logo"
                  loading="eager"
                  decoding="sync"
                  onLoad={() => setIntroLogoReady(true)}
                  onError={() => setIntroLogoReady(true)}
                />
              </div>
              <div className="intro-node intro-node-xlm">
                <img src="/images/xlm.png" alt="" />
              </div>
            </div>
            <div className="intro-copy">
              <p>WaffleFinance</p>
              <span>Cross-Chain Swap</span>
            </div>
            <div className="intro-loader" />
          </div>
        </div>
      )}

      {/* Top Navigation */}
      <nav className="nav-glass sticky top-0 z-50 w-full px-4 py-3 md:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <img
                src="/images/wafflefinance-logo.svg"
                alt="WaffleFinance"
                className="h-10 w-10 rounded-xl border border-amber-400/20 nav-logo-waffle"
              />
              <div className="absolute -inset-1 rounded-xl bg-gradient-to-br from-amber-400/15 to-transparent blur-sm -z-10" />
            </div>
            <div>
              <span className="block text-[1.05rem] font-bold tracking-tight text-white">WaffleFinance</span>
              <span className="hidden text-[0.62rem] uppercase tracking-[0.36em] text-amber-400/60 sm:block">Cross-Chain Swap</span>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-2.5">
            {featureFlags.testnetFaucets && currentNetwork === 'testnet' && (
              <nav className="hidden items-center gap-2 md:flex">
                <a
                  href="https://www.alchemy.com/faucets/ethereum-sepolia"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-[#4f6bff]/40 hover:bg-[#4f6bff]/10 hover:text-white"
                >
                  Faucet
                  <ExternalLink className="h-3 w-3" />
                </a>
              </nav>
            )}

            {isMainnetEnabled() ? (
              <button
                onClick={toggleNetwork}
                className={`network-pill px-3 py-1.5 text-xs font-semibold transition-all duration-200 md:px-3.5 ${
                  currentNetwork === 'mainnet' ? 'network-mainnet' : 'network-testnet'
                }`}
              >
                <div className={`h-1.5 w-1.5 rounded-full ${
                  currentNetwork === 'mainnet'
                    ? 'bg-cyan-400 shadow-[0_0_8px_rgba(0,212,255,0.7)]'
                    : 'bg-[#7b8fff] shadow-[0_0_8px_rgba(79,107,255,0.6)]'
                }`} />
                {currentNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}
              </button>
            ) : (
              <div className="network-pill-group inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] p-1">
                <span className="network-pill network-testnet px-3 py-1 text-xs font-semibold md:px-3.5" aria-current="true">
                  <div className="h-1.5 w-1.5 rounded-full bg-[#7b8fff] shadow-[0_0_8px_rgba(79,107,255,0.6)]" />
                  Testnet
                </span>
                <button
                  type="button"
                  disabled
                  title="v2 mainnet launches after independent audit (Q1 2027)"
                  className="network-pill network-coming cursor-not-allowed px-3 py-1 text-xs font-semibold md:px-3.5"
                >
                  Mainnet Soon
                </button>
              </div>
            )}

            {/* Connect Wallet Button */}
            <div className="relative">
              <button
                onClick={() => setShowWalletMenu(!showWalletMenu)}
                className="inline-flex items-center gap-2 rounded-full border border-[#4f6bff]/35 bg-[#4f6bff]/[0.14] px-3 py-1.5 text-sm font-semibold text-white shadow-[0_4px_20px_rgba(63,92,255,0.18)] transition hover:border-[#4f6bff]/55 hover:bg-[#4f6bff]/[0.22] md:px-4"
              >
                <Wallet className="h-3.5 w-3.5" />
                {isWalletsConnected ? (
                  <>
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
                    <span className="hidden sm:inline">{connectionLabel}</span>
                  </>
                ) : hasAnyConnection ? (
                  <>
                    <div className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]" />
                    <span className="hidden sm:inline">{connectionLabel}</span>
                  </>
                ) : (
                  <span className="hidden sm:inline">{connectionLabel}</span>
                )}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${showWalletMenu ? 'rotate-180' : ''}`} />
              </button>

              {/* Wallet Dropdown */}
              {showWalletMenu && (
                <div className="absolute right-0 top-full z-[100] mt-2.5 w-[min(21rem,calc(100vw-2rem))] rounded-2xl border border-[#4f6bff]/22 bg-[#06091a]/96 p-4 shadow-2xl shadow-black/60 backdrop-blur-2xl">
                  <p className="mb-3.5 text-center text-sm font-semibold text-white/90">Connect Wallets</p>

                  {(walletError || stellarError || solanaError) && (
                    <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                      {ethWallet.error && (
                        <p className="text-xs text-red-300 mb-1"><strong>MetaMask:</strong> {ethWallet.error}</p>
                      )}
                      {stellarError && (
                        <p className="text-xs text-red-300 mb-1"><strong>Freighter:</strong> {stellarError}</p>
                      )}
                      {solanaError && (
                        <p className="text-xs text-red-300"><strong>Phantom:</strong> {solanaError}</p>
                      )}
                      {(ethWallet.hint || stellarHint || solanaHint) && (
                        <p className="text-xs text-slate-400 mt-1">
                          {ethWallet.hint || stellarHint || solanaHint}
                        </p>
                      )}
                      <p className="mt-2 text-[0.65rem] text-slate-500">
                        {walletDiagnostics.join(' · ')}
                      </p>
                    </div>
                  )}

                  {/* MetaMask */}
                  <div className="mb-2.5 rounded-xl border border-orange-400/15 bg-white/[0.04] p-3.5 transition hover:border-orange-400/25">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-orange-400/20 bg-orange-400/12 text-orange-300">
                          <Wallet className="h-3.5 w-3.5" />
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-white">MetaMask</div>
                          <div className="text-[0.7rem] text-slate-400">Ethereum</div>
                        </div>
                      </div>
                      {ethWallet.isConnected && ethAddress ? (
                        <div className="text-right">
                          <div className="flex items-center gap-1 mb-0.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            <span className="text-[0.7rem] text-emerald-400">Connected</span>
                          </div>
                          <p className="text-[0.7rem] text-slate-400">{ethAddress.substring(0, 6)}…{ethAddress.substring(ethAddress.length - 4)}</p>
                        </div>
                      ) : !ethWallet.isInstalled ? (
                        <div className="text-right">
                          <div className="flex items-center gap-1 mb-0.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-red-400" />
                            <span className="text-[0.7rem] text-red-400">Missing</span>
                          </div>
                          <p className="text-[0.7rem] text-slate-400">{ethWallet.hint}</p>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={connectMetaMask}
                          disabled={isConnecting}
                          className="rounded-full border border-orange-400/22 bg-orange-400/12 px-3.5 py-1.5 text-xs font-semibold text-orange-200 transition hover:bg-orange-400/22"
                        >
                          {isConnecting ? 'Connecting…' : 'Connect'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Freighter */}
                  <div className="mb-2.5 rounded-xl border border-[#4f6bff]/18 bg-white/[0.04] p-3.5 transition hover:border-[#4f6bff]/32">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#4f6bff]/25 bg-[#4f6bff]/12 text-[#a8b4ff]">
                          <RadioTower className="h-3.5 w-3.5" />
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-white">Freighter</div>
                          <div className="text-[0.7rem] text-slate-400">Stellar</div>
                        </div>
                      </div>
                      {stellarConnected && stellarAddress ? (
                        <div className="text-right">
                          <div className="flex items-center gap-1 mb-0.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            <span className="text-[0.7rem] text-emerald-400">Connected</span>
                          </div>
                          <p className="text-[0.7rem] text-slate-400">{stellarAddress.substring(0, 6)}…{stellarAddress.substring(stellarAddress.length - 4)}</p>
                        </div>
                      ) : stellarError ? (
                        <div className="text-right max-w-[10rem]">
                          <div className="flex items-center gap-1 mb-0.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-red-400" />
                            <span className="text-[0.7rem] text-red-400">Error</span>
                          </div>
                          <p className="text-[0.65rem] text-slate-400 line-clamp-2">{stellarHint}</p>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={handleFreighterConnect}
                          disabled={stellarLoading}
                          className="rounded-full border border-[#4f6bff]/28 bg-[#4f6bff]/12 px-3.5 py-1.5 text-xs font-semibold text-[#a8b4ff] transition hover:bg-[#4f6bff]/22"
                        >
                          {stellarLoading ? 'Connecting…' : 'Connect'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Phantom — Solana */}
                  <div className="mb-2.5 rounded-xl border border-purple-500/18 bg-white/[0.04] p-3.5 transition hover:border-purple-500/32">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-purple-500/25 bg-purple-500/12 text-purple-300">
                          <svg className="h-3.5 w-3.5" viewBox="0 0 128 128" fill="none">
                            <circle cx="64" cy="64" r="64" fill="url(#phantomGrad)" />
                            <path d="M110.5 64c0-25.6-20.9-46.5-46.5-46.5S17.5 38.4 17.5 64c0 16.4 8.5 30.8 21.3 39.1 2.1 1.4 4.9-.2 4.9-2.7v-7.2c0-1.4.8-2.7 2-3.4C57.4 85.5 64 75.6 64 64.3c0-11.3-7.3-21-17.6-24.4-1.6-.5-2.7-2-2.7-3.7v-1c0-2.5 2.4-4.3 4.8-3.5C65.3 36.5 76 51 76 67.8c0 16.2-10.9 29.9-25.9 33.9" stroke="white" strokeWidth="5" strokeLinecap="round"/>
                            <defs>
                              <linearGradient id="phantomGrad" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
                                <stop stopColor="#9945FF"/>
                                <stop offset="1" stopColor="#14F195"/>
                              </linearGradient>
                            </defs>
                          </svg>
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-white">Phantom</div>
                          <div className="text-[0.7rem] text-slate-400">Solana</div>
                        </div>
                      </div>
                      {solanaConnected && solanaAddress ? (
                        <div className="text-right">
                          <div className="flex items-center gap-1 mb-0.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            <span className="text-[0.7rem] text-emerald-400">Connected</span>
                          </div>
                          <p className="text-[0.7rem] text-slate-400">{solanaAddress.substring(0, 6)}…{solanaAddress.substring(solanaAddress.length - 4)}</p>
                        </div>
                      ) : solanaError ? (
                        <div className="text-right max-w-[10rem]">
                          <div className="flex items-center gap-1 mb-0.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-red-400" />
                            <span className="text-[0.7rem] text-red-400">Error</span>
                          </div>
                          <p className="text-[0.65rem] text-slate-400 line-clamp-2">{solanaHint}</p>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => connectPhantom()}
                          disabled={solanaLoading}
                          className="rounded-full border border-purple-500/28 bg-purple-500/12 px-3.5 py-1.5 text-xs font-semibold text-purple-200 transition hover:bg-purple-500/22"
                        >
                          {solanaLoading ? 'Connecting…' : phantomInstalled ? 'Connect' : 'Install'}
                        </button>
                      )}
                    </div>
                  </div>

                  {hasAnyConnection && (
                    <button
                      onClick={disconnectWallets}
                      className="w-full rounded-xl border border-red-500/22 bg-red-500/10 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-500/18"
                    >
                      Disconnect All
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>

      <NetworkMismatchBanner networkState={networkState} />
      <MainnetVersionBanner networkState={networkState} />

      {/* Main Content */}
      <main className="relative z-10 mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-10 px-4 pb-24 pt-10 md:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(420px,540px)] lg:items-start lg:pt-16">

        {/* Left — Hero + info */}
        <section className="space-y-7">
          <div className="max-w-xl">
            <div className="waffle-badge mb-5 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.25em] shadow-[0_4px_20px_rgba(245,158,11,0.1)]">
              <span>🧇</span>
              Multi-Chain · ETH · XLM · SOL
            </div>
            <h1 className="text-[2.6rem] font-bold leading-[1.06] tracking-tight text-white md:text-[3.4rem]">
              Swap across chains,
              <span className="hero-gradient-waffle block mt-0.5">crispy fast.</span>
            </h1>
            <p className="mt-4 max-w-md text-[0.95rem] leading-relaxed text-slate-300/75">
              WaffleFinance brings atomic cross-chain swaps between Ethereum, Stellar, and Solana — live quotes, non-custodial HTLC settlement, zero counterparty risk.
            </p>
          </div>

          {/* Stats */}
          <div className="grid max-w-xl grid-cols-3 gap-3">
            {[
              { icon: ShieldCheck, label: 'Settlement', value: 'Atomic HTLC' },
              { icon: Activity,    label: 'Chains',     value: 'ETH · XLM · SOL' },
              { icon: LockKeyhole, label: 'Network',    value: currentNetwork === 'mainnet' ? 'Mainnet' : 'Testnet' },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="metric-tile metric-tile-waffle">
                <Icon className="h-3.5 w-3.5 text-amber-400/80" />
                <span className="text-[0.68rem] text-slate-400/80 uppercase tracking-wide">{label}</span>
                <strong className="text-[0.82rem] font-semibold text-white">{value}</strong>
              </div>
            ))}
          </div>

          {/* Route card */}
          <div className="route-panel route-panel-waffle max-w-xl">
            <div className="flex items-center justify-between gap-4 border-b border-white/[0.07] pb-4">
              <div>
                <p className="text-[0.65rem] uppercase tracking-[0.28em] text-amber-400/50">Active routes</p>
                <h2 className="mt-0.5 text-base font-semibold text-white">ETH · XLM · SOL Liquidity</h2>
              </div>
              <Zap className="h-4 w-4 text-amber-400 drop-shadow-[0_0_10px_rgba(245,158,11,0.5)]" />
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 pt-4">
              <div className="chain-node">
                <img src="/images/eth.png" alt="ETH" className="h-5 w-5" />
                <span>ETH</span>
              </div>
              <ArrowRightLeft className="h-3.5 w-3.5 text-slate-500" />
              <div className="chain-node">
                <img src="/images/xlm.png" alt="XLM" className="h-5 w-5" />
                <span>XLM</span>
              </div>
              <ArrowRightLeft className="h-3.5 w-3.5 text-slate-500" />
              <div className="chain-node">
                <img src="/images/sol.svg" alt="SOL" className="h-5 w-5" />
                <span>SOL</span>
              </div>
            </div>
          </div>
        </section>

        {/* Right — Bridge / History card */}
        <section className="w-full">
          <div className="mb-4 flex justify-center lg:justify-end">
            <div className="segmented-control">
              <button onClick={() => setActiveTab('bridge')} className={activeTab === 'bridge' ? 'active' : ''}>
                <ArrowRightLeft className="h-3.5 w-3.5" />
                Bridge
              </button>
              <button onClick={() => setActiveTab('history')} className={activeTab === 'history' ? 'active' : ''}>
                <History className="h-3.5 w-3.5" />
                History
              </button>
            </div>
          </div>

          {activeTab === 'bridge' && (
            <BridgeForm
              ethAddress={ethAddress}
              stellarAddress={stellarAddress || ''}
              solanaAddress={solanaAddress || undefined}
              signStellarTransaction={(xdr, networkPassphrase) =>
                signStellarTransaction(xdr, networkPassphrase, stellarAddress || undefined)
              }
            />
          )}
          {activeTab === 'history' && (
            <TransactionHistory
              ethAddress={ethAddress}
              stellarAddress={stellarAddress || ''}
            />
          )}
        </section>
      </main>

      <div className="background-depth pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="dark-veil-layer">
          <DarkVeil
            hueShift={0}
            noiseIntensity={0.008}
            scanlineIntensity={0.035}
            scanlineFrequency={1.8}
            speed={0.9}
            warpAmount={0.08}
            resolutionScale={0.72}
            verticalOffset={0.42}
          />
        </div>
      </div>

      {/* Waffle backdrop — blended large waffle pattern behind everything */}
      <div className="waffle-backdrop-wrap">
        <img
          src="/images/waffle-backdrop.svg"
          alt=""
          className="waffle-backdrop"
          aria-hidden="true"
        />
      </div>

      {/* Footer Bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex h-8 w-full items-center justify-between border-t border-white/[0.06] bg-[#04050f]/88 px-5 backdrop-blur-xl">
        <span className="text-[0.68rem] text-slate-500/60 tracking-wide">WaffleFinance · Cross-Chain Swap</span>
        <a
          href="https://x.com/kaptan_web3"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-[0.68rem] font-semibold text-slate-400/70 transition-colors hover:text-[#7b8fff]"
        >
          Built by Kaptan
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </div>

      {/* Toast Container */}
      <ToastContainer 
        toasts={toast.toasts}
        onClose={toast.removeToast}
      />

    </div>
  );
}

export default App;
