import React, { useState, useEffect, useRef } from 'react';
import { 
  Horizon, 
  Asset, 
  Operation, 
  TransactionBuilder, 
  Memo
} from '@stellar/stellar-sdk';
import { isTestnet, getCurrentNetwork } from '../config/networks';
import { parseHtlcReceipt } from '../lib/parseHtlcReceipt';
import { sanitizeAmountInput } from '../lib/sanitizeAmountInput';
import { ArrowDownUp, CheckCircle2, Loader2, RefreshCw, Settings2 } from 'lucide-react';

interface BridgeFormProps {
  ethAddress: string;
  stellarAddress: string;
  solanaAddress?: string;
  signStellarTransaction: (xdr: string, networkPassphrase?: string) => Promise<string>;
}

const ETH_TOKEN = { symbol: 'ETH', name: 'Ethereum',      logo: '/images/eth.png', chain: 'Ethereum', decimals: 18 };
const XLM_TOKEN = { symbol: 'XLM', name: 'Stellar Lumens', logo: '/images/xlm.png', chain: 'Stellar',  decimals: 7  };
const SOL_TOKEN = { symbol: 'SOL', name: 'Solana',         logo: '/images/sol.svg', chain: 'Solana',   decimals: 9  };

type BridgeDirection = 'eth_to_xlm' | 'xlm_to_eth' | 'eth_to_sol' | 'sol_to_eth' | 'xlm_to_sol' | 'sol_to_xlm';

const DIRECTION_MAP: Record<BridgeDirection, { from: typeof ETH_TOKEN; to: typeof ETH_TOKEN }> = {
  eth_to_xlm: { from: ETH_TOKEN, to: XLM_TOKEN },
  xlm_to_eth: { from: XLM_TOKEN, to: ETH_TOKEN },
  eth_to_sol:  { from: ETH_TOKEN, to: SOL_TOKEN  },
  sol_to_eth:  { from: SOL_TOKEN,  to: ETH_TOKEN },
  xlm_to_sol:  { from: XLM_TOKEN, to: SOL_TOKEN  },
  sol_to_xlm:  { from: SOL_TOKEN,  to: XLM_TOKEN },
};

/**
 * Which wallets a given route needs connected before it can run. Every
 * supported route involves Ethereum; XLM/SOL routes additionally require the
 * matching non-EVM wallet.
 */
function routeWalletsReady(
  direction: BridgeDirection,
  eth: string,
  stellar: string,
  solana: string
): boolean {
  if (direction === 'eth_to_sol' || direction === 'sol_to_eth') {
    return Boolean(eth && solana);
  }
  return Boolean(eth && stellar);
}

const ETH_TO_XLM_RATE = 10000;
const MAINNET_CHAIN_ID = '0x1';

// Helper function to save transaction to localStorage for history
const saveTransactionToHistory = (transaction: {
  orderId: string;
  txHash: string;
  direction: 'eth-to-xlm' | 'xlm-to-eth';
  amount: string;
  estimatedAmount: string;
  ethAddress: string;
  stellarAddress: string;
  ethTxHash?: string;
  stellarTxHash?: string;
  status?: 'pending' | 'completed' | 'failed' | 'cancelled';
  // Optional on-chain metadata so TransactionHistory can offer a Refund button
  // for ETH→XLM swaps once the timelock expires.
  onChainOrderId?: string;
  htlcContractAddress?: string;
  htlcContractMode?: 'v1-mainnet-htlc' | 'v2-escrow';
  timelockUnixSeconds?: number;
  amountWei?: string;
}) => {
  try {
    // Get current network info to determine correct network names
    const isTestnetMode = isTestnet();
    
    const historyTransaction = {
      id: transaction.orderId,
      txHash: transaction.txHash,
      fromNetwork: transaction.direction === 'eth-to-xlm' 
        ? (isTestnetMode ? 'ETH Sepolia' : 'ETH Mainnet') 
        : (isTestnetMode ? 'Stellar Testnet' : 'Stellar Mainnet'),
      toNetwork: transaction.direction === 'eth-to-xlm' 
        ? (isTestnetMode ? 'Stellar Testnet' : 'Stellar Mainnet') 
        : (isTestnetMode ? 'ETH Sepolia' : 'ETH Mainnet'),
      fromToken: transaction.direction === 'eth-to-xlm' ? 'ETH' : 'XLM',
      toToken: transaction.direction === 'eth-to-xlm' ? 'XLM' : 'ETH',
      amount: transaction.amount,
      estimatedAmount: transaction.estimatedAmount,
      ethAddress: transaction.ethAddress,
      stellarAddress: transaction.stellarAddress,
      status: transaction.status || 'pending',
      timestamp: Date.now(),
      ethTxHash: transaction.ethTxHash,
      stellarTxHash: transaction.stellarTxHash,
      direction: transaction.direction,
      onChainOrderId: transaction.onChainOrderId,
      htlcContractAddress: transaction.htlcContractAddress,
      htlcContractMode: transaction.htlcContractMode,
      timelockUnixSeconds: transaction.timelockUnixSeconds,
      amountWei: transaction.amountWei,
      networkMode: (isTestnetMode ? 'testnet' : 'mainnet') as 'testnet' | 'mainnet',
    };

    // Get existing transactions
    const existing = localStorage.getItem('wafflefinance_transactions_v2');
    const transactions = existing ? JSON.parse(existing) : [];
    
    // Add new transaction
    transactions.unshift(historyTransaction); // Add to beginning
    
    // Keep only last 50 transactions
    if (transactions.length > 50) {
      transactions.splice(50);
    }
    
    // Save back to localStorage
    localStorage.setItem('wafflefinance_transactions_v2', JSON.stringify(transactions));
    
    console.log('💾 Transaction saved to history:', historyTransaction);
  } catch (error) {
    console.error('❌ Failed to save transaction to history:', error);
  }
};

// Helper function to update transaction status in localStorage
const updateTransactionStatus = (orderId: string, status: 'pending' | 'completed' | 'failed' | 'cancelled', additionalData?: any) => {
  try {
    const existing = localStorage.getItem('wafflefinance_transactions_v2');
    if (existing) {
      const transactions = JSON.parse(existing);
      const transactionIndex = transactions.findIndex((tx: any) => tx.id === orderId);
      
      if (transactionIndex !== -1) {
        transactions[transactionIndex].status = status;
        
        // Add additional data if provided
        if (additionalData) {
          Object.assign(transactions[transactionIndex], additionalData);
        }
        
        // Save back to localStorage
        localStorage.setItem('wafflefinance_transactions_v2', JSON.stringify(transactions));
        
        console.log(`💾 Transaction status updated: ${orderId} -> ${status}`);
      } else {
        console.log(`⚠️ Transaction not found for status update: ${orderId}`);
      }
    }
  } catch (error) {
    console.error('❌ Failed to update transaction status:', error);
  }
};

const SEPOLIA_CHAIN_ID = '0xaa36a7'; // 11155111 in hex
const PRODUCTION_API_BASE_URL = 'https://oversync-k36vx.ondigitalocean.app';
const API_BASE_URL = import.meta.env.PROD
  ? ''
  : import.meta.env.VITE_API_BASE_URL || PRODUCTION_API_BASE_URL;
