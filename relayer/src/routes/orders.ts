/**
 * @fileoverview Order management and swap processing routes for the relayer.
 */

import { Router, type Request, type Response } from 'express';
import { ethers } from 'ethers';
import { resolveEthereumRpcUrl, type SupportPolicy } from '@wafflefinance/config';
import { getLogger } from '../logger.js';
import {
  NETWORK_CONFIG,
  getEscrowFactoryAddress,
  getHtlcBridgeAddress,
  getEscrowFactoryABI,
  shouldUseHTLCContract,
  type NetworkMode,
} from '../config/networks.js';
import {
  getPriceSnapshot,
  getRealTimePrices,
  calculateDynamicSafetyDeposit,
  PRICE_CACHE_FRESH_MS,
  PRICE_CACHE_STALE_MS,
} from '../services/pricing-service.js';
import { type OrchestratorHandle } from '../core/event-orchestrator.js';
import { refundXlmToUser, HorizonTimeoutError } from '../services/xlm-refund.js';
import { globalRefundLedger } from '../services/refund-ledger.js';
import { globalStellarProofLedger } from '../services/stellar-proof-ledger.js';
import { globalSettlementFailureStore } from '../services/settlement-failure-store.js';
import {
  classifyFailureCategory,
  ETH_BALANCE_RETRY,
  ETH_SEND_RETRY,
  ETH_CONFIRM_RETRY,
} from '../services/settlement-retry-policy.js';
import { globalRetryEngine } from '../utils/retry-engine.js';
import {
  verifyIncomingStellarPayment,
  StellarTxNotFoundError,
  StellarTxFailedError,
  StellarPaymentMismatch,
} from '../services/horizon-verifier.js';
import {
  decideOrderRoute,
  supportSummary,
} from '../support.js';
import {
  authorizeSettlementCommand,
  checkOrderSettleable,
  type SettlementAccountConfig,
} from '../settlement-permissions.js';
import {
  settlementVerificationTotal,
  settlementProofReplaysTotal,
  orderIngestionTotal,
  orderQueueDepth,
  relayDecisionTotal,
  submissionLatencySeconds,
  receiptLatencySeconds,
  retryAttemptsHistogram,
  droppedOrdersTotal,
} from '../metrics.js';
import {
  hasRecentVisitor,
  markVisitorPresent,
} from '../utils/site-presence.js';
import { needsChainMonitoring } from '../utils/order-poll-utils.js';

const logger = getLogger().child({ component: 'orders-router' });

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

async function runWithSettlementRetry<T>(
  action: string,
  opts: import('../utils/retry-engine.js').RunOptions,
  fn: () => Promise<T>,
  meta: {
    orderId: string;
    direction: string;
    chain: 'ethereum' | 'stellar' | 'unknown';
    recoveredTxHash?: (result: T) => string | undefined;
  },
): Promise<T> {
  if (globalSettlementFailureStore.hasFailed(meta.orderId)) {
    globalSettlementFailureStore.markRecovering(meta.orderId);
  }
  try {
    const result = await globalRetryEngine.run(action, fn, opts);
    if (globalSettlementFailureStore.hasFailed(meta.orderId)) {
      globalSettlementFailureStore.markRecovered(meta.orderId, meta.recoveredTxHash?.(result) ?? '');
    }
    return result;
  } catch (err: unknown) {
    globalSettlementFailureStore.recordFailure({
      orderId: meta.orderId,
      direction: meta.direction,
      category: classifyFailureCategory(err, meta.chain),
      errorMessage: err instanceof Error ? err.message : String(err),
      chain: meta.chain,
      recoveryAction: `RetryEngine exhausted for action=${action}`,
    });
    throw err;
  }
}

export async function processEscrowToStellar(orderId: string, order: Record<string, unknown>) {
  logger.info({ orderId }, 'Processing Escrow → Stellar transfer');
  try {
    const { Horizon, Keypair, Asset, Operation, TransactionBuilder, Networks, BASE_FEE, Memo } =
      await import('@stellar/stellar-sdk');
    const server = new Horizon.Server(NETWORK_CONFIG.mainnet.stellar.horizonUrl);
    const secret = process.env.RELAYER_STELLAR_SECRET_MAINNET ?? process.env.RELAYER_STELLAR_SECRET;
    if (!secret || secret.startsWith('SAXXX')) throw new Error('Relayer Stellar mainnet secret not configured');
    const kp = Keypair.fromSecret(secret);
    const account = await server.loadAccount(kp.publicKey());
    const balance = account.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
    const rate = (order.exchangeRate as number) ?? 10000;
    const weiAmountBig = BigInt(order.amount as string);
    const rateRounded = Math.round(rate);
    if (!Number.isSafeInteger(rateRounded)) {
      throw new RangeError(
        `[processEscrowToStellar] exchangeRate ${rate} exceeds Number.MAX_SAFE_INTEGER`
      );
    }
    const xlmStroops = (weiAmountBig * BigInt(rateRounded)) / 1_000_000_000_000_000_000n;
    const xlmIntPart = xlmStroops / 10_000_000n;
    const xlmFracPart = xlmStroops % 10_000_000n;
    const xlm = `${xlmIntPart}.${xlmFracPart.toString().padStart(7, '0')}`;
    if (parseFloat(balance) < parseFloat(xlm)) throw new Error(`Insufficient XLM: ${balance} < ${xlm}`);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.payment({ destination: order.stellarAddress as string, asset: Asset.native(), amount: xlm }))
      .addMemo(Memo.text(`EscrowBridge:${orderId.substring(0, 20)}`))
      .setTimeout(300).build();
    tx.sign(kp);
    const result = await server.submitTransaction(tx);
    logger.info({ orderId, txHash: result.hash, xlm }, 'Escrow → Stellar XLM sent');
    order.status = 'completed';
    order.stellarTxHash = result.hash;
    order.completedAt = new Date().toISOString();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ orderId, err: message }, 'Escrow → Stellar transfer failed');
    order.status = 'stellar_transfer_failed';
    order.error = message;
  }
}

export interface OrdersRouterOptions {
  relayerConfig: Record<string, unknown>;
  defaultNetworkMode: NetworkMode;
  supportPolicy: SupportPolicy;
  activeOrders: Map<string, Record<string, unknown>>;
  orchestrator: OrchestratorHandle;
  storeActiveOrder: (orderId: string, data: Record<string, unknown>) => Promise<void>;
}

