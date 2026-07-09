import { useState } from 'react';
import { Clock, CheckCircle, XCircle, ArrowRight, ExternalLink, RefreshCw, Undo2, Search, Copy, Check, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { isTestnet } from '../config/networks';
import RefundDialog from '../features/refund/RefundDialog';
import { useTransactionHistoryCache, type Transaction } from '../hooks/useTransactionHistoryCache';
import type { Address } from 'viem';

interface TransactionHistoryProps {
  ethAddress?: string;
  stellarAddress?: string;
}

type TransactionFilter = 'all' | 'pending' | 'completed' | 'confirmed' | 'cancelled' | 'failed' | 'refunded' | 'expired' | 'timed_out';

const FILTER_OPTIONS: Array<{ key: TransactionFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'refunded', label: 'Refunded' },
  { key: 'timed_out', label: 'Timed out' },
];

const PRODUCTION_API_BASE_URL = 'https://oversync-k36vx.ondigitalocean.app';
const API_BASE_URL = import.meta.env.PROD
  ? ''
  : import.meta.env.VITE_API_BASE_URL || PRODUCTION_API_BASE_URL;

export default function TransactionHistory({ ethAddress, stellarAddress }: TransactionHistoryProps) {
  const [filter, setFilter] = useState<TransactionFilter>('all');
  const [refundTarget, setRefundTarget] = useState<Transaction | null>(null);
  const [manualRefundingIds, setManualRefundingIds] = useState<Set<string>>(() => new Set());
  
  // Advanced search and filtering state
  const [searchQuery, setSearchQuery] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<string>('all');
  const [directionFilter, setDirectionFilter] = useState<string>('all');
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const {
    transactions,
    isLoading,
    isRefreshing,
    isStale,
    refreshFromCoordinator,
    updateTransactions,
  } = useTransactionHistoryCache({
    ethAddress,
    stellarAddress,
    apiBase: API_BASE_URL,
  });

  const getStatusLabel = (status: Transaction['status']): string => {
    switch (status) {
      case 'confirmed':
        return 'Confirmed';
      case 'timed_out':
        return 'Timed out';
      case 'expired':
        return 'Expired';
      default:
        return status.charAt(0).toUpperCase() + status.slice(1);
    }
  };

  const getStatusColor = (status: Transaction['status']) => {
    switch (status) {
      case 'completed':
      case 'confirmed':
        return 'text-green-400 bg-green-500/20';
      case 'pending':
        return 'text-yellow-400 bg-yellow-500/20';
      case 'cancelled':
        return 'text-gray-400 bg-gray-500/20';
      case 'failed':
        return 'text-red-400 bg-red-500/20';
      case 'refunded':
        return 'text-emerald-400 bg-emerald-500/20';
      case 'expired':
      case 'timed_out':
        return 'text-orange-400 bg-orange-500/20';
      default:
        return 'text-gray-400 bg-gray-500/20';
    }
  };

  const getStatusIcon = (status: Transaction['status']) => {
    switch (status) {
      case 'completed':
      case 'confirmed':
        return <CheckCircle className="h-4 w-4" />;
      case 'pending':
        return <Clock className="h-4 w-4" />;
      case 'cancelled':
      case 'failed':
        return <XCircle className="h-4 w-4" />;
      case 'refunded':
        return <Undo2 className="h-4 w-4" />;
      case 'expired':
      case 'timed_out':
        return <Clock className="h-4 w-4" />;
      default:
        return <Clock className="h-4 w-4" />;
    }
  };

  const formatTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    return `${minutes}m ago`;
  };

  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedText(id);
    setTimeout(() => {
      setCopiedText(null);
    }, 2000);
  };

  const getLifecycleDescription = (phase: string) => {
    switch (phase) {
      case 'announced':
        return 'Swap intent registered. Awaiting lock deposit on the source chain.';
      case 'src_locked':
        return 'Funds locked on the source chain. Awaiting destination lock by the resolver.';
      case 'dst_locked':
        return 'Funds locked on the destination chain. Awaiting secret reveal to complete swap.';
      case 'secret_revealed':
        return 'Secret preimage revealed. Swap is in process of settlement.';
      case 'completed':
        return 'Swap completed successfully. Funds delivered on the destination chain.';
      case 'refunded':
        return 'Timelock expired and funds were successfully refunded to the sender.';
      case 'failed':
        return 'Swap encountered an error and failed. Refund may be available.';
      case 'expired':
        return 'Timelock expired. The swap did not complete. Funds can now be refunded.';
      default:
        return 'Order is in progress.';
    }
  };

  const filteredTransactions = transactions.filter(tx => {
    // 1. Quick filter
    if (filter !== 'all' && tx.status !== filter) return false;

    // 2. Lifecycle filter
    if (lifecycleFilter !== 'all' && tx.lifecyclePhase !== lifecycleFilter) return false;

    // 3. Direction filter
    if (directionFilter !== 'all' && tx.direction !== directionFilter) return false;

    // 4. Search query
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase().trim();
      const matchesId = tx.id.toLowerCase().includes(q);
      const matchesTxHash = tx.txHash?.toLowerCase().includes(q);
      const matchesHashlock = tx.hashlock?.toLowerCase().includes(q);
      const matchesCorrelationId = tx.correlationId?.toLowerCase().includes(q);
      const matchesEthAddress = tx.ethAddress?.toLowerCase().includes(q);
      const matchesStellarAddress = tx.stellarAddress?.toLowerCase().includes(q);
      
      if (!matchesId && !matchesTxHash && !matchesHashlock && !matchesCorrelationId && !matchesEthAddress && !matchesStellarAddress) {
        return false;
      }
    }

    return true;
  });
  const isHistoryBusy = isLoading || isRefreshing;

  const getEtherscanUrl = (txHash: string): string => {
    const base = isTestnet() ? 'https://sepolia.etherscan.io' : 'https://etherscan.io';
    return `${base}/tx/${txHash}`;
  };

  const getStellarExplorerUrl = (txHash: string): string => {
    const network = isTestnet() ? 'testnet' : 'public';
    return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
  };

  /**
   * Pick the right block explorer for a refund tx.
   *
   * `refundNetwork` is the authoritative signal once we start writing it.
   * For legacy entries that don't have it, we fall back to a hash-shape
   * heuristic: Ethereum hashes are 0x-prefixed, Stellar hashes are not.
   */
  const getRefundNetwork = (tx: Transaction): 'ethereum' | 'stellar' => {
    if (tx.refundNetwork) return tx.refundNetwork;
    if (tx.refundTxHash?.startsWith('0x')) return 'ethereum';
    return 'stellar';
  };

  const getRefundExplorerUrl = (tx: Transaction): string => {
    if (!tx.refundTxHash) return '#';
    return getRefundNetwork(tx) === 'ethereum'
      ? getEtherscanUrl(tx.refundTxHash)
      : getStellarExplorerUrl(tx.refundTxHash);
  };

  const getRefundNetworkLabel = (tx: Transaction): string =>
    getRefundNetwork(tx) === 'ethereum' ? 'Ethereum' : 'Stellar';

  /**
   * A pending ETH→XLM swap is "refundable" once we have all three on-chain
   * coordinates and the order is still in pending/failed/expired state. We do NOT
   * gate on time here — RefundDialog itself enforces the timelock and only
   * unlocks the button after it expires.
   */
  const canRefund = (tx: Transaction): boolean => {
    return (
      tx.direction === 'eth-to-xlm' &&
      (tx.status === 'pending' || tx.status === 'failed' || tx.status === 'expired' || tx.status === 'timed_out') &&
      !tx.refundedAt &&
      !!tx.onChainOrderId &&
      !!tx.htlcContractAddress &&
      !!tx.timelockUnixSeconds
    );
  };

  const canManualRefundXlm = (tx: Transaction): boolean => {
    return (
      tx.direction === 'xlm-to-eth' &&
      tx.status === 'failed' &&
      tx.autoRefundFailed === true &&
      !tx.refundedAt &&
      !!(tx.stellarTxHash || tx.txHash) &&
      !!(tx.stellarAddress || stellarAddress)
    );
  };

  const markRefunded = (
    orderId: string,
    refundHash: string,
    refundNetwork: 'ethereum' | 'stellar'
  ) => {
    updateTransactions((prev) => {
      return prev.map((tx) =>
        tx.id === orderId
          ? {
              ...tx,
              status: 'refunded' as const,
              refundTxHash: refundHash,
              refundNetwork,
              refundedAt: Date.now(),
            }
          : tx
      );
    });
  };

  const handleManualXlmRefund = async (tx: Transaction) => {
    const originalStellarTx = tx.stellarTxHash || tx.txHash;
    const refundAddress = tx.stellarAddress || stellarAddress;

    if (!originalStellarTx || !refundAddress) {
      window.alert('Manual refund requires the original Stellar transaction and your Stellar wallet address.');
      return;
    }

    setManualRefundingIds((prev) => new Set(prev).add(tx.id));
    try {
      const res = await fetch(`${API_BASE_URL}/api/orders/manual-refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stellarTxHash: originalStellarTx,
          stellarAddress: refundAddress,
          networkMode: tx.networkMode || (isTestnet() ? 'testnet' : 'mainnet'),
        }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.details || body?.error || `Refund failed with ${res.status}`);
      }

      if (!body?.refundTxHash) {
        throw new Error('Refund response did not include a transaction hash.');
      }

      markRefunded(tx.id, body.refundTxHash, 'stellar');
      window.alert(`XLM refund submitted.\nRefund TX: ${body.refundTxHash}`);
    } catch (err) {
      window.alert(`Manual XLM refund failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setManualRefundingIds((prev) => {
        const next = new Set(prev);
        next.delete(tx.id);
        return next;
      });
    }
  };

  const handleRefunded = (orderId: string, refundHash: `0x${string}`) => {
    markRefunded(orderId, refundHash, 'ethereum');
    setRefundTarget(null);
  };

  return (
    <div className="surface-panel flex max-h-[calc(100dvh-21rem)] min-h-[28rem] flex-col overflow-hidden rounded-[1.25rem] p-4 shadow-[0_24px_90px_rgba(0,0,0,0.36)] md:p-6 lg:max-h-[calc(100dvh-18rem)]">
      <div className="mb-6 flex shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/55">Ledger</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-white">Transaction History</h2>
          <p className="mt-2 text-sm text-slate-400">
            Track your cross-chain swaps between Ethereum and Stellar networks
          </p>
          {(isRefreshing || isStale) && transactions.length > 0 && (
            <p className="mt-2 text-xs text-cyan-100/60" aria-live="polite">
              {isRefreshing ? 'Showing cached history while refreshing latest data...' : 'Showing cached history'}
            </p>
          )}
        </div>
        <button
          onClick={refreshFromCoordinator}
          disabled={isHistoryBusy}
          className="button-hover-scale flex items-center justify-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-200/[0.12] px-4 py-2 text-sm font-semibold text-cyan-50 shadow-[0_12px_34px_rgba(0,226,255,0.12)] transition hover:border-cyan-100/45 hover:bg-cyan-200/[0.18] disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${isHistoryBusy ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="mb-4 flex shrink-0 gap-2 overflow-x-auto pb-1">
        {FILTER_OPTIONS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              filter === key
                ? 'brand-cta'
                : 'border border-white/10 bg-white/[0.045] text-slate-400 hover:bg-white/[0.075] hover:text-white'
            }`}
          >
            {label} {key !== 'all' && `(${transactions.filter(tx => tx.status === key).length})`}
          </button>
        ))}
      </div>

      {/* Search and Advanced Filters */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by Hash, ID, Address..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-white/[0.045] py-2 pl-9 pr-4 text-sm text-white placeholder-slate-400 outline-none transition hover:bg-white/[0.065] focus:border-cyan-500/50 focus:bg-white/[0.075]"
          />
        </div>
        <div>
          <select
            value={lifecycleFilter}
            onChange={(e) => setLifecycleFilter(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2 text-sm text-slate-300 outline-none transition hover:bg-white/[0.065] focus:border-cyan-500/50 focus:bg-white/[0.075]"
          >
            <option value="all" className="bg-slate-900 text-white">All Lifecycle Phases</option>
            <option value="announced" className="bg-slate-900 text-white">Announced</option>
            <option value="src_locked" className="bg-slate-900 text-white">Source Locked</option>
            <option value="dst_locked" className="bg-slate-900 text-white">Destination Locked</option>
            <option value="secret_revealed" className="bg-slate-900 text-white">Secret Revealed</option>
            <option value="completed" className="bg-slate-900 text-white">Completed</option>
            <option value="refunded" className="bg-slate-900 text-white">Refunded</option>
            <option value="failed" className="bg-slate-900 text-white">Failed</option>
            <option value="expired" className="bg-slate-900 text-white">Expired</option>
          </select>
        </div>
        <div>
          <select
            value={directionFilter}
            onChange={(e) => setDirectionFilter(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2 text-sm text-slate-300 outline-none transition hover:bg-white/[0.065] focus:border-cyan-500/50 focus:bg-white/[0.075]"
          >
            <option value="all" className="bg-slate-900 text-white">All Directions</option>
            <option value="eth-to-xlm" className="bg-slate-900 text-white">Ethereum → Stellar</option>
            <option value="xlm-to-eth" className="bg-slate-900 text-white">Stellar → Ethereum</option>
          </select>
        </div>
      </div>

      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain pr-1">
        {filteredTransactions.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] py-12 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.045]">
              <Clock className="h-8 w-8 text-slate-400" />
            </div>
            <p className="text-lg text-slate-300">No transactions yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Your real cross-chain swaps will appear here after the first transaction
            </p>
          </div>
        ) : (
          filteredTransactions.map((tx) => (
            <div
              key={tx.id}
              className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 transition hover:border-cyan-200/20 hover:bg-white/[0.065]"
            >
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${getStatusColor(tx.status)}`}>
                    {getStatusIcon(tx.status)}
                    <span>{getStatusLabel(tx.status)}</span>
                  </div>
                  <span className="text-xs text-slate-400">
                    {formatTime(tx.timestamp)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {tx.ethTxHash && (
                    <a
                      href={getEtherscanUrl(tx.ethTxHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.045] px-2.5 py-1 text-[11px] font-semibold text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
                      title="View on Etherscan"
                    >
                      <img src="/images/eth.png" alt="ETH" className="h-3.5 w-3.5" />
                      <span>Etherscan</span>
                      <ExternalLink className="h-3 w-3 opacity-70" />
                    </a>
                  )}
                  {tx.stellarTxHash && (
                    <a
                      href={getStellarExplorerUrl(tx.stellarTxHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.045] px-2.5 py-1 text-[11px] font-semibold text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
                      title="View on Stellar Expert"
                    >
                      <img src="/images/xlm.png" alt="XLM" className="h-3.5 w-3.5" />
                      <span>Stellar Expert</span>
                      <ExternalLink className="h-3 w-3 opacity-70" />
                    </a>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-center">
                    <div className="text-white font-medium">
                      {tx.amount} {tx.fromToken}
                    </div>
                    <div className="text-xs text-slate-400">
                      {tx.fromNetwork}
                    </div>
                  </div>

                  <ArrowRight className="h-4 w-4 text-slate-400" />

                  <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-center">
                    <div className="text-white font-medium">
                      {tx.estimatedAmount} {tx.toToken}
                    </div>
                    <div className="text-xs text-slate-400">
                      {tx.toNetwork}
                    </div>
                  </div>
                </div>
              </div>

                </div>
              </div>

              {/* Troubleshooting & Metadata Panel */}
              <div className="mt-3 border-t border-white/10 pt-3">
                <button
                  onClick={() => setExpandedCardId(expandedCardId === tx.id ? null : tx.id)}
                  className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                >
                  {expandedCardId === tx.id ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      Hide Troubleshooting Details
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      Show Troubleshooting Details
                    </>
                  )}
                </button>

                {expandedCardId === tx.id && (
                  <div className="mt-3 space-y-3 rounded-xl border border-white/5 bg-black/20 p-3 text-xs">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <span className="text-slate-500 block mb-1 font-semibold">Correlation ID</span>
                        <div className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] p-2 font-mono text-slate-300">
                          <span className="truncate">{tx.correlationId || 'N/A'}</span>
                          {tx.correlationId && (
                            <button
                              onClick={() => handleCopy(tx.correlationId!, 'correlation-' + tx.id)}
                              className="text-slate-400 hover:text-white transition-colors p-1 hover:bg-white/5 rounded"
                              title="Copy Correlation ID"
                            >
                              {copiedText === 'correlation-' + tx.id ? (
                                <Check className="h-3.5 w-3.5 text-green-400" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 block mb-1 font-semibold">Hashlock</span>
                        <div className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] p-2 font-mono text-slate-300">
                          <span className="truncate">{tx.hashlock || 'N/A'}</span>
                          {tx.hashlock && (
                            <button
                              onClick={() => handleCopy(tx.hashlock!, 'hashlock-' + tx.id)}
                              className="text-slate-400 hover:text-white transition-colors p-1 hover:bg-white/5 rounded"
                              title="Copy Hashlock"
                            >
                              {copiedText === 'hashlock-' + tx.id ? (
                                <Check className="h-3.5 w-3.5 text-green-400" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <span className="text-slate-500 block mb-1 font-semibold">Lifecycle Phase</span>
                        <div className="rounded-lg bg-white/[0.03] p-2 text-slate-300">
                          <span className="font-semibold capitalize text-cyan-400">{tx.lifecyclePhase || tx.status}</span>
                          <p className="mt-1 text-slate-400 text-[11px] leading-relaxed">
                            {getLifecycleDescription(tx.lifecyclePhase || tx.status)}
                          </p>
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 block mb-1 font-semibold">Last Updated</span>
                        <div className="rounded-lg bg-white/[0.03] p-2 text-slate-300">
                          {tx.lastUpdatedTimestamp ? (
                            new Date(tx.lastUpdatedTimestamp * 1000).toLocaleString()
                          ) : (
                            'N/A'
                          )}
                        </div>
                      </div>
                    </div>

                    {tx.errorState && (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-red-200">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
                          <div>
                            <span className="font-semibold">Error Message:</span>
                            <p className="mt-1 font-mono text-[11px] text-red-300 break-words leading-relaxed">{tx.errorState}</p>
                            <p className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                              Troubleshooting Tip: Please copy the Correlation ID and contact support. If you locked funds, you can claim a refund once the timelock expires using the "Refund" button.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {refundTarget && refundTarget.onChainOrderId && refundTarget.htlcContractAddress && refundTarget.timelockUnixSeconds && ethAddress && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <RefundDialog
            userAddress={ethAddress as Address}
            orderId={refundTarget.onChainOrderId}
            timelockUnixSeconds={refundTarget.timelockUnixSeconds}
            amountWei={refundTarget.amountWei ?? '0'}
            contractMode={refundTarget.htlcContractMode ?? 'v1-mainnet-htlc'}
            v1ContractAddress={refundTarget.htlcContractAddress as Address}
            onClose={() => setRefundTarget(null)}
            onRefunded={(hash) => handleRefunded(refundTarget.id, hash)}
          />
        </div>
      )}
    </div>
  );
}