const ENABLE_MOCK_DATA = import.meta.env.VITE_ENABLE_MOCK_DATA === 'true';

export default function BridgeForm({ ethAddress, stellarAddress, solanaAddress, signStellarTransaction }: BridgeFormProps): React.JSX.Element {
  const [direction, setDirection] = useState<BridgeDirection>('eth_to_xlm');
  const [networkInfo, setNetworkInfo] = useState(() => {
    const currentNetwork = getCurrentNetwork();
    const isTestnetMode = isTestnet();
    
    return {
      isTestnet: isTestnetMode,
      ethereum: currentNetwork.ethereum,
      stellar: currentNetwork.stellar,
      expectedChainId: isTestnetMode ? SEPOLIA_CHAIN_ID : MAINNET_CHAIN_ID
    };
  });

  // Update network info when network changes
  useEffect(() => {
    const updateNetworkInfo = () => {
      const currentNetwork = getCurrentNetwork();
      const isTestnetMode = isTestnet();
      
      setNetworkInfo({
        isTestnet: isTestnetMode,
        ethereum: currentNetwork.ethereum,
        stellar: currentNetwork.stellar,
        expectedChainId: isTestnetMode ? SEPOLIA_CHAIN_ID : MAINNET_CHAIN_ID
      });
    };

    // Update immediately
    updateNetworkInfo();

    // Listen for URL changes (network parameter)
    const handleUrlChange = () => {
      updateNetworkInfo();
    };

    // Listen for popstate (browser back/forward)
    window.addEventListener('popstate', handleUrlChange);
    
    // Listen for network changes every second
    const interval = setInterval(updateNetworkInfo, 1000);
    
    return () => {
      window.removeEventListener('popstate', handleUrlChange);
      clearInterval(interval);
    };
  }, []);
  const [amount, setAmount] = useState('');
  const [estimatedAmount, setEstimatedAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderCreated, setOrderCreated] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [balance, setBalance] = useState<string>('0');

  // Mid-session wallet recovery state. When a wallet the active route depends on
  // disconnects (or the EVM chain changes underneath us) we surface a warning,
  // clear stale input, and require reconnection before another order is built.
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<string | null>(null);
  const prevEthRef = useRef(ethAddress);
  const prevStellarRef = useRef(stellarAddress);
  const prevSolanaRef = useRef(solanaAddress ?? '');

  // Real-time exchange rate state.
  //
  // Quotes come from the relayer's /api/prices endpoint, which proxies
  // CoinGecko through a stale-while-revalidate cache (fresh for 15s, served
  // stale up to 60s while a background refresh runs). We deliberately do NOT
  // call CoinGecko from the browser any more — that path is blocked by CORS
  // in production and used to silently fall back to a hardcoded 10,000
  // XLM/ETH rate, which diverged from what the relayer actually settled at
  // swap time. That is the bug behind "I expected 0.07 ETH but only got
  // 0.024 ETH" reports.
  const [exchangeRate, setExchangeRate] = useState<number>(ETH_TO_XLM_RATE);
  const [xlmUsdPrice, setXlmUsdPrice] = useState<number | null>(null);
  const [ethUsdPrice, setEthUsdPrice] = useState<number | null>(null);
  const [priceStateness, setPriceStaleness] = useState<'fresh' | 'stale' | 'fallback' | null>(null);
  const [isLoadingRate, setIsLoadingRate] = useState(false);
  const [rateLastUpdated, setRateLastUpdated] = useState<Date | null>(null);
  
  // Derive from/to tokens from direction map
  const fromToken = DIRECTION_MAP[direction].from;
  const toToken   = DIRECTION_MAP[direction].to;

  // Fetch balance when direction or addresses change
  useEffect(() => {
    let cancelled = false;

    const fetchEthBalance = async (addr: string): Promise<string> => {
      if (!window.ethereum) throw new Error('MetaMask not available');
      const raw = await window.ethereum.request({ method: 'eth_getBalance', params: [addr, 'latest'] });
      return (parseInt(raw, 16) / 1e18).toFixed(4);
    };

    const fetchXlmBalance = async (addr: string): Promise<string> => {
      const response = await fetch(`${networkInfo.stellar.horizonUrl}/accounts/${addr}`);
      if (!response.ok) return '0.0000';
      const data = await response.json();
      const bal = data.balances?.find((b: any) => b.asset_type === 'native')?.balance || '0';
      return parseFloat(bal).toFixed(4);
    };

    const fetchSolBalance = async (addr: string): Promise<string> => {
      const rpcUrl = networkInfo.isTestnet
        ? 'https://api.devnet.solana.com'
        : 'https://api.mainnet-beta.solana.com';
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [addr] }),
      });
      const json = await res.json();
      return (json.result?.value / 1e9 || 0).toFixed(4);
    };

    const loadBalance = async () => {
      const src = DIRECTION_MAP[direction].from;
      if (src.symbol === 'ETH' && ethAddress) {
        setBalance('Loading...');
        try { setBalance(await fetchEthBalance(ethAddress)); } catch { setBalance('0'); }
      } else if (src.symbol === 'XLM' && stellarAddress) {
        setBalance('Loading...');
        try { setBalance(await fetchXlmBalance(stellarAddress)); } catch { setBalance('0'); }
      } else if (src.symbol === 'SOL' && solanaAddress) {
        setBalance('Loading...');
        try { setBalance(await fetchSolBalance(solanaAddress)); } catch { setBalance('0'); }
      } else {
        setBalance('0');
      }
      if (cancelled) return;
    };

    loadBalance();
    return () => { cancelled = true; };
  }, [direction, ethAddress, stellarAddress, solanaAddress, networkInfo.stellar.horizonUrl, networkInfo.isTestnet]);
  
  // Fetch live prices from the relayer whenever the user is about to need a
  // quote. The relayer caches CoinGecko responses for 60s, so a flurry of
  // keystrokes ends up as at most one network round-trip per minute. We use a
  // ref-less cancelled flag to discard responses for stale renders.
  useEffect(() => {
    if (!amount || isNaN(parseFloat(amount))) {
      setEstimatedAmount('');
      return;
    }

    let cancelled = false;

    const computeWith = (prices: { ethUsd: number; xlmUsd: number; solUsd: number }) => {
      const inputAmount = parseFloat(amount);
      const from = DIRECTION_MAP[direction].from.symbol;
      const to   = DIRECTION_MAP[direction].to.symbol;

      const usdOf = (sym: string) =>
        sym === 'ETH' ? prices.ethUsd : sym === 'XLM' ? prices.xlmUsd : prices.solUsd;

      const fromUsd = usdOf(from);
      const toUsd   = usdOf(to);
      if (!fromUsd || !toUsd) return;

      const outputAmount = (inputAmount * fromUsd) / toUsd;
      const decimals = to === 'ETH' || to === 'SOL' ? 6 : 2;
      setEstimatedAmount(outputAmount.toFixed(decimals));
    };

    const updateRateAndCalculate = async () => {
      setIsLoadingRate(true);

      try {
        const res = await fetch(`${API_BASE_URL}/api/prices`);
        if (!res.ok) throw new Error(`prices endpoint returned ${res.status}`);
        const body = await res.json();

        const xlmPerEth = Number(body?.xlmPerEth);
        const ethUsd = Number(body?.ethUsd);
        const xlmUsd = Number(body?.xlmUsd);
        const solUsd = Number(body?.solUsd) || 150; // fallback if not yet in API

        if (!Number.isFinite(xlmPerEth) || xlmPerEth <= 0 || !Number.isFinite(ethUsd) || ethUsd <= 0 || !Number.isFinite(xlmUsd) || xlmUsd <= 0) {
          throw new Error('prices endpoint returned malformed data');
        }

        if (cancelled) return;

        setExchangeRate(xlmPerEth);
        setEthUsdPrice(ethUsd);
        setXlmUsdPrice(xlmUsd);
        setPriceStaleness(body?.staleness ?? 'fresh');
        setRateLastUpdated(new Date(body?.fetchedAt ?? Date.now()));
        computeWith({ ethUsd, xlmUsd, solUsd });
      } catch (err) {
        if (cancelled) return;
        console.warn('Falling back to hardcoded rate:', err);
        setExchangeRate(ETH_TO_XLM_RATE);
        setEthUsdPrice(null);
        setXlmUsdPrice(null);
        setPriceStaleness('fallback');
        setRateLastUpdated(new Date());
        computeWith({ ethUsd: 3500, xlmUsd: 0.35, solUsd: 150 });
      } finally {
        if (!cancelled) setIsLoadingRate(false);
      }
    };

    updateRateAndCalculate();

    return () => {
      cancelled = true;
    };
  }, [amount, direction]);

  // Track the EVM wallet's current chain so a network switch mid-session is
  // detected. The listener is removed on unmount to avoid leaking it.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    let cancelled = false;

    eth
      .request({ method: 'eth_chainId' })
      .then((id: string) => { if (!cancelled) setWalletChainId(id); })
      .catch(() => { /* wallet locked/unavailable — leave chain unknown */ });

    const handleChainChanged = (id: string) => setWalletChainId(id);
    eth.on('chainChanged', handleChainChanged);

    return () => {
      cancelled = true;
      eth.removeListener('chainChanged', handleChainChanged);
    };
  }, []);

  // Detect when a wallet the active route depends on drops mid-session and
  // recover: warn the user, clear half-entered input, and fall back to the
  // default ETH→XLM route if the dropped wallet was route-specific (XLM/SOL).
  useEffect(() => {
    const solana = solanaAddress ?? '';
    const ethDropped = Boolean(prevEthRef.current) && !ethAddress;
    const stellarDropped = Boolean(prevStellarRef.current) && !stellarAddress;
    const solanaDropped = Boolean(prevSolanaRef.current) && !solana;

    prevEthRef.current = ethAddress;
    prevStellarRef.current = stellarAddress;
    prevSolanaRef.current = solana;

    const needsStellar = direction === 'eth_to_xlm' || direction === 'xlm_to_eth';
    const needsSolana = direction === 'eth_to_sol' || direction === 'sol_to_eth';

    const dropped: string[] = [];
    if (ethDropped) dropped.push('Ethereum');
    if (needsStellar && stellarDropped) dropped.push('Stellar');
    if (needsSolana && solanaDropped) dropped.push('Solana');

    if (dropped.length === 0) return;

    setRecoveryNotice(
      `${dropped.join(' and ')} wallet ${dropped.length > 1 ? 'connections' : 'connection'} lost. Reconnect to continue.`
    );
    setAmount('');
    setEstimatedAmount('');
    setIsSubmitting(false);

    // Route invalidation: a route-specific wallet vanished, so the selected
    // route can no longer run. Drop back to the default ETH→XLM route.
    if ((needsStellar && stellarDropped) || (needsSolana && solanaDropped)) {
      setDirection('eth_to_xlm');
    }
  }, [ethAddress, stellarAddress, solanaAddress, direction]);

  // Clear the recovery warning once the active route's wallets reconnect.
  const routeReady = routeWalletsReady(direction, ethAddress, stellarAddress, solanaAddress ?? '');
  useEffect(() => {
    if (routeReady && recoveryNotice) {
      setRecoveryNotice(null);
    }
  }, [routeReady, recoveryNotice]);

  // EVM network mismatch (e.g. the user switched MetaMask to the wrong chain).
  const chainMismatch =
    Boolean(ethAddress) &&
    walletChainId !== null &&
    walletChainId.toLowerCase() !== networkInfo.expectedChainId.toLowerCase();

  // Yön değiştirme — cycles ETH↔XLM, ETH↔SOL; Solana routes only if wallet connected
  const handleSwapDirection = () => {
    setDirection(prev => {
      const isSolanaRoute = prev === 'eth_to_sol' || prev === 'sol_to_eth';
      if (isSolanaRoute) return prev === 'eth_to_sol' ? 'sol_to_eth' : 'eth_to_sol';
      return prev === 'eth_to_xlm' ? 'xlm_to_eth' : 'eth_to_xlm';
    });
    setAmount('');
    setEstimatedAmount('');
  };

  // Form gönderimi - RELAYER API ÜZERİNDEN
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Stale-state guard: never build or submit a transaction after the wallets
    // this route needs have disconnected, or the EVM chain changed under us.
    if (recoveryNotice || !routeWalletsReady(direction, ethAddress, stellarAddress, solanaAddress ?? '')) {
      setRecoveryNotice(prev => prev ?? 'Wallet disconnected. Reconnect to continue.');
      return;
    }
    if (chainMismatch) {
      // The network-mismatch banner already tells the user what to do; refuse
      // to submit against the wrong chain rather than silently misrouting.
      return;
    }

    // Log transaction details
    console.log('🚀 Transaction Started:', { 
      direction: direction === 'eth_to_xlm' ? 'ETH → XLM' : 'XLM → ETH',
      amount,
      from: direction === 'eth_to_xlm' ? ethAddress : stellarAddress,
      to: direction === 'eth_to_xlm' ? stellarAddress : ethAddress
    });
    
    if (!amount || !ethAddress || !stellarAddress) {
      console.error('❌ Missing required fields');
      if (isSolanaDirection) {
        if (!solanaAddress) { alert('Please connect your Phantom wallet.'); return; }
      } else {
              alert('Please fill all fields and connect wallets.');
      }
      return;
    }
    
    setIsSubmitting(true);
    setStatusMessage('Hazırlanıyor...');
    
    let result: any;
    
    try {
      // For Solana-only routes, skip ETH network check and jump to SOL handling
      if (!isSolanaDirection) {
      // Check network and switch if needed
      console.log('🔗 Checking network...');
      console.log('🔗 Expected network info:', networkInfo);
      
      const chainId = await window.ethereum?.request({ method: 'eth_chainId' });
      console.log('🔗 Current chain ID:', chainId);
      console.log('🔗 Expected chain ID:', networkInfo.expectedChainId);
      
      if (chainId !== networkInfo.expectedChainId) {
        const networkName = networkInfo.isTestnet ? 'Sepolia Testnet' : 'Ethereum Mainnet';
        console.log(`🔗 Switching to ${networkName}...`);
        
        try {
          await window.ethereum?.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: networkInfo.expectedChainId }],
          });
          console.log(`✅ Successfully switched to ${networkName}`);
        } catch (switchError: any) {
          console.log('🔄 Network switch error:', switchError);
          if (switchError.code === 4902) {
            // Network not added yet
            const networkConfig = networkInfo.isTestnet ? {
                chainId: SEPOLIA_CHAIN_ID,
                chainName: 'Sepolia Testnet',
                rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
                blockExplorerUrls: ['https://sepolia.etherscan.io'],
                nativeCurrency: {
                  name: 'SepoliaETH',
                  symbol: 'SEP',
                  decimals: 18
                }
            } : {
              chainId: MAINNET_CHAIN_ID,
              chainName: 'Ethereum Mainnet',
              rpcUrls: ['https://ethereum-rpc.publicnode.com'],
              blockExplorerUrls: ['https://etherscan.io'],
              nativeCurrency: {
                name: 'Ether',
                symbol: 'ETH',
                decimals: 18
              }
            };
            
            await window.ethereum?.request({
              method: 'wallet_addEthereumChain',
              params: [networkConfig],
            });
            console.log(`✅ Successfully added and switched to ${networkName}`);
          } else {
            console.error('❌ Network switch failed:', switchError);
            alert(`Please switch MetaMask to ${networkName} manually and try again.`);
            setIsSubmitting(false);
            setStatusMessage('');
            return;
          }
        }
      } else {
        console.log('✅ Network is already correct');
      }

      // Create order request (used by both testnet and mainnet)
      console.log('📋 BEFORE orderRequest creation:', {
        'AMOUNT_BEFORE_REQUEST': amount,
        'AMOUNT_TYPE': typeof amount,
        'EXCHANGE_RATE': exchangeRate,
        'DIRECTION': direction
      });
      
      const orderRequest = {
        fromChain: direction === 'eth_to_xlm' ? 'ethereum' : 'stellar',
        toChain: direction === 'eth_to_xlm' ? 'stellar' : 'ethereum',
        fromToken: direction === 'eth_to_xlm' ? 'ETH' : 'XLM',
        toToken: direction === 'eth_to_xlm' ? 'XLM' : 'ETH',
        amount: amount,
        ethAddress: ethAddress,
        stellarAddress: stellarAddress,
        direction: direction,
        exchangeRate: exchangeRate, // Include real-time rate
        networkMode: networkInfo.isTestnet ? 'testnet' : 'mainnet' // DYNAMIC NETWORK
      };
      
      console.log('📋 AFTER orderRequest creation:', {
        'orderRequest.amount': orderRequest.amount,
        'orderRequest_full': orderRequest
      });
      
      if (networkInfo.isTestnet) {
        // TESTNET: Use existing relayer system
        console.log('🔄 Creating bridge order via Relayer API (Testnet)...');
        setStatusMessage('Creating order...');
      
      console.log('📋 Order request:', orderRequest);
      
      // Send request to relayer
      const response = await fetch(`${API_BASE_URL}/api/orders/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderRequest)
      });
      
      console.log('📥 API Response status:', response.status);
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ API Error:', errorData);
        throw new Error(errorData.error || `API Error: ${response.status}`);
      }
      
        result = await response.json();
      console.log('✅ Order created via relayer:', result);

            } else {
        // MAINNET: Relayer handles 1inch integration
        console.log('🔄 Creating bridge order via Relayer API (Mainnet)...');
        setStatusMessage('Creating mainnet order...');
        
        // Send request to relayer (same as testnet)
        const response = await fetch(`${API_BASE_URL}/api/orders/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(orderRequest)
        });
        
        console.log('📥 Mainnet API Response status:', response.status);
        
        if (!response.ok) {
          const errorData = await response.json();
          console.error('❌ Mainnet API Error:', errorData);
          throw new Error(errorData.error || `Mainnet API Error: ${response.status}`);
        }
        
        result = await response.json();
        console.log('✅ Mainnet order created via relayer:', result);
      }
      } // end if (!isSolanaDirection)
      
      // Handle different transaction types based on direction
      if (direction === 'eth_to_xlm' && (result.approvalTransaction || result.proxyTransaction)) {
        // ETH → XLM: Use MetaMask for ETH transaction
        console.log('🔄 Requesting ETH approval transaction...');
        console.log('📋 Instructions:', result.instructions);
        
        // Use proxyTransaction if available, fallback to approvalTransaction
        const transactionData = result.proxyTransaction || result.approvalTransaction;
        
        try {
          // Validate transaction parameters
          if (!transactionData.to || !transactionData.value) {
            throw new Error('Invalid transaction parameters from relayer');
          }

          // Log transaction details for debugging
          console.log('🔍 Transaction details (CONTRACT INTERACTION):', {
            ...transactionData,
            from: ethAddress
          });
          
          // Check user balance first
          const balance = await window.ethereum?.request({
            method: 'eth_getBalance',
            params: [ethAddress, 'latest']
          });
          console.log('💰 User balance:', balance);
          
          // Additional balance checks
          const balanceWei = BigInt(balance);
          const valueWei = BigInt(transactionData.value);
          const estimatedGasCost = BigInt('0x5208') * BigInt('20000000000'); // Rough estimate
          
          console.log('💰 Balance Analysis:', {
            balanceETH: (Number(balanceWei) / 1e18).toFixed(6),
            requiredETH: (Number(valueWei) / 1e18).toFixed(6),
            estimatedGasCostETH: (Number(estimatedGasCost) / 1e18).toFixed(6),
            totalNeededETH: (Number(valueWei + estimatedGasCost) / 1e18).toFixed(6),
            hasSufficientBalance: balanceWei >= (valueWei + estimatedGasCost)
          });
          
          // Estimate gas if not provided by relayer
          let gasLimit = transactionData.gas;
          if (!gasLimit) {
            try {
              const estimatedGas = await window.ethereum?.request({
                method: 'eth_estimateGas',
                params: [{
                  ...transactionData,
                  from: ethAddress
                }]
              });
              gasLimit = `0x${Math.floor(parseInt(estimatedGas, 16) * 1.2).toString(16)}`; // Add 20% buffer
              console.log('⛽ Estimated gas:', estimatedGas, 'Using:', gasLimit);
            } catch (gasError) {
              console.warn('⚠️ Gas estimation failed, using fallback:', gasError);
              gasLimit = '0x493E0'; // 300000 fallback for contract interaction
            }
          }
          
          // ESCROW FACTORY DIRECT MODE: Using direct contract interaction
          console.log('🏭 ESCROW FACTORY DIRECT MODE: Using direct contract transaction');
          console.log('📋 Transaction details:', {
            ...transactionData,
            from: ethAddress,
            gas: gasLimit
          });
          
          const txHash = await window.ethereum?.request({
            method: 'eth_sendTransaction',
            params: [{
              ...transactionData,
              from: ethAddress,
              gas: gasLimit
            }],
          });
          
          // ALWAYS log transaction details (production too)
          console.log('✅ ETH Transaction Sent!');
          console.log('📋 TX Hash:', txHash);
          console.log('🔗 View on Etherscan:', `${networkInfo.ethereum.explorerUrl}/tx/${txHash}`);
          
          // Update UI status
          setStatusMessage('Gönderiliyor...');
          setIsSubmitting(true);
          
          // Update status to confirmation waiting
          setStatusMessage('Confirming...');
          
          // Wait for transaction receipt to confirm success
          let receipt = null;
          let attempts = 0;
          const maxAttempts = 120; // Wait max 2 minutes (1s * 120 = 120s)
          
          while (!receipt && attempts < maxAttempts) {
            try {
              // First try to get transaction status
              const txStatus = await window.ethereum?.request({
                method: 'eth_getTransactionByHash',
                params: [txHash]
              });
              
              if (txStatus && txStatus.blockNumber) {
                console.log('✅ Transaction confirmed via block number!');
                receipt = { status: '0x1' }; // Assume success if confirmed
                break;
              }
              
              // Then try to get receipt
              receipt = await window.ethereum?.request({
                method: 'eth_getTransactionReceipt',
                params: [txHash]
              });
              
              if (!receipt) {
                // Only log every 10 attempts to reduce spam
                if ((attempts + 1) % 10 === 0 || attempts === 0) {
                  console.log(`⏳ Waiting for confirmation... (${attempts + 1}/${maxAttempts})`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                attempts++;
              } else {
                console.log('✅ Transaction receipt found!');
                break;
              }
            } catch (receiptError) {
              console.warn('⚠️ Error getting receipt:', receiptError);
              attempts++;
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
          
          if (!receipt) {
            // Try alternative method - check transaction status directly
            console.log('🔄 Receipt not found, trying alternative confirmation method...');
            
            try {
              const txStatus = await window.ethereum?.request({
                method: 'eth_getTransactionByHash',
                params: [txHash]
              });

              if (txStatus && txStatus.blockNumber) {
                console.log('✅ Transaction confirmed via alternative method!');
                receipt = { status: '0x1' }; // Assume success if confirmed
              } else {
                throw new Error('Transaction confirmation timeout');
              }
            } catch (altError) {
              console.error('❌ Alternative confirmation also failed:', altError);
              throw new Error('Transaction confirmation timeout');
            }
          }
          
          // Check transaction status
          const isSuccess = receipt.status === '0x1';
          console.log('📋 Transaction status:', receipt.status, isSuccess ? '✅ SUCCESS' : '❌ FAILED');
          
          if (!isSuccess) {
            throw new Error('Transaction failed on blockchain');
          }
          
          console.log('✅ Transaction confirmed successfully!');
          console.log('🤖 Now triggering cross-chain processing...');

          // Pull the full receipt (we may have only a {status} stub from the
          // alt-path above). Logs are required to parse refund metadata.
          let refundMeta: ReturnType<typeof parseHtlcReceipt> = null;
          try {
            const fullReceipt = await window.ethereum?.request({
              method: 'eth_getTransactionReceipt',
              params: [txHash],
            });
            refundMeta = parseHtlcReceipt(fullReceipt?.logs);
            if (refundMeta) {
              console.log('🛡️ Refund metadata captured:', refundMeta);
            } else {
              console.warn('⚠️ No HTLC OrderCreated event in receipt; refund button will be hidden for this tx.');
            }
          } catch (parseErr) {
            console.warn('⚠️ Failed to load full receipt for refund metadata:', parseErr);
          }

          // Save transaction to history immediately when ETH tx confirms
          saveTransactionToHistory({
            orderId: result.orderId,
            txHash: txHash,
            direction: 'eth-to-xlm',
            amount: amount,
            estimatedAmount: estimatedAmount,
            ethAddress: ethAddress,
            stellarAddress: stellarAddress,
            ethTxHash: txHash,
            status: 'pending', // Initial status, will update after processing
            onChainOrderId: refundMeta?.orderId,
            htlcContractAddress: refundMeta?.contractAddress,
            htlcContractMode: refundMeta?.contractMode,
            timelockUnixSeconds: refundMeta?.timelockUnixSeconds,
            amountWei: refundMeta?.amountWei,
          });
          
          // Update status to cross-chain processing
          setStatusMessage('Bridging...');
          
          // Show success with transaction hash
          setOrderId(txHash);
          setOrderCreated(true);
          
          // ONLY process if Ethereum transaction was successful
          console.log('⚡ Triggering cross-chain processing after successful ETH tx...');
          
          // Debug: Check order data before processing
          console.log('🔍 DEBUG Process Request:', {
            resultOrderId: result.orderId,
            resultOrderIdType: typeof result.orderId,
            txHash: txHash,
            txHashType: typeof txHash,
            stellarAddress: stellarAddress,
            ethAddress: ethAddress,
            fullResult: result
          });
          
          try {
            const processResponse = await fetch(`${API_BASE_URL}/api/orders/process`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                orderId: result.orderId,
                txHash: txHash,
                stellarAddress: stellarAddress,
                ethAddress: ethAddress
              })
            });
            
            if (processResponse.ok) {
              const processResult = await processResponse.json();
              console.log('✅ Cross-chain processing initiated:', processResult);
              console.log('🌟 Stellar transaction:', processResult.stellarTxId);
              console.log('💫 Expected XLM amount:', processResult.details?.stellar?.amount);
              
              // Update transaction status to completed
              updateTransactionStatus(result.orderId, 'completed', {
                stellarTxHash: processResult.stellarTxId
              });
              
              console.log('🎉 Cross-Chain Bridge Completed!');
              console.log('📋 Stellar TX:', processResult.stellarTxId);
              
              // Update status to completed
              setStatusMessage('Tamamlandı ✅');
              setIsSubmitting(false);
            } else {
              console.error('❌ Processing request failed:', processResponse.status);

              if (ENABLE_MOCK_DATA) {
                console.log('🧪 Mock data enabled: showing success despite processing failure');
                updateTransactionStatus(result.orderId, 'completed');
                setStatusMessage('Completed ✅');
                setIsSubmitting(false);
                setOrderId(txHash);
                setOrderCreated(true);
              } else {
                updateTransactionStatus(result.orderId, 'failed');
                setStatusMessage('İşlem başarısız ❌');
                setIsSubmitting(false);
              }
            }
          } catch (processError) {
            console.error('❌ Processing request error:', processError);

            if (ENABLE_MOCK_DATA) {
              console.log('🧪 Mock data enabled: showing success despite processing error');
              updateTransactionStatus(result.orderId, 'completed');
              setStatusMessage('Completed ✅');
              setIsSubmitting(false);
              setOrderId(txHash);
              setOrderCreated(true);
            } else {
              updateTransactionStatus(result.orderId, 'failed');
              setStatusMessage('İşlem başarısız ❌');
              setIsSubmitting(false);
            }
          }
          
          // Store transaction details for tracking
          console.log('Order approved:', {
            orderId: result.orderId,
            approvalTxHash: txHash,
            fromToken,
            toToken,
            amount,
            estimatedAmount,
            ethAddress,
            stellarAddress,
            direction,
            message: result.message,
            nextStep: result.nextStep
          });
          
        } catch (txError: any) {
          console.error('❌ Approval transaction failed:', txError);
          
          // Update status to failed
          setStatusMessage('Failed ❌');
          setIsSubmitting(false);
          
          console.error('🔍 Full error details:', {
            code: txError.code,
            message: txError.message,
            data: txError.data,
            stack: txError.stack
          });
          
          // Handle MetaMask errors with more specific messages
          if (txError.code === 4001) {
            alert('Transaction was rejected by user');
          } else if (txError.code === -32603) {
            alert('Transaction failed. Please check your balance and try again.');
          } else if (txError.code === -32000) {
            alert('Insufficient funds for gas * price + value');
          } else if (txError.code === -32602) {
            alert('Invalid transaction parameters');
          } else {
            const errorMsg = txError.message || txError.reason || 'Unknown error occurred';
            alert(`Transaction error: ${errorMsg}`);
          }
          return; // Don't show success if transaction failed
        }
      } else if (direction === 'xlm_to_eth') {
        // XLM → ETH: Use Freighter for Stellar transaction
        console.log('🔄 Creating Stellar payment transaction...');
        console.log('💰 Sending', result.orderData.stellarAmount, 'stroops to relayer');
        
        try {
          // Use network configuration to determine correct Horizon URL and network
          const stellarServer = new Horizon.Server(networkInfo.stellar.horizonUrl);
          const stellarNetworkPassphrase = networkInfo.stellar.networkPassphrase;
          const relayerStellarAddress = result.orderData.stellarAddress; // Use relayer provided address
          
          console.log(`🔗 Using Stellar ${networkInfo.isTestnet ? 'testnet' : 'mainnet'}:`, {
            horizonUrl: networkInfo.stellar.horizonUrl,
            networkPassphrase: stellarNetworkPassphrase,
            relayerAddress: relayerStellarAddress,
            memo: result.orderData.memo
          });
          
          // Get user's account to build transaction
          const userAccount = await stellarServer.loadAccount(stellarAddress);
          
          // Create payment to relayer using exact amounts from relayer
          const xlmAmount = (parseInt(result.orderData.stellarAmount) / 10000000).toFixed(7); // Convert stroops to XLM
          const payment = Operation.payment({
            destination: relayerStellarAddress,
            asset: Asset.native(), // XLM
            amount: xlmAmount
          });
          
          console.log('💰 Payment details:', {
            destination: relayerStellarAddress,
            amount: xlmAmount + ' XLM',
            stroops: result.orderData.stellarAmount,
            memo: result.orderData.memo
          });

          // Build transaction with correct network
          const transaction = new TransactionBuilder(userAccount, {
            fee: '100', // Normal Stellar fee (100 stroops)
            networkPassphrase: stellarNetworkPassphrase
          })
            .addOperation(payment)
            .addMemo(Memo.text(result.orderData.memo)) // Use exact memo from relayer
            .setTimeout(300)
            .build();

          console.log('📝 Signing transaction with Freighter...');
          
          // Sign with Freighter using correct network
          const signedXdr = await signStellarTransaction(transaction.toXDR(), stellarNetworkPassphrase);
          
          console.log('✅ Stellar transaction signed!');
          
          // Submit signed transaction to Stellar network
          const signedTx = TransactionBuilder.fromXDR(signedXdr, stellarNetworkPassphrase);
          const submitResult = await stellarServer.submitTransaction(signedTx);
          
          // ALWAYS log transaction details (production too)
          console.log('✅ Stellar Transaction Sent!');
          console.log('📋 TX Hash:', submitResult.hash);
          console.log('🔗 View on Stellar:', `${networkInfo.stellar.explorerUrl}/tx/${submitResult.hash}`);
          
          // Save transaction to history immediately when XLM tx submits
          saveTransactionToHistory({
            orderId: result.orderId,
            txHash: submitResult.hash,
            direction: 'xlm-to-eth',
            amount: amount,
            estimatedAmount: estimatedAmount,
            ethAddress: ethAddress,
            stellarAddress: stellarAddress,
            stellarTxHash: submitResult.hash,
            status: 'pending' // Initial status, will update after ETH processing
          });
          
          // Show success
          setOrderId(submitResult.hash);
          setOrderCreated(true);
          
          // Process the order on backend
          console.log('⚡ Triggering ETH release...');
          
          const requestBody = {
            orderId: result.orderId,
            stellarTxHash: submitResult.hash,
            stellarAddress: stellarAddress,
            ethAddress: ethAddress,
            networkMode: networkInfo.isTestnet ? 'testnet' : 'mainnet'  // ✅ Send network mode to backend
          };
          
          console.log('🔍 FRONTEND DEBUG: XLM→ETH request body:', JSON.stringify(requestBody, null, 2));
          console.log('🔍 FRONTEND DEBUG: API_BASE_URL:', API_BASE_URL);
          
          try {
            const processResponse = await fetch(`${API_BASE_URL}/api/orders/xlm-to-eth`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(requestBody)
            });
            
            if (processResponse.ok) {
              const processResult = await processResponse.json();
              console.log('✅ ETH release initiated:', processResult);
              console.log('💰 Expected ETH amount:', result.orderData?.targetAmount || 'unknown', 'wei');
              
              // Update transaction status to completed
              updateTransactionStatus(result.orderId, 'completed', {
                ethTxHash: processResult.ethTxId
              });
              
              console.log('🎉 Cross-Chain Bridge Completed!');
              console.log('📋 ETH TX:', processResult.ethTxId);
              
              // Update status to completed
              setStatusMessage('Completed ✅');
              setIsSubmitting(false);
              
            } else {
              const errorData = await processResponse.text();
              console.error('❌ ETH release failed:', processResponse.status);
              console.error('❌ Error response body:', errorData);
              
              // Try to parse error details
              let parsedError: any = null;
              try {
                parsedError = JSON.parse(errorData);
                console.error('❌ Parsed error details:', parsedError);
              } catch (parseError) {
                console.error('❌ Could not parse error response as JSON');
              }
              
              // Check if automatic refund was processed by backend
              if (parsedError?.refund?.status === 'completed') {
                console.log('✅ Automatic refund completed:', parsedError.refund.stellarTxHash);

                // Persist refund metadata so TransactionHistory can render a
                // "Refunded · view Stellar tx" link. We keep status=cancelled
                // (the swap didn't go through) but make the refund discoverable.
                updateTransactionStatus(result.orderId, 'cancelled', {
                  refundTxHash: parsedError.refund.stellarTxHash,
                  refundNetwork: 'stellar',
                  refundedAt: Date.now(),
                });
                
                setStatusMessage('Refunded ↩️');
                setIsSubmitting(false);
                
                alert(
                  `ETH transfer failed, but your XLM has been automatically refunded to your wallet.\n\n` +
                  `Refund TX: ${parsedError.refund.stellarTxHash}\n\n` +
                  `Reason: ${parsedError.details || 'Unknown'}`
                );
              } else {
                // Refund failed or not attempted - inform user with manual refund instructions
                console.error('❌ Automatic refund failed:', parsedError?.refund);
                
                updateTransactionStatus(result.orderId, 'failed', {
                  autoRefundFailed: parsedError?.refund?.status === 'failed',
                  autoRefundError: parsedError?.refund?.error,
                });
                
                setStatusMessage('Failed ❌');
                setIsSubmitting(false);
                
                const refundInfo = parsedError?.refund 
                  ? `\n\nAutomatic refund failed: ${parsedError.refund.error}\n\n` +
                    `To recover your XLM, contact support with:\n` +
                    `- Stellar TX: ${submitResult.hash}\n` +
                    `- Stellar Address: ${stellarAddress}`
                  : '';
                
                alert(`ETH sending failed: ${parsedError?.details || errorData}${refundInfo}`);
              }
            }
          } catch (processError: any) {
            console.error('❌ ETH release network error:', processError);
            console.error('❌ Error details:', {
              message: processError.message,
              name: processError.name,
              stack: processError.stack
            });
            
            // Update status to failed
                          setStatusMessage('Network error ❌');
            setIsSubmitting(false);
            
            // Update transaction status to failed
            updateTransactionStatus(result.orderId, 'failed');
            
            // Show error to user  
                          alert(`ETH sending network error: ${processError.message}`);
          }

        } catch (stellarError: any) {
          console.error('❌ Stellar transaction failed:', stellarError);
          
          // Handle Freighter errors
          if (stellarError.message?.includes('User declined')) {
            alert('Stellar transaction was rejected by user');
          } else {
            alert(`Stellar transaction error: ${stellarError.message || 'Unknown error occurred'}`);
          }
          return;
        }
      } else if (direction === 'eth_to_sol' || direction === 'sol_to_eth') {
        // SOL routes: Anchor program is in simulation mode — announce the order
        // to the coordinator so the relayer can pick it up once the on-chain
        // program is live.
        console.log(`🔄 Solana bridge (${direction}) — coordinator announce`);
        setStatusMessage('Announcing order...');

        const solAmountLamports = Math.round(parseFloat(estimatedAmount || amount) * 1e9).toString();
        const ethAmountWei = (BigInt(Math.round(parseFloat(amount) * 1e9)) * BigInt(1e9)).toString();

        const announceBody = direction === 'eth_to_sol'
          ? {
              direction: 'eth_to_sol',
              hashlock: `0x${'0'.repeat(64)}`, // placeholder — real hashlock set by relayer
              srcChain: 'ethereum', srcAddress: ethAddress,
              srcAsset: 'native', srcAmount: ethAmountWei, srcSafetyDeposit: '0',
              dstChain: 'solana', dstAddress: solanaAddress,
              dstAsset: 'native', dstAmount: solAmountLamports,
            }
          : {
              direction: 'sol_to_eth',
              hashlock: `0x${'0'.repeat(64)}`,
              srcChain: 'solana', srcAddress: solanaAddress,
              srcAsset: 'native', srcAmount: solAmountLamports, srcSafetyDeposit: '0',
              dstChain: 'ethereum', dstAddress: ethAddress,
              dstAsset: 'native', dstAmount: ethAmountWei,
            };

        const announceRes = await fetch(`${API_BASE_URL}/api/orders/announce`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(announceBody),
        });

        if (!announceRes.ok) {
          const err = await announceRes.json().catch(() => ({}));
          throw new Error(err.error || `Coordinator error: ${announceRes.status}`);
        }

        const announced = await announceRes.json();
        console.log('✅ Solana order announced:', announced);

        saveTransactionToHistory({
          orderId: announced.publicId ?? announced.orderId ?? 'sol-' + Date.now(),
          txHash: announced.publicId ?? 'pending',
          direction: direction === 'eth_to_sol' ? 'eth-to-xlm' : 'xlm-to-eth',
          amount, estimatedAmount,
          ethAddress, stellarAddress: solanaAddress ?? '',
          status: 'pending',
        });

        setOrderId(announced.publicId ?? announced.orderId);
        setOrderCreated(true);
        setStatusMessage('Order announced ✅');
        setIsSubmitting(false);
      } else {
        // Fallback: show order created without transaction
        setOrderId(result.orderId);
        setOrderCreated(true);
        
        console.log('Order created (no transaction):', {
          orderId: result.orderId,
          fromToken,
          toToken,
          amount,
          estimatedAmount,
          ethAddress,
          stellarAddress,
          direction
        });
      }
      
    } catch (error: any) {
      console.error('❌ Error creating order:', error);
      
      // Show error message
      alert(`Error: ${error.message || 'Unknown error occurred'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Form reset
  const handleReset = () => {
    setAmount('');
    setEstimatedAmount('');
    setOrderCreated(false);
    setOrderId(null);
  };

  // Check if wallets are connected
  const isSolanaDirection = direction === 'eth_to_sol' || direction === 'sol_to_eth';
  const walletsConnected = isSolanaDirection
    ? (direction === 'eth_to_sol' ? (ethAddress && solanaAddress) : (solanaAddress && ethAddress))
    : (ethAddress && stellarAddress);

  return (
    <div className="w-full rounded-[1.25rem] p-4 swap-card-bg swap-card-border md:p-5 lg:p-6">
      {orderCreated ? (
        <div className="space-y-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-300/25 bg-emerald-300/12 shadow-[0_18px_48px_rgba(16,185,129,0.18)]">
            <CheckCircle2 className="h-8 w-8 text-emerald-200" />
          </div>
          
          <div>
            <h3 className="mb-2 text-2xl font-semibold tracking-tight text-white">Order Created</h3>
            <p className="text-slate-300">
              Your cross-chain order has been successfully created and is now processing.
            </p>
          </div>
          
          <div className="surface-panel rounded-2xl p-4 text-left">
            <div className="mb-2">
              <span className="text-sm text-slate-400">Order ID:</span>
              <p className="font-mono text-white text-sm break-all">{orderId}</p>
            </div>
            <div className="mb-2">
              <span className="text-sm text-slate-400">From:</span>
              <p className="text-white">{amount} {fromToken.symbol}</p>
            </div>
            <div>
              <span className="text-sm text-slate-400">To:</span>
              <p className="text-white">{estimatedAmount} {toToken.symbol}</p>
            </div>
          </div>
          
          <div className="pt-4">
            <button
              onClick={handleReset}
              className="button-hover-scale brand-cta w-full rounded-full py-3 font-semibold transition"
            >
              New Bridge
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="mb-1 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/55">Bridge console</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="rounded-full border border-cyan-200/15 bg-white/[0.055] p-2 text-slate-300 transition hover:border-cyan-200/35 hover:bg-cyan-200/10 hover:text-cyan-50" title="Refresh quote">
                <RefreshCw className="h-4 w-4" />
              </button>
              <button type="button" className="rounded-full border border-cyan-200/15 bg-white/[0.055] p-2 text-slate-300 transition hover:border-cyan-200/35 hover:bg-cyan-200/10 hover:text-cyan-50" title="Bridge settings">
                <Settings2 className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Route selector */}
          <div className="flex gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-1">
            {(['eth_to_xlm', 'xlm_to_eth', 'eth_to_sol', 'sol_to_eth'] as const).map((d) => {
              const labels: Record<string, string> = {
                eth_to_xlm: 'ETH → XLM', xlm_to_eth: 'XLM → ETH',
                eth_to_sol: 'ETH → SOL', sol_to_eth: 'SOL → ETH',
              };
              const isSol = d === 'eth_to_sol' || d === 'sol_to_eth';
              const active = direction === d;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => { setDirection(d); setAmount(''); setEstimatedAmount(''); }}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[0.65rem] font-semibold transition ${
                    active
                      ? isSol
                        ? 'bg-purple-500/25 text-purple-200 border border-purple-500/30'
                        : 'bg-[#4f6bff]/25 text-[#a8b4ff] border border-[#4f6bff]/30'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {labels[d]}
                </button>
              );
            })}
          </div>

          {/* From Section */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100/55">You pay</label>
            <div className="token-input-panel rounded-2xl p-3 input-container">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <img
                    src={fromToken.logo}
                    alt={fromToken.symbol}
                    className="h-7 w-7 rounded-full"
                  />
                  <div>
                    <span className="font-medium text-white">{fromToken.symbol}</span>
                    <span className="ml-2 text-xs text-slate-400">on {fromToken.chain}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => {
                    setAmount(sanitizeAmountInput(e.target.value, fromToken.decimals));
                  }}
                  onPaste={(e) => {
                    e.preventDefault();
                    const pasted = e.clipboardData.getData('text');
                    setAmount(sanitizeAmountInput(pasted, fromToken.decimals));
                  }}
                  placeholder="0.0"
                  className="min-w-0 flex-1 bg-transparent text-2xl font-semibold tracking-tight text-white outline-none placeholder:text-slate-500"
                />
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const newAmount = (parseFloat(balance) * 0.5).toFixed(4);
                      console.log('🔘 50% Button clicked:', { balance, newAmount });
                      setAmount(newAmount);
                    }}
                    className="rounded-full border border-cyan-200/25 bg-cyan-200/[0.08] px-2.5 py-1 text-xs font-semibold text-cyan-100 transition hover:border-cyan-100/40 hover:bg-cyan-200/15"
                  >
                    50%
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      console.log('🔘 MAX Button clicked:', { balance });
                      setAmount(balance);
                    }}
                    className="rounded-full border border-cyan-200/25 bg-cyan-200/[0.08] px-2.5 py-1 text-xs font-semibold text-cyan-100 transition hover:border-cyan-100/40 hover:bg-cyan-200/15"
                  >
                    Max
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="text-sm text-slate-500">$0.00</div>
                <div className="truncate text-sm text-slate-400">
                  Balance: {balance} {fromToken.symbol}
                </div>
              </div>
            </div>
          </div>

          {/* Direction Button */}
          <div className="relative z-10 -my-2 flex justify-center">
            <button
              type="button"
              onClick={handleSwapDirection}
              className="button-hover-scale rounded-full border border-cyan-200/35 bg-[#081029] p-2.5 text-cyan-50 shadow-[0_14px_38px_rgba(0,0,0,0.4),0_0_24px_rgba(0,226,255,0.12)] transition hover:border-cyan-100/55 hover:bg-[#0d1735]"
            >
              <ArrowDownUp className="h-5 w-5" />
            </button>
          </div>

          {/* To Section */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100/55">You receive</label>
            <div className="token-input-panel rounded-2xl p-3 input-container">
              <div className="mb-2 flex items-center gap-2">
                <img
                  src={toToken.logo}
                  alt={toToken.symbol}
                  className="h-7 w-7 rounded-full"
                />
                <div>
                  <span className="font-medium text-white">{toToken.symbol}</span>
                  <span className="ml-2 text-xs text-slate-400">on {toToken.chain}</span>
                </div>
              </div>

              <div className="min-h-[2rem] text-2xl font-semibold tracking-tight text-white">
                {estimatedAmount || '0.0'}
              </div>
              <div className="mt-1 text-xs text-slate-500">$0.00</div>
            </div>
          </div>
          
          {/* Fee and Time Estimate */}
          <div className="flex items-center justify-between px-1 text-xs text-slate-400">
            <div>Fee: $0.00</div>
            <div>~1 min</div>
          </div>

          {/* Exchange Rate Info */}
          <div className="surface-panel rounded-2xl p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-200">
                  <span>Exchange rate</span>
                  {priceStateness === 'fresh' && (
                    <span
                      className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-emerald-300"
                      title="Price data is fresh (within 15s)"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      live
                    </span>
                  )}
                  {priceStateness === 'stale' && (
                    <span
                      className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-yellow-300"
                      title="Price data is stale (15–60s old). A background refresh is in progress."
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                      stale
                    </span>
                  )}
                  {priceStateness === 'fallback' && (
                    <span
                      className="text-[10px] uppercase tracking-wide text-indigo-200"
                      title="The relayer price feed is unreachable; this is a hardcoded estimate."
                    >
                      fallback
                    </span>
                  )}
                </div>
                {isLoadingRate ? (
                  <div className="flex items-center gap-1 text-xs text-cyan-200">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Updating...
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">
                    {rateLastUpdated && `Updated ${rateLastUpdated.toLocaleTimeString()}`}
                  </div>
                )}
              </div>
              <div className="text-xs text-white">
                1 ETH = {exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM
                <span className="ml-1.5 text-slate-500">
                  · 1 XLM = {(1 / exchangeRate).toLocaleString(undefined, { maximumFractionDigits: 8 })} ETH
                </span>
              </div>
              {ethUsdPrice !== null && xlmUsdPrice !== null && (
                <div className="mt-1 text-[11px] text-slate-400">
                  ETH ${ethUsdPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  <span className="mx-1.5 text-slate-600">·</span>
                  XLM ${xlmUsdPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  <span className="mx-1.5 text-slate-600">·</span>
                  via relayer (CoinGecko, 15s SWR)
                </div>
              )}
              {priceStateness === 'stale' && (
                <div className="mt-1 text-[11px] text-yellow-200/70">
                  Prices refreshing in background — quote is from up to 60s ago and is still safe to use.
                </div>
              )}
              {priceStateness === 'fallback' && (
                <div className="mt-1 text-[11px] text-indigo-200/80">
                  Live price feed unreachable. Final swap amount will use the relayer's price at execution time and may differ.
                </div>
              )}
          </div>
          
          {/* Wallet recovery warning */}
          {recoveryNotice && (
            <div role="alert" className="rounded-2xl border border-amber-400/40 bg-amber-500/15 p-3 text-center">
              <div className="font-medium text-amber-100">⚠ {recoveryNotice}</div>
            </div>
          )}

          {/* EVM network mismatch warning */}
          {!recoveryNotice && chainMismatch && (
            <div role="alert" className="rounded-2xl border border-amber-400/40 bg-amber-500/15 p-3 text-center">
              <div className="font-medium text-amber-100">
                ⚠ Your Ethereum wallet is on the wrong network. Switch to{' '}
                {networkInfo.isTestnet ? 'Sepolia Testnet' : 'Ethereum Mainnet'} to continue.
              </div>
            </div>
          )}

          {/* Status Message */}
          {statusMessage && (
            <div className="rounded-2xl border border-cyan-200/30 bg-cyan-200/[0.12] p-3 text-center">
              <div className="font-medium text-cyan-100">{statusMessage}</div>
            </div>
          )}
          
          {/* Submit Button */}
          <button
            type="submit"
            disabled={isSubmitting || !amount || !walletsConnected || !!recoveryNotice || chainMismatch}
            className={`button-hover-scale w-full rounded-full py-3.5 font-semibold transition-all ${
              walletsConnected && !recoveryNotice && !chainMismatch
                ? 'brand-cta'
                : 'cursor-not-allowed border border-white/5 bg-slate-700/45 text-slate-400'
            }`}
          >
            {recoveryNotice
              ? 'Reconnect Wallet'
              : chainMismatch
                ? 'Wrong Network'
                : !walletsConnected
                  ? 'Connect Wallet'
                  : isSubmitting
                    ? statusMessage || 'Processing...'
                    : 'Bridge'
            }
          </button>
        </form>
      )}
    </div>
  );
}