export function ordersRouter(options: OrdersRouterOptions): Router {
  const router = Router();
  const { relayerConfig: RELAYER_CONFIG, defaultNetworkMode: DEFAULT_NETWORK_MODE, supportPolicy, activeOrders, orchestrator, storeActiveOrder } = options;

  router.post('/api/wake', (_req: Request, res: Response) => { markVisitorPresent(); res.status(204).end(); });
  router.get('/api/wake', (_req: Request, res: Response) => { markVisitorPresent(); res.status(204).end(); });

  router.get('/api/debug/chain-monitor', (_req: Request, res: Response) => {
    const statuses: Record<string, number> = {};
    for (const o of activeOrders.values()) {
      const s = String(o.status ?? 'unknown');
      statuses[s] = (statuses[s] ?? 0) + 1;
    }
    res.json({ needsChainMonitoring: needsChainMonitoring(activeOrders), activeOrderCount: activeOrders.size, hasRecentVisitor: hasRecentVisitor(), orderStatuses: statuses });
  });

  router.get('/api/prices', async (_req: Request, res: Response) => {
    try {
      const snap = await getPriceSnapshot();
      res.json({ xlmUsd: snap.xlmUsdPrice, ethUsd: snap.ethUsdPrice, ethPerXlm: snap.xlmUsdPrice / snap.ethUsdPrice, xlmPerEth: snap.ethToXlmRate, source: snap.source, fetchedAt: snap.fetchedAt, cacheFreshMs: PRICE_CACHE_FRESH_MS, cacheStaleMs: PRICE_CACHE_STALE_MS });
    } catch (err: unknown) {
      logger.error({ err }, 'Price feed unavailable');
      res.status(503).json({ error: 'Price feed temporarily unavailable' });
    }
  });

  router.get('/api/support', (_req: Request, res: Response) => {
    const s = supportSummary(supportPolicy);
    res.status(s.actionable ? 200 : 503).json(s);
  });

  router.post('/api/transactions/history', async (req: Request, res: Response) => {
    try {
      const { ethAddress, stellarAddress } = req.body as Record<string, string>;
      const txs = Array.from(activeOrders.values())
        .filter((o) => (ethAddress && o.ethAddress === ethAddress) || (stellarAddress && o.stellarAddress === stellarAddress))
        .map((o) => ({
          id: o.orderId, txHash: o.ethTxHash ?? o.stellarTxHash ?? o.orderId,
          fromNetwork: o.direction === 'eth-to-xlm' ? (DEFAULT_NETWORK_MODE === 'mainnet' ? 'ETH Mainnet' : 'ETH Sepolia') : (DEFAULT_NETWORK_MODE === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet'),
          toNetwork: o.direction === 'eth-to-xlm' ? (DEFAULT_NETWORK_MODE === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet') : (DEFAULT_NETWORK_MODE === 'mainnet' ? 'ETH Mainnet' : 'ETH Sepolia'),
          fromToken: o.direction === 'eth-to-xlm' ? 'ETH' : 'XLM',
          toToken: o.direction === 'eth-to-xlm' ? 'XLM' : 'ETH',
          amount: o.amount ?? '0',
          status: ['completed','failed','cancelled'].includes(o.status as string) ? o.status : 'pending',
          timestamp: o.timestamp ?? Date.now(),
          ethTxHash: o.ethTxHash, stellarTxHash: o.stellarTxHash, direction: o.direction,
        }))
        .sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
      logger.info({ ethAddress, stellarAddress, count: txs.length }, 'Transaction history fetched');
      res.json({ success: true, transactions: txs, count: txs.length });
    } catch (err: unknown) {
      logger.error({ err }, 'Transaction history fetch failed');
      res.status(500).json({ error: 'Failed to fetch transaction history' });
    }
  });

  router.post('/api/orders/create', async (req: Request, res: Response) => {
    try {
      const { fromChain, toChain, fromToken, toToken, amount, ethAddress, stellarAddress, direction, exchangeRate, network, networkMode } = req.body as Record<string, string>;

      if (!fromChain || !toChain || !fromToken || !toToken || !amount || !ethAddress || !stellarAddress) {
        return res.status(400).json({ error: 'Missing required fields', required: ['fromChain','toChain','fromToken','toToken','amount','ethAddress','stellarAddress'] });
      }

      const ingestDir = typeof direction === 'string' ? direction : 'unknown';
      orderIngestionTotal.inc({ direction: ingestDir });

      const routeDecision = decideOrderRoute(supportPolicy, { direction, fromChain, toChain, fromToken });
      if (!routeDecision.supported) {
        relayDecisionTotal.inc({ direction: ingestDir, result: 'rejected_route' });
        logger.warn({ code: routeDecision.code, reason: routeDecision.reason }, 'Order rejected: unsupported route');
        return res.status(400).json({ error: 'Unsupported route', code: routeDecision.code, details: routeDecision.reason, supported: supportSummary(supportPolicy).routes.map((r) => r.id) });
      }

      const denial = checkOrderSettleable(supportPolicy, RELAYER_CONFIG as unknown as SettlementAccountConfig, direction);
      if (denial) {
        relayDecisionTotal.inc({ direction: ingestDir, result: 'rejected_permissions' });
        logger.warn({ code: denial.code }, 'Settlement permission denied');
        return res.status(403).json({ error: 'settlement_permission_denied', code: denial.code, details: denial.reason, command: denial.command, chain: denial.chain });
      }

      relayDecisionTotal.inc({ direction: ingestDir, result: 'accepted' });
      const subTimer = submissionLatencySeconds.startTimer({ direction: ingestDir });
      res.on('finish', () => subTimer({ result: res.statusCode < 400 ? 'success' : 'failure' }));

      const normalizedEth = ethAddress.toLowerCase();
      const orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const reqNet = networkMode ?? network ?? (req.query.network as string) ?? DEFAULT_NETWORK_MODE;
      const isMainnet = reqNet === 'mainnet';

      logger.info({ orderId, direction, reqNet, amount, ethAddress: normalizedEth }, 'Creating bridge order');

      if (direction === 'eth_to_xlm') {
        if (isMainnet) {
          const useHTLC = shouldUseHTLCContract('mainnet');

          if (RELAYER_CONFIG.enableMockMode) {
            const wei = ethers.parseEther(amount);
            const secret = ethers.hexlify(ethers.randomBytes(32));
            const hashLock = ethers.keccak256(secret);
            const orderData = { orderId, direction: 'eth_to_xlm', amount: wei.toString(), ethAddress: normalizedEth, stellarAddress, exchangeRate: exchangeRate ?? 10000, secret, hashLock, created: new Date().toISOString(), status: 'mock_escrow_created', contractType: 'MOCK_1INCH_ESCROW_FACTORY' };
            await storeActiveOrder(orderId, orderData);
            return res.json({ success: true, orderId, orderData, message: 'MOCK: ETH→XLM escrow created', ethereum: { contractAddress: getEscrowFactoryAddress('mainnet', 'mainnet'), method: 'createDstEscrow', amount: amount + ' ETH', hashLock }, stellar: { htlcId: `mock-stellar-htlc-${Date.now()}`, amount: (parseFloat(amount) * 10000).toFixed(7) + ' XLM', hashLock } });
          }

          const { xlmUsdPrice, ethUsdPrice, ethToXlmRate } = await getRealTimePrices();
          const userAmountWei = ethers.parseEther(amount);
          logger.info({ orderId, ethAmount: amount, ethUsdPrice, xlmUsdPrice, xlmAmount: ((parseFloat(amount) * ethUsdPrice) / xlmUsdPrice).toFixed(7) }, 'ETH→XLM mainnet real-time rates');

          const secretBytes = new Uint8Array(32);
          crypto.getRandomValues(secretBytes);
          const secret = `0x${Array.from(secretBytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
          const hashLock = ethers.keccak256(secret);
          const actualSafetyDeposit = await calculateDynamicSafetyDeposit(userAmountWei, reqNet, DEFAULT_NETWORK_MODE);
          const orderHash = ethers.keccak256(ethers.solidityPacked(['address','uint256','bytes32','uint256'], [normalizedEth, userAmountWei, hashLock, Math.floor(Date.now() / 1000)]));

          const orderData = { orderId, orderHash, hashLock, secret, ethAddress: normalizedEth, stellarAddress, amount: userAmountWei.toString(), safetyDeposit: actualSafetyDeposit.toString(), exchangeRate: ethToXlmRate, contractType: 'ONEINCH_ESCROW_FACTORY_MAINNET_DST', status: 'pending_dst_escrow_deployment', network: 'ethereum', chainId: 1, created: new Date().toISOString(), networkMode: reqNet };
          await storeActiveOrder(orderId, orderData);

          const totalCost = userAmountWei + actualSafetyDeposit;
          const dstImmutables = { orderHash, hashlock: hashLock, maker: normalizedEth, taker: '0x0000000000000000000000000000000000000000', token: '0x0000000000000000000000000000000000000000', amount: userAmountWei.toString(), safetyDeposit: actualSafetyDeposit.toString(), timelocks: Math.floor(Date.now() / 1000) + 2 * 60 * 60 };
          const srcTs = Math.floor(Date.now() / 1000) + 4 * 60 * 60;
          const iface = new ethers.Interface(getEscrowFactoryABI(true));
          const encodedData = iface.encodeFunctionData('createDstEscrow', [dstImmutables, srcTs]);

          logger.info({ orderId, orderHash, totalCostEth: ethers.formatEther(totalCost) }, 'Mainnet ETH→XLM order created');
          return res.json({ success: true, orderId, orderData, dstImmutables, srcCancellationTimestamp: srcTs, approvalTransaction: { to: useHTLC ? getHtlcBridgeAddress('mainnet', 'mainnet') : getEscrowFactoryAddress('mainnet', 'mainnet'), value: `0x${totalCost.toString(16)}`, data: encodedData, gas: '0x30D40' }, safetyDeposit: ethers.formatEther(actualSafetyDeposit), totalCost: ethers.formatEther(totalCost), contractType: 'ONEINCH_ESCROW_FACTORY_MAINNET' });
        }

        const secretBytes = new Uint8Array(32);
        crypto.getRandomValues(secretBytes);
        const secret = `0x${Array.from(secretBytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        const hashLock = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        const orderData = { orderId, token: '0x0000000000000000000000000000000000000000', amount: ethers.parseEther(amount).toString(), hashLock, timelock: Math.floor(Date.now() / 1000) + 7201, feeRate: 100, beneficiary: stellarAddress, refundAddress: normalizedEth, destinationChainId: 1, stellarTxHash: null as string | null, partialFillEnabled: false, secret, created: new Date().toISOString(), status: 'pending_direct_escrow', ethAddress: normalizedEth, stellarAddress, exchangeRate: exchangeRate ?? 10000, networkMode: reqNet };
        await storeActiveOrder(orderId, orderData);

        const orderAmtBig = BigInt(orderData.amount);
        const actualSafetyDeposit = await calculateDynamicSafetyDeposit(orderData.amount, reqNet, DEFAULT_NETWORK_MODE);
        const totalCost = orderAmtBig + actualSafetyDeposit;
        const escrowConfig = { token: '0x0000000000000000000000000000000000000000', amount: orderData.amount, hashLock: orderData.hashLock, timelock: orderData.timelock, beneficiary: normalizedEth, refundAddress: normalizedEth, safetyDeposit: actualSafetyDeposit.toString(), chainId: 11155111, stellarTxHash: ethers.ZeroHash, isPartialFillEnabled: false };
        const encodedData = new ethers.Interface(getEscrowFactoryABI(false)).encodeFunctionData('createEscrow', [escrowConfig]);

        logger.info({ orderId, safetyDepositEth: ethers.formatEther(actualSafetyDeposit) }, 'Testnet ETH→XLM order created');
        return res.json({ success: true, orderId, orderData, escrowConfig, approvalTransaction: { to: getEscrowFactoryAddress(reqNet, 'testnet'), value: `0x${totalCost.toString(16)}`, data: encodedData, gas: '0x2DC6C0' }, safetyDeposit: ethers.formatEther(actualSafetyDeposit), totalCost: ethers.formatEther(totalCost), contractType: 'ESCROW_FACTORY_DIRECT_TESTNET' });

      } else if (direction === 'xlm_to_eth') {
        const { xlmUsdPrice, ethUsdPrice, ethToXlmRate } = await getRealTimePrices();
        const xlmAmt = parseFloat(amount);
        const ethAmt = xlmAmt * (xlmUsdPrice / ethUsdPrice);
        const secret = ethers.hexlify(ethers.randomBytes(32));
        const hashLock = ethers.keccak256(secret).substring(2);

        if (RELAYER_CONFIG.enableMockMode) {
          const stellarAmountStroops = BigInt(Math.round(xlmAmt * 1e7));
          const mockOrderData = { orderId, direction: 'xlm_to_eth', stellarAmount: stellarAmountStroops.toString(), ethAmount: (ethAmt * 1e18).toString(), ethAddress, stellarAddress, exchangeRate: ethToXlmRate, secret, hashLock, created: new Date().toISOString(), status: 'mock_htlc_created', contractType: 'MOCK_DUAL_HTLC' };
          await storeActiveOrder(orderId, mockOrderData);
          return res.json({ success: true, orderId, orderData: mockOrderData, message: 'MOCK: XLM→ETH HTLCs created', stellar: { amount: xlmAmt + ' XLM', hashLock }, ethereum: { contractAddress: getHtlcBridgeAddress('mainnet', 'mainnet'), ethAmount: ethAmt.toFixed(6) + ' ETH', hashLock: '0x' + hashLock } });
        }

        const safeEth = Math.min(Math.max(ethAmt, 0.000001), 10.0);
        let ethAmountWei: bigint;
        try { ethAmountWei = ethers.parseEther((Math.round(safeEth * 1e6) / 1e6).toString()); }
        catch { ethAmountWei = ethers.parseEther('0.001'); }

        const stellarAmountStroops = BigInt(Math.round(xlmAmt * 1e7));
        const relayerStellar = process.env.RELAYER_STELLAR_PUBLIC ?? 'YOUR_STELLAR_PUBLIC_KEY_HERE';
        const orderData = { orderId, direction: 'xlm_to_eth', stellarAmount: stellarAmountStroops.toString(), ethAmount: ethAmountWei.toString(), ethAddress, stellarAddress, exchangeRate: ethToXlmRate, secret, hashLock, created: new Date().toISOString(), status: 'awaiting_xlm_payment', contractType: 'XLM_TO_ETH_PENDING', stellar: { paymentAddress: relayerStellar, amount: xlmAmt.toString(), memo: `XLM-ETH-${orderId.substring(0, 8)}` }, ethereum: { pendingAmount: ethAmountWei.toString(), beneficiary: ethAddress } };
        await storeActiveOrder(orderId, orderData);
        logger.info({ orderId, stellarPaymentAddress: relayerStellar }, 'XLM→ETH order created — awaiting XLM payment');
        return res.json({ success: true, orderId, message: 'XLM→ETH: Order created — Please send XLM to complete swap', orderData: { stellarAmount: stellarAmountStroops.toString(), stellarAddress: relayerStellar, memo: `XLM-ETH-${orderId.substring(0, 8)}`, expectedEthAmount: ethAmountWei.toString(), status: 'awaiting_xlm_payment', instructions: `Send ${xlmAmt} XLM to ${relayerStellar} with memo: XLM-ETH-${orderId.substring(0, 8)}` } });
      } else {
        throw new Error('Invalid direction specified');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Bridge order creation failed');
      res.status(500).json({ error: 'Bridge order creation failed', details: msg });
    }
  });

  router.post('/api/orders/process', async (req: Request, res: Response) => {
    try {
      const { orderId, txHash, stellarTxHash, stellarAddress, ethAddress } = req.body as Record<string, string>;
      if (!orderId) return res.status(400).json({ error: 'Order ID is required' });

      const procTimer = submissionLatencySeconds.startTimer({ direction: 'xlm_to_eth' });
      res.on('finish', () => procTimer({ result: res.statusCode < 400 ? 'success' : 'failure' }));

      logger.info({ orderId, txHash, stellarTxHash }, 'Processing approved order');

      const storedOrder = activeOrders.get(orderId);
      if (!storedOrder) return res.status(404).json({ error: 'Order not found', orderId });

      const userStellar = (storedOrder.stellarAddress ?? stellarAddress) as string;
      const userEth = (storedOrder.ethAddress ?? ethAddress) as string;

      if (storedOrder.contractType === 'ONEINCH_ESCROW_FACTORY' && storedOrder.status === 'pending_escrow_deployment') {
        storedOrder.status = 'escrow_deployed';
        storedOrder.ethTxHash = txHash;
        await processEscrowToStellar(orderId, storedOrder);
        return res.json({ success: true, orderId, message: 'Escrow deployed and Stellar transfer initiated', status: 'processing_stellar_transfer' });
      }

      const isXlmToEth = stellarTxHash && !txHash;
      const isEthToXlm = txHash && !stellarTxHash;

      if (isXlmToEth) {
        try {
          const orderNet = (storedOrder.networkMode as string) ?? 'mainnet';
          const rpcUrl = resolveEthereumRpcUrl(orderNet === 'testnet' ? 'testnet' : 'mainnet');
          const pk = process.env.RELAYER_PRIVATE_KEY;
          if (!pk) throw new Error('RELAYER_PRIVATE_KEY not set');

          if (globalStellarProofLedger.isConsumed(stellarTxHash)) {
            settlementProofReplaysTotal.inc({ network_mode: orderNet });
            return res.status(409).json({ error: 'Stellar transaction already consumed', stellarTxHash });
          }

          const horizonUrl = NETWORK_CONFIG[orderNet as NetworkMode]?.stellar?.horizonUrl;
          const relayerSecret = orderNet === 'mainnet' ? (process.env.RELAYER_STELLAR_SECRET_MAINNET ?? process.env.RELAYER_STELLAR_SECRET) : (process.env.RELAYER_STELLAR_SECRET_TESTNET ?? process.env.RELAYER_STELLAR_SECRET);
          if (!relayerSecret || !horizonUrl) return res.status(500).json({ error: 'Relayer Stellar config not available', network: orderNet });

          const { Keypair: PK } = await import('@stellar/stellar-sdk');
          const relayerPubkey = PK.fromSecret(relayerSecret).publicKey();

          if (!userStellar) {
            settlementVerificationTotal.inc({ result: 'payment_mismatch', network_mode: orderNet });
            return res.status(400).json({ error: 'Cannot verify payment: user Stellar address is unknown for this order', orderId });
          }

          let verifiedPayment: Awaited<ReturnType<typeof verifyIncomingStellarPayment>>;
          try {
            const rt = receiptLatencySeconds.startTimer();
            verifiedPayment = await verifyIncomingStellarPayment(stellarTxHash, { horizonUrl, relayerPublicKey: relayerPubkey, expectedSourceAccount: userStellar });
            rt({ result: 'success' });
            settlementVerificationTotal.inc({ result: 'success', network_mode: orderNet });
          } catch (vErr: unknown) {
            if (vErr instanceof StellarTxNotFoundError) { settlementVerificationTotal.inc({ result: 'tx_not_found', network_mode: orderNet }); return res.status(404).json({ error: 'Stellar tx not found', stellarTxHash }); }
            if (vErr instanceof StellarTxFailedError) { settlementVerificationTotal.inc({ result: 'tx_failed', network_mode: orderNet }); return res.status(400).json({ error: 'Stellar tx failed on-chain', stellarTxHash }); }
            if (vErr instanceof StellarPaymentMismatch) { settlementVerificationTotal.inc({ result: 'payment_mismatch', network_mode: orderNet }); return res.status(400).json({ error: 'Stellar payment mismatch', details: (vErr as Error).message, stellarTxHash }); }
            settlementVerificationTotal.inc({ result: 'horizon_error', network_mode: orderNet });
            return res.status(503).json({ error: 'Horizon verification unavailable' });
          }

          const consumed = globalStellarProofLedger.consume(stellarTxHash, { orderId, verifiedAmount: verifiedPayment.amount, ledgerSequence: verifiedPayment.ledgerSequence });
          if (!consumed) { settlementProofReplaysTotal.inc({ network_mode: orderNet }); return res.status(409).json({ error: 'Stellar tx consumed by concurrent request', stellarTxHash }); }

          const xRate = storedOrder.exchangeRate;
          if (!xRate || !Number.isFinite(Number(xRate)) || Number(xRate) <= 0) return res.status(400).json({ error: 'Missing valid exchange rate', orderId });
          const [iPart, fPart = ''] = verifiedPayment.amount.split('.');
          const stroops = BigInt(iPart ?? '0') * 10_000_000n + BigInt(fPart.padEnd(7, '0').substring(0, 7));
          const xRateNum = Number(xRate);
          if (!Number.isSafeInteger(Math.round(xRateNum))) {
            return res.status(400).json({ error: 'Exchange rate is too large to convert safely', orderId });
          }
          const rateBig = BigInt(Math.round(xRateNum));
          if (rateBig === 0n) return res.status(400).json({ error: 'Exchange rate rounds to zero', orderId });
          const ethAmountWei = (stroops * 1_000_000_000_000_000_000n) / (rateBig * 10_000_000n);
          if (ethAmountWei === 0n) return res.status(400).json({ error: 'XLM too small to release ETH', orderId });

          logger.info({ orderId, verifiedXlm: verifiedPayment.amount, ethAmountWei: ethAmountWei.toString(), ethFormatted: ethers.formatEther(ethAmountWei) }, 'XLM→ETH amount calc (process)');

          const auth = authorizeSettlementCommand(supportPolicy, RELAYER_CONFIG as unknown as SettlementAccountConfig, { command: 'settle', direction: (storedOrder.direction as string) ?? 'xlm_to_eth', chain: 'ethereum' });
          if (!auth.authorized) { const d = auth as import('../settlement-permissions.js').AuthorizationDenial; logger.warn({ code: d.code }, 'Settlement denied (process)'); return res.status(403).json({ error: 'settlement_permission_denied', code: d.code, details: d.reason }); }

          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const wallet = new ethers.Wallet(pk, provider);
          const balance = await runWithSettlementRetry('eth-balance', ETH_BALANCE_RETRY, () => provider.getBalance(wallet.address), { orderId, direction: (storedOrder.direction as string) ?? 'xlm_to_eth', chain: 'ethereum' });
          const gasCost = 21000n * ethers.parseUnits('20', 'gwei');
          if (balance < ethAmountWei + gasCost) return res.status(400).json({ error: 'Insufficient relayer balance', balance: ethers.formatEther(balance), required: ethers.formatEther(ethAmountWei + gasCost) });

          const ethTx = await runWithSettlementRetry('eth-send', ETH_SEND_RETRY, () => wallet.sendTransaction({ to: userEth, value: ethAmountWei, gasLimit: 21000, gasPrice: ethers.parseUnits('20', 'gwei') }), { orderId, direction: (storedOrder.direction as string) ?? 'xlm_to_eth', chain: 'ethereum', recoveredTxHash: (r) => r.hash });
          retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, 0);
          logger.info({ orderId, txHash: ethTx.hash }, 'ETH transaction sent (process)');

          const receipt = await runWithSettlementRetry('eth-confirm', ETH_CONFIRM_RETRY, () => ethTx.wait(), { orderId, direction: (storedOrder.direction as string) ?? 'xlm_to_eth', chain: 'ethereum' });
          logger.info({ orderId, txHash: receipt?.hash }, 'ETH tx confirmed (process)');
          storedOrder.status = 'completed';
          storedOrder.ethTxHash = receipt?.hash;
          return res.json({ success: true, orderId, ethTxId: receipt?.hash, message: 'Cross-chain swap completed!', details: { stellar: { txHash: stellarTxHash, verifiedAmount: verifiedPayment.amount, status: 'confirmed' }, ethereum: { txId: receipt?.hash, amount: `${ethers.formatEther(ethAmountWei)} ETH`, destination: userEth, status: 'completed' } } });
        } catch (ethErr: unknown) {
          const msg = ethErr instanceof Error ? ethErr.message : String(ethErr);
          logger.error({ orderId, err: msg }, 'ETH tx failed (process)');
          retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'failure' }, 0);
          droppedOrdersTotal.inc({ direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
          return res.status(500).json({ error: 'ETH release failed', details: msg, orderId, recoveryHint: 'Check /api/admin/settlement-failures' });
        }
      }

      if (isEthToXlm) {
        try {
          const { Horizon, Keypair, Asset, Operation, TransactionBuilder, Networks, BASE_FEE, Memo } = await import('@stellar/stellar-sdk');
          const dynNet = (storedOrder.contractType as string)?.includes('ONEINCH') ? 'mainnet' : 'testnet';
          const stellarCfg = NETWORK_CONFIG[dynNet as NetworkMode].stellar;
          const server = new Horizon.Server(stellarCfg.horizonUrl);
          const secret = dynNet === 'mainnet' ? (process.env.RELAYER_STELLAR_SECRET_MAINNET ?? process.env.RELAYER_STELLAR_SECRET) : (process.env.RELAYER_STELLAR_SECRET_TESTNET ?? process.env.RELAYER_STELLAR_SECRET);
          if (!secret || secret.startsWith('SAXXX')) throw new Error(`Stellar secret not configured for ${dynNet}`);
          const kp = Keypair.fromSecret(secret);
          const account = await server.loadAccount(kp.publicKey());
          const balance = account.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
          const rate = (storedOrder.exchangeRate as number) ?? 10000;
          const ethAmt = parseFloat(ethers.formatEther((storedOrder.amount as string) ?? '1000000000000000'));
          const xlmAmt = (ethAmt * rate).toFixed(7);
          logger.info({ orderId, xlmAmt, balance, destination: userStellar }, 'ETH→XLM: sending XLM');
          if (parseFloat(balance) < parseFloat(xlmAmt)) throw new Error(`Insufficient XLM: ${balance} < ${xlmAmt}`);
          const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: dynNet === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET })
            .addOperation(Operation.payment({ destination: userStellar, asset: Asset.native(), amount: xlmAmt }))
            .addMemo(Memo.text(`Bridge:${orderId.substring(0, 20)}`))
            .setTimeout(300).build();
          tx.sign(kp);
          const result = await server.submitTransaction(tx);
          logger.info({ orderId, txHash: result.hash, xlmAmt, destination: userStellar }, 'ETH→XLM XLM payment sent');
          storedOrder.status = 'completed';
          storedOrder.stellarTxHash = result.hash;
          return res.json({ success: true, orderId, stellarTxId: result.hash, message: 'Cross-chain swap completed!', details: { ethereum: { txHash, status: 'confirmed' }, stellar: { txId: result.hash, amount: `${xlmAmt} XLM`, destination: userStellar, status: 'completed' } } });
        } catch (stellarErr: unknown) {
          const msg = stellarErr instanceof Error ? stellarErr.message : String(stellarErr);
          logger.error({ orderId, err: msg }, 'Stellar tx failed (process ETH→XLM)');
          return res.status(502).json({ success: false, orderId, error: 'Stellar transaction failed', details: { ethereum: { status: 'confirmed' }, stellar: { status: 'failed', message: msg } }, refundHint: 'Call refundOrder() after the timelock.' });
        }
      }

      throw new Error('Cannot determine direction from provided fields');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Order processing failed');
      res.status(500).json({ error: 'Order processing failed', details: msg });
    }
  });

  router.post('/api/orders/xlm-to-eth', async (req: Request, res: Response) => {
    try {
      const { orderId, stellarTxHash, stellarAddress, ethAddress, networkMode } = req.body as Record<string, string>;
      const reqNet = networkMode ?? (req.query.network as string) ?? DEFAULT_NETWORK_MODE;

      const xlmTimer = submissionLatencySeconds.startTimer({ direction: 'xlm_to_eth' });
      res.on('finish', () => xlmTimer({ result: res.statusCode < 400 ? 'success' : 'failure' }));

      if (!orderId || !stellarTxHash || !ethAddress) return res.status(400).json({ error: 'Missing required fields: orderId, stellarTxHash, ethAddress' });

      if (globalStellarProofLedger.isConsumed(stellarTxHash)) {
        settlementProofReplaysTotal.inc({ network_mode: reqNet });
        return res.status(409).json({ error: 'Stellar transaction already consumed', stellarTxHash });
      }

      const storedOrder = activeOrders.get(orderId);
      if (!storedOrder) return res.status(404).json({ error: 'Order not found', orderId, details: 'Create via /api/orders/create first.' });

      storedOrder.xlmReceivedAt = storedOrder.xlmReceivedAt ?? Date.now();
      storedOrder.stellarTxHash = stellarTxHash;
      if (stellarAddress) storedOrder.stellarAddress = stellarAddress;
      storedOrder.networkMode = storedOrder.networkMode ?? reqNet;

      const orderNet = reqNet || (storedOrder.networkMode as string) || 'mainnet';
      const rpcUrl = resolveEthereumRpcUrl(orderNet === 'testnet' ? 'testnet' : 'mainnet');
      const pk = process.env.RELAYER_PRIVATE_KEY;
      if (!pk) throw new Error('RELAYER_PRIVATE_KEY not set');

      if (storedOrder.direction && storedOrder.direction !== 'xlm_to_eth') return res.status(400).json({ error: 'Order direction mismatch', orderId });
      if (storedOrder.status === 'eth_tx_sent' || storedOrder.status === 'completed') return res.status(200).json({ success: true, orderId, ethTxId: storedOrder.ethTxHash, message: 'Order already settled.', fromCache: true });
      if (storedOrder.status === 'refunded' || storedOrder.status === 'stellar_transfer_failed') return res.status(409).json({ error: 'Order in terminal state', orderId, status: storedOrder.status });

      const horizonUrl = NETWORK_CONFIG[orderNet as NetworkMode].stellar.horizonUrl;
      const relayerSecret = orderNet === 'mainnet' ? (process.env.RELAYER_STELLAR_SECRET_MAINNET ?? process.env.RELAYER_STELLAR_SECRET) : (process.env.RELAYER_STELLAR_SECRET_TESTNET ?? process.env.RELAYER_STELLAR_SECRET);
      if (!relayerSecret) return res.status(500).json({ error: 'Relayer Stellar secret not configured', network: orderNet });

      const { Keypair } = await import('@stellar/stellar-sdk');
      const relayerPubkey = Keypair.fromSecret(relayerSecret).publicKey();

      let verifiedPayment: Awaited<ReturnType<typeof verifyIncomingStellarPayment>>;
      try {
        const rt = receiptLatencySeconds.startTimer();
        verifiedPayment = await verifyIncomingStellarPayment(stellarTxHash, { horizonUrl, relayerPublicKey: relayerPubkey, expectedSourceAccount: stellarAddress });
        rt({ result: 'success' });
        settlementVerificationTotal.inc({ result: 'success', network_mode: orderNet });
      } catch (vErr: unknown) {
        if (vErr instanceof StellarTxNotFoundError) { settlementVerificationTotal.inc({ result: 'tx_not_found', network_mode: orderNet }); return res.status(404).json({ error: 'Stellar tx not found', stellarTxHash }); }
        if (vErr instanceof StellarTxFailedError) { settlementVerificationTotal.inc({ result: 'tx_failed', network_mode: orderNet }); return res.status(400).json({ error: 'Stellar tx failed', stellarTxHash }); }
        if (vErr instanceof StellarPaymentMismatch) { settlementVerificationTotal.inc({ result: 'payment_mismatch', network_mode: orderNet }); return res.status(400).json({ error: 'Stellar payment mismatch', details: (vErr as Error).message, stellarTxHash }); }
        settlementVerificationTotal.inc({ result: 'horizon_error', network_mode: orderNet });
        return res.status(503).json({ error: 'Horizon verification unavailable' });
      }

      const consumed = globalStellarProofLedger.consume(stellarTxHash, { orderId, verifiedAmount: verifiedPayment.amount, ledgerSequence: verifiedPayment.ledgerSequence });
      if (!consumed) { settlementProofReplaysTotal.inc({ network_mode: orderNet }); return res.status(409).json({ error: 'Stellar tx consumed by concurrent request', stellarTxHash }); }

      try {
        const auth = authorizeSettlementCommand(supportPolicy, RELAYER_CONFIG as unknown as SettlementAccountConfig, { command: 'settle', direction: (storedOrder.direction as string) ?? 'xlm_to_eth', chain: 'ethereum' });
        if (!auth.authorized) { const d = auth as import('../settlement-permissions.js').AuthorizationDenial; logger.warn({ code: d.code }, 'Settlement denied (xlm-to-eth)'); return res.status(403).json({ error: 'settlement_permission_denied', code: d.code, details: d.reason }); }

        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(pk, provider);
        const balance = await runWithSettlementRetry('eth-balance', ETH_BALANCE_RETRY, () => withTimeout(provider.getBalance(wallet.address), (RELAYER_CONFIG.rpcTimeoutMs as number) ?? 10000, 'getBalance timeout'), { orderId, direction: (storedOrder.direction as string) ?? 'xlm_to_eth', chain: 'ethereum' });

        const xRate = storedOrder.exchangeRate;
        if (!xRate || !Number.isFinite(Number(xRate)) || Number(xRate) <= 0) return res.status(400).json({ error: 'Missing valid exchange rate', orderId });
        const [iPart, fPart = ''] = verifiedPayment.amount.split('.');
        const stroops = BigInt(iPart ?? '0') * 10_000_000n + BigInt(fPart.padEnd(7, '0').substring(0, 7));
        const xRateNum = Number(xRate);
        if (!Number.isSafeInteger(Math.round(xRateNum))) {
          return res.status(400).json({ error: 'Exchange rate is too large to convert safely', orderId });
        }
        const rateBig = BigInt(Math.round(xRateNum));
        if (rateBig === 0n) return res.status(400).json({ error: 'Exchange rate rounds to zero', orderId });
        const ethAmountWei = (stroops * 1_000_000_000_000_000_000n) / (rateBig * 10_000_000n);
        if (ethAmountWei === 0n) return res.status(400).json({ error: 'XLM too small to release ETH', orderId });

        logger.info({ orderId, verifiedXlm: verifiedPayment.amount, ethAmountWei: ethAmountWei.toString(), ethFormatted: ethers.formatEther(ethAmountWei) }, 'XLM→ETH amount calc');

        const tx = { to: ethAddress, value: ethAmountWei, gasLimit: 21000, gasPrice: ethers.parseUnits('20', 'gwei') };
        const gasCost = BigInt(tx.gasLimit) * BigInt(tx.gasPrice);
        if (balance < ethAmountWei + gasCost) return res.status(400).json({ error: 'Insufficient relayer balance', balance: ethers.formatEther(balance), required: ethers.formatEther(ethAmountWei + gasCost) });

        const ethTx = await runWithSettlementRetry('eth-send', ETH_SEND_RETRY, () => withTimeout(wallet.sendTransaction(tx), (RELAYER_CONFIG.rpcTimeoutMs as number) ?? 10000, 'sendTransaction timeout'), { orderId, direction: (storedOrder.direction as string) ?? 'xlm_to_eth', chain: 'ethereum', recoveredTxHash: (r) => r.hash });
        retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'success' }, 0);
        logger.info({ orderId, txHash: ethTx.hash }, 'ETH tx sent (xlm-to-eth)');
        storedOrder.status = 'eth_tx_sent';
        storedOrder.ethTxHash = ethTx.hash;
        orderQueueDepth.set(activeOrders.size);

        return res.json({ success: true, orderId, ethTxId: ethTx.hash, message: 'XLM→ETH transfer broadcasted', details: { stellar: { txHash: stellarTxHash, verifiedAmount: verifiedPayment.amount, status: 'confirmed' }, ethereum: { txId: ethTx.hash, amount: `${ethers.formatEther(ethAmountWei)} ETH`, destination: ethAddress, status: 'pending' } } });

      } catch (ethErr: unknown) {
        const msg = ethErr instanceof Error ? ethErr.message : String(ethErr);
        logger.error({ orderId, err: msg }, 'ETH tx failed (xlm-to-eth)');

        let refundResult: { hash: string } | null = null;
        let refundError: string | null = null;
        let refundAmbiguous = false;

        if (relayerSecret && stellarAddress) {
          const claimed = globalRefundLedger.claim(orderId);
          if (!claimed) {
            const existing = globalRefundLedger.getEntry(orderId);
            if (existing?.state.phase === 'committed') {
              refundResult = { hash: existing.state.txHash };
              storedOrder.status = 'refunded';
              storedOrder.refundTxHash = existing.state.txHash;
            } else {
              refundError = `Refund already in-flight for orderId=${orderId}`;
            }
          } else {
            try {
              const refund = await refundXlmToUser({ orderId, stellarAddress, stellarTxHash, networkMode: orderNet as 'mainnet' | 'testnet', horizonUrl, refundSecret: relayerSecret, fallbackStroops: verifiedPayment.amount, ledger: globalRefundLedger, maxRetries: 2 });
              refundResult = { hash: refund.hash };
              storedOrder.status = 'refunded';
              storedOrder.refundTxHash = refund.hash;
              logger.info({ orderId, refundTxHash: refund.hash, amount: refund.amount }, 'Automatic XLM refund completed');
            } catch (rErr: unknown) {
              if (rErr instanceof HorizonTimeoutError) {
                refundAmbiguous = true;
                refundError = `Horizon timeout: ${(rErr as Error).message}`;
                storedOrder.watchdogFailedAt = Date.now();
                globalRefundLedger.markAmbiguous(orderId, (rErr as Error).message);
              } else {
                globalRefundLedger.release(orderId);
                refundError = rErr instanceof Error ? rErr.message : String(rErr);
              }
              logger.error({ orderId, refundError }, 'Automatic XLM refund failed');
            }
          }
        } else {
          refundError = relayerSecret ? 'Missing stellarAddress' : `Stellar secret not configured for ${orderNet}`;
        }

        retryAttemptsHistogram.observe({ operation: 'eth_send', result: 'failure' }, 0);
        droppedOrdersTotal.inc({ direction: 'xlm_to_eth', reason: 'eth_tx_failed' });
        globalSettlementFailureStore.recordFailure({ orderId, direction: (storedOrder.direction as string) ?? 'xlm_to_eth', category: classifyFailureCategory(ethErr, 'ethereum'), errorMessage: msg, chain: 'ethereum', recoveryAction: 'XLM refund attempted; watchdog will follow up' });

        return res.status(500).json({ error: 'ETH release failed', details: msg, orderId, recoveryHint: 'Check /api/admin/settlement-failures', refund: refundResult ? { status: 'completed', stellarTxHash: refundResult.hash, message: 'Your XLM has been automatically refunded.' } : { status: refundAmbiguous ? 'ambiguous' : 'failed', error: refundError, orderId, originalStellarTxHash: stellarTxHash } });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'XLM→ETH processing failed');
      res.status(500).json({ error: 'XLM→ETH processing failed', details: msg });
    }
  });

  router.post('/api/orders/manual-refund', async (req: Request, res: Response) => {
    try {
      const { stellarTxHash, stellarAddress, networkMode, orderId: bodyOrderId } = req.body as Record<string, string>;
      if (!stellarTxHash || !stellarAddress) return res.status(400).json({ error: 'Missing required fields: stellarTxHash, stellarAddress' });

      const refundNet: 'mainnet' | 'testnet' = networkMode === 'mainnet' ? 'mainnet' : 'testnet';
      const orderId = bodyOrderId ?? (() => {
        for (const [id, o] of activeOrders.entries()) { if (o.stellarTxHash === stellarTxHash) return id; }
        return stellarTxHash;
      })();

      logger.info({ orderId, stellarTxHash, stellarAddress, refundNet }, 'Manual refund requested');

      const existingPre = globalRefundLedger.getEntry(orderId);
      if (existingPre?.state.phase === 'committed') {
        return res.json({ success: true, refundTxHash: existingPre.state.txHash, amount: existingPre.state.amount, destination: stellarAddress, network: refundNet, fromCache: true });
      }
      if (existingPre?.state.phase === 'in_flight' || existingPre?.state.phase === 'ambiguous') {
        return res.status(409).json({ error: `Refund already ${existingPre.state.phase}`, orderId, stellarTxHash });
      }

      if (!globalRefundLedger.claim(orderId)) {
        const raceEntry = globalRefundLedger.getEntry(orderId);
        if (raceEntry?.state.phase === 'committed') {
          return res.json({ success: true, refundTxHash: raceEntry.state.txHash, amount: raceEntry.state.amount, destination: stellarAddress, network: refundNet, fromCache: true });
        }
        return res.status(409).json({ error: 'Refund already in progress', orderId, stellarTxHash });
      }

      const horizonUrl = NETWORK_CONFIG[refundNet].stellar.horizonUrl;
      const relayerSecret = refundNet === 'mainnet' ? (process.env.RELAYER_STELLAR_SECRET_MAINNET ?? process.env.RELAYER_STELLAR_SECRET) : (process.env.RELAYER_STELLAR_SECRET_TESTNET ?? process.env.RELAYER_STELLAR_SECRET);
      if (!relayerSecret) {
        globalRefundLedger.release(orderId);
        return res.status(500).json({ error: 'Relayer Stellar secret not configured', network: refundNet });
      }

      const { Keypair } = await import('@stellar/stellar-sdk');
      const relayerPubkey = Keypair.fromSecret(relayerSecret).publicKey();

      let verifiedPayment: Awaited<ReturnType<typeof verifyIncomingStellarPayment>>;
      try {
        verifiedPayment = await verifyIncomingStellarPayment(stellarTxHash, {
          horizonUrl,
          relayerPublicKey: relayerPubkey,
          expectedSourceAccount: stellarAddress,
        });
        logger.info({ orderId, amount: verifiedPayment.amount }, 'Verified original payment for manual refund');
      } catch (vErr: unknown) {
        globalRefundLedger.release(orderId);
        if (vErr instanceof StellarTxNotFoundError) return res.status(404).json({ error: 'Stellar tx not found', stellarTxHash });
        if (vErr instanceof StellarTxFailedError) return res.status(400).json({ error: 'Stellar tx failed on-chain', stellarTxHash });
        if (vErr instanceof StellarPaymentMismatch) return res.status(400).json({ error: 'Original tx does not match a payment to the relayer from this address', details: (vErr as Error).message, stellarTxHash });
        return res.status(404).json({ error: 'Could not verify original transaction', details: vErr instanceof Error ? vErr.message : String(vErr) });
      }

      try {
        const refund = await refundXlmToUser({ orderId, stellarAddress, stellarTxHash, networkMode: refundNet, horizonUrl, refundSecret: relayerSecret, fallbackStroops: verifiedPayment.amount, ledger: globalRefundLedger, maxRetries: 2 });
        const order = activeOrders.get(orderId);
        if (order) { order.status = 'refunded'; order.refundTxHash = refund.hash; }
        logger.info({ orderId, refundTxHash: refund.hash, amount: refund.amount }, 'Manual refund successful');
        return res.json({ success: true, refundTxHash: refund.hash, amount: refund.amount, stroops: refund.stroops.toString(), destination: stellarAddress, network: refundNet });
      } catch (rErr: unknown) {
        if (rErr instanceof HorizonTimeoutError) { globalRefundLedger.markAmbiguous(orderId, (rErr as Error).message); return res.status(202).json({ error: 'Refund submitted but outcome ambiguous (Horizon timeout)', orderId }); }
        globalRefundLedger.release(orderId);
        logger.error({ orderId, err: rErr instanceof Error ? rErr.message : String(rErr) }, 'Manual refund failed');
        return res.status(500).json({ error: 'Manual refund failed', details: rErr instanceof Error ? rErr.message : String(rErr) });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Manual refund endpoint error');
      res.status(500).json({ error: 'Manual refund failed', details: msg });
    }
  });

  router.get('/api/escrow/info', (_req: Request, res: Response) => {
    res.json({ success: true, escrowFactory: getEscrowFactoryAddress('mainnet', 'mainnet'), method: 'createDstEscrow', note: 'Using 1inch cross-chain resolver pattern' });
  });

  return router;
}
