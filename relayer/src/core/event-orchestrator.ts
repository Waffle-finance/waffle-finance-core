/**
 * @fileoverview Chain monitoring orchestration for the WaffleFinance relayer.
 *
 * Extracted from relayer/src/index.ts. Owns all chain polling, contract event
 * listening, and the lazy start/stop lifecycle that gates RPC usage on whether
 * any orders are actually in-flight.
 *
 * Design
 * ------
 * - Chain monitoring starts lazily on the first swap order, not at boot, so
 *   idle deployments consume zero Infura/RPC quota.
 * - `ensureChainMonitoring()` is idempotent and de-dupes concurrent callers
 *   via a single promise.
 * - `stopChainMonitoring()` is called automatically when all active orders
 *   have settled or expired; the reconcile loop runs every 60 s.
 * - Event bindings are handed to `startContractEventPoller` (single
 *   `queryFilter` loop) rather than `contract.on(...)`, because public RPCs
 *   don't keep filter state between calls.
 */

import { ethers } from 'ethers';
import { resolveEthereumRpcUrl } from '@wafflefinance/config';
import { ethereumListener } from '../listeners/ethereum-listener.js';
import {
  startContractEventPoller,
  type ContractEventBinding,
  type ContractEventPollerHandle,
} from '../listeners/contract-event-poller.js';
import { startAdaptivePoll, type AdaptivePollHandle } from '../utils/adaptive-poll.js';
import { fetchIncomingEthPayments } from '../listeners/eth-incoming-monitor.js';
import {
  expireAbandonedOrders,
  hasAwaitingXlmPayment,
  hasPendingRelayerEscrow,
  needsChainMonitoring,
} from '../utils/order-poll-utils.js';
import { hasRecentVisitor } from '../utils/site-presence.js';
import {
  NETWORK_CONFIG,
  getEscrowFactoryAddress,
  getEscrowFactoryABI,
  getHtlcBridgeAddress,
} from '../config/networks.js';
import { calculateDynamicSafetyDeposit } from '../services/pricing-service.js';
import { getLogger } from '../logger.js';
import {
  classifyFailureCategory,
  ETH_SEND_RETRY,
} from '../services/settlement-retry-policy.js';
import { globalRetryEngine } from '../utils/retry-engine.js';
import { globalSettlementFailureStore } from '../services/settlement-failure-store.js';

const logger = getLogger().child({ component: 'event-orchestrator' });

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  defaultNetworkMode: string;
  activePollIntervalMs: number;
  idlePollIntervalMs: number;
  relayerPrivateKey?: string;
  relayerStellarPublic?: string;
}

export interface OrchestratorHandle {
  /** Call after storing any new order. Wakes pollers and starts monitoring. */
  onOrderStored(orderId: string): Promise<void>;
  /** Call on app shutdown. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire up all chain listeners and return a handle the boot file uses to
 * interact with the orchestrator.
 *
 * @param config        Resolved relayer configuration values.
 * @param activeOrders  Shared in-memory order map (owned by index.ts).
 */
export function createEventOrchestrator(
  config: OrchestratorConfig,
  activeOrders: Map<string, unknown>,
): OrchestratorHandle {
  const {
    defaultNetworkMode,
    activePollIntervalMs,
    idlePollIntervalMs,
    relayerPrivateKey,
  } = config;

  const chainPollers: AdaptivePollHandle[] = [];
  let escrowFactoryPoller: ContractEventPollerHandle | null = null;
  let chainMonitoringStarted = false;
  let chainMonitoringPromise: Promise<void> | null = null;

  // ── Wake helpers ──────────────────────────────────────────────────────────

  function wakeChainPollers(): void {
    if (!chainMonitoringStarted) return;
    ethereumListener.wakePolling();
    escrowFactoryPoller?.wake();
    for (const poller of chainPollers) poller.wake();
  }

  // ── Stop ──────────────────────────────────────────────────────────────────

  async function stopChainMonitoring(): Promise<void> {
    if (!chainMonitoringStarted) return;
    logger.info('Stopping chain monitoring — no in-flight orders');
    for (const poller of chainPollers) poller.stop();
    chainPollers.length = 0;
    escrowFactoryPoller?.stop();
    escrowFactoryPoller = null;
    try {
      await ethereumListener.stopListening();
    } catch {
      /* already stopped */
    }
    chainMonitoringStarted = false;
    chainMonitoringPromise = null;
  }

  // ── Reconcile (periodic) ─────────────────────────────────────────────────

  function reconcileChainMonitoring(): void {
    const expired = expireAbandonedOrders(activeOrders);
    if (expired > 0) {
      logger.info({ expiredCount: expired }, 'Expired abandoned pre-deposit orders');
    }
    if (chainMonitoringStarted && !needsChainMonitoring(activeOrders)) {
      void stopChainMonitoring();
    }
  }

  setInterval(reconcileChainMonitoring, 60_000);

  // ── Ensure (lazy start) ───────────────────────────────────────────────────

  async function ensureChainMonitoring(): Promise<void> {
    if (chainMonitoringStarted) return;
    if (!chainMonitoringPromise) {
      chainMonitoringPromise = (async () => {
        chainMonitoringStarted = true;
        await startChainMonitoring();
      })().catch((err) => {
        chainMonitoringStarted = false;
        chainMonitoringPromise = null;
        throw err;
      });
    }
    await chainMonitoringPromise;
  }

  // ── Inner: create escrow after ETH transfer detected ─────────────────────

  async function createEscrowForOrder(
    orderData: Record<string, unknown>,
    orderId: string,
    contract: ethers.Contract,
    wallet: ethers.Wallet,
  ): Promise<void> {
    try {
      logger.info({ orderId }, 'Creating escrow for order');

      const orderAmountBigInt = BigInt(orderData.amount as string);
      const orderNetworkMode = (orderData.networkMode as string) || defaultNetworkMode;
      const actualSafetyDeposit = await calculateDynamicSafetyDeposit(
        orderData.amount as string,
        orderNetworkMode,
        defaultNetworkMode,
      );
      const totalValue = orderAmountBigInt + actualSafetyDeposit;
      const contractWithSigner = contract.connect(wallet) as ethers.Contract & Record<string, (...args: unknown[]) => Promise<unknown>>;
      const isMainnetRequest = orderNetworkMode === 'mainnet';
      let tx: { hash: string; wait: () => Promise<{ hash: string; logs: { topics: string[] }[] }> };

      if (isMainnetRequest) {
        logger.info({ orderId }, 'MAINNET: Using createDstEscrow method');
        const orderHash = (orderData.orderHash as string) || ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256', 'bytes32', 'uint256'],
            [
              orderData.ethAddress,
              orderAmountBigInt,
              orderData.hashLock,
              Math.floor(Date.now() / 1000),
            ],
          ),
        );

        const order = {
          maker: orderData.ethAddress,
          taker: '0x0000000000000000000000000000000000000000',
          makerAsset: '0x0000000000000000000000000000000000000000',
          takerAsset: '0x0000000000000000000000000000000000000000',
          makingAmount: orderAmountBigInt,
          takingAmount: orderAmountBigInt,
          salt: ethers.randomBytes(32),
          extension: orderData.hashLock,
        };

        const takerTraits = {
          extensionData: orderData.hashLock,
          safetyDeposit: actualSafetyDeposit,
          timelock:
            (orderData.timelock as number) ||
            Math.floor(Date.now() / 1000) + 2 * 60 * 60,
        };

        tx = await contractWithSigner['createDstEscrow'](
          order,
          '0x',
          takerTraits,
          order.makingAmount,
          orderData.hashLock,
          { value: totalValue, gasLimit: 3_000_000 },
        ) as typeof tx;
      } else {
        logger.info({ orderId }, 'TESTNET: Using createEscrow method');
        const escrowConfig = {
          token: '0x0000000000000000000000000000000000000000',
          amount: orderData.amount,
          hashLock: orderData.hashLock,
          timelock: orderData.timelock,
          beneficiary: orderData.ethAddress,
          refundAddress: orderData.ethAddress,
          safetyDeposit: actualSafetyDeposit.toString(),
          chainId: 11155111,
          stellarTxHash: ethers.ZeroHash,
          isPartialFillEnabled: (orderData.partialFillEnabled as boolean) || false,
        };
        tx = await contractWithSigner['createEscrow'](escrowConfig, {
          value: totalValue,
          gasLimit: 3_000_000,
        }) as typeof tx;
      }

      logger.info({ orderId, txHash: tx.hash }, 'Escrow creation tx sent');
      await tx.wait();
      logger.info({ orderId, txHash: tx.hash }, 'Escrow created successfully');

      (orderData as Record<string, unknown>).status = 'escrow_created_by_relayer';
      (orderData as Record<string, unknown>).escrowTxHash = tx.hash;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ orderId, err: message }, 'Failed to create escrow for order');
      (orderData as Record<string, unknown>).status = 'escrow_creation_failed';
    }
  }

  // ── Inner: create ETH HTLC after XLM payment detected ────────────────────

  async function createETHHTLCForOrder(
    orderData: Record<string, unknown>,
    orderId: string,
  ): Promise<void> {
    logger.info({ orderId }, 'Creating ETH HTLC for verified XLM payment');
    try {
      const rpcUrl = resolveEthereumRpcUrl(
        defaultNetworkMode === 'mainnet' ? 'mainnet' : 'testnet',
      );
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const relayerWallet = new ethers.Wallet(relayerPrivateKey!, provider);

      const relayerBalance = await provider.getBalance(relayerWallet.address);
      logger.debug(
        { orderId, balanceEth: ethers.formatEther(relayerBalance) },
        'Relayer ETH balance for HTLC creation',
      );

      const mainnetHTLCAddress = getHtlcBridgeAddress('mainnet', 'mainnet');
      const mainnetHTLCContract = new ethers.Contract(
        mainnetHTLCAddress,
        [
          'function createOrder(address token, uint256 amount, bytes32 hashLock, uint256 timelock, address beneficiary, address refundAddress) external payable returns (bytes32 orderId)',
        ],
        relayerWallet,
      );

      const ethAmountWei = BigInt(orderData.ethAmount as string);
      const timelockEth = Math.floor(Date.now() / 1000) + 7200;
      const estimatedGasCost = ethers.parseEther('0.002');
      const totalRequired = ethAmountWei + estimatedGasCost;

      if (relayerBalance < totalRequired) {
        throw new Error(
          `Insufficient relayer balance: need ${ethers.formatEther(totalRequired)} ETH, ` +
          `have ${ethers.formatEther(relayerBalance)} ETH`,
        );
      }

      const contractWithSigner = mainnetHTLCContract as ethers.Contract & Record<string, (...args: unknown[]) => Promise<{ hash: string; wait: () => Promise<{ logs: { topics: string[] }[] }> }>>;
      const ethTx = await globalRetryEngine.run(
        'eth-send',
        () =>
          contractWithSigner['createOrder'](
            '0x0000000000000000000000000000000000000000',
            ethAmountWei,
            '0x' + (orderData.hashLock as string),
            timelockEth,
            orderData.ethAddress,
            process.env.RELAYER_ETH_ADDRESS!,
            { value: ethAmountWei },
          ),
        ETH_SEND_RETRY,
      );

      logger.info({ orderId, txHash: ethTx.hash }, 'ETH HTLC tx sent');
      const ethReceipt = await ethTx.wait();
      logger.info({ orderId, txHash: ethTx.hash }, 'ETH HTLC created successfully');

      (orderData as Record<string, unknown>).status = 'eth_htlc_created';
      (orderData as Record<string, unknown>).ethereum = {
        orderId: ethReceipt.logs[0]?.topics[1],
        txHash: ethTx.hash,
        contractAddress: mainnetHTLCAddress,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ orderId, err: message }, 'ETH HTLC creation failed');
      (orderData as Record<string, unknown>).status = 'eth_htlc_failed';
      const category = classifyFailureCategory(err, 'ethereum');
      globalSettlementFailureStore.recordFailure({
        orderId,
        direction: 'xlm_to_eth',
        category,
        errorMessage: message,
        chain: 'ethereum',
        recoveryAction: 'ETH HTLC creation failed in Stellar payment poller',
      });
    }
  }

  // ── Main: start all pollers ───────────────────────────────────────────────

  async function startChainMonitoring(): Promise<void> {
    logger.info('Chain monitoring starting (swap order in flight)');

    try {
      const rpcUrl = resolveEthereumRpcUrl(
        defaultNetworkMode === 'mainnet' ? 'mainnet' : 'testnet',
      );
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const isMainnet = defaultNetworkMode === 'mainnet';
      const escrowFactoryContract = new ethers.Contract(
        getEscrowFactoryAddress(defaultNetworkMode, defaultNetworkMode === 'mainnet' ? 'mainnet' : 'testnet'),
        getEscrowFactoryABI(isMainnet),
        provider,
      );

      if (!relayerPrivateKey) {
        throw new Error(
          'RELAYER_PRIVATE_KEY is not set. Cannot start chain monitoring.',
        );
      }
      const relayerWallet = new ethers.Wallet(relayerPrivateKey, provider);
      logger.info({ address: relayerWallet.address }, 'Relayer address for proxy operations');
      logger.info('To authorize relayer: POST /api/admin/authorize-relayer');

      // ── ETH incoming transfer poller ────────────────────────────────────
      let lastProcessedBlock = await provider.getBlockNumber();

      chainPollers.push(
        startAdaptivePoll({
          label: 'eth-incoming',
          activeIntervalMs: activePollIntervalMs,
          idleIntervalMs: idlePollIntervalMs,
          isActive: () => hasPendingRelayerEscrow(activeOrders),
          isAttentive: () => hasRecentVisitor(),
          tick: async () => {
            const { payments, cursor } = await fetchIncomingEthPayments(
              provider,
              relayerWallet.address,
              lastProcessedBlock,
            );
            lastProcessedBlock = cursor;

            for (const payment of payments) {
              logger.info(
                {
                  from: payment.from,
                  valueEth: ethers.formatEther(payment.value),
                  txHash: payment.hash,
                },
                'Incoming ETH transfer detected',
              );

              for (const [orderId, orderData] of activeOrders.entries()) {
                const od = orderData as Record<string, unknown>;
                if (
                  od.ethAddress === payment.from &&
                  od.status === 'pending_relayer_escrow'
                ) {
                  logger.info({ orderId }, 'Matched ETH transfer to order');
                  await createEscrowForOrder(
                    od,
                    orderId,
                    escrowFactoryContract,
                    relayerWallet,
                  );
                  break;
                }
              }
            }
          },
        }),
      );

      // ── Stellar XLM payment poller ──────────────────────────────────────
      logger.info('Starting Stellar payment monitoring');
      let lastProcessedStellarLedger = 0;

      chainPollers.push(
        startAdaptivePoll({
          label: 'stellar-incoming',
          activeIntervalMs: activePollIntervalMs,
          idleIntervalMs: idlePollIntervalMs,
          isActive: () => hasAwaitingXlmPayment(activeOrders),
          isAttentive: () => hasRecentVisitor(),
          tick: async () => {
            const networkMode =
              defaultNetworkMode === 'mainnet' ? 'mainnet' : 'testnet';
            const stellarConfig = NETWORK_CONFIG[networkMode].stellar;
            const { Horizon } = await import('@stellar/stellar-sdk');
            const server = new Horizon.Server(stellarConfig.horizonUrl);

            const relayerStellarPublic =
              process.env.RELAYER_STELLAR_PUBLIC ?? 'YOUR_STELLAR_PUBLIC_KEY_HERE';

            const ledgerResponse = await server
              .ledgers()
              .order('desc')
              .limit(1)
              .call();
            const currentLedger = parseInt(
              ledgerResponse.records[0].sequence.toString(),
              10,
            );

            if (lastProcessedStellarLedger === 0) {
              lastProcessedStellarLedger = currentLedger - 10;
              logger.info(
                { fromLedger: lastProcessedStellarLedger },
                'Stellar monitoring initialized',
              );
              return;
            }

            const paymentsResponse = await server
              .payments()
              .forAccount(relayerStellarPublic)
              .cursor((lastProcessedStellarLedger * 4_294_967_296).toString())
              .order('asc')
              .limit(50)
              .call();

            for (const payment of paymentsResponse.records) {
              const p = payment as unknown as Record<string, unknown>;
              if (
                p.type === 'payment' &&
                p.asset_type === 'native' &&
                p.to === relayerStellarPublic
              ) {
                logger.info(
                  { from: p.from, amount: p.amount, txHash: p.transaction_hash },
                  'XLM payment detected',
                );

                const txResponse = await server
                  .transactions()
                  .transaction(p.transaction_hash as string)
                  .call();
                const memo = txResponse.memo as string | undefined;

                if (memo?.startsWith('XLM-ETH-')) {
                  const orderPrefix = memo.replace('XLM-ETH-', '');
                  logger.info(
                    { memo, orderPrefix },
                    'Found XLM→ETH payment with memo',
                  );

                  for (const [orderId, orderData] of activeOrders.entries()) {
                    const od = orderData as Record<string, unknown>;
                    if (
                      orderId.includes(orderPrefix) &&
                      od.status === 'awaiting_xlm_payment'
                    ) {
                      logger.info({ orderId }, 'Matched XLM payment to order');
                      const expectedXLM = parseFloat(
                        (od.stellar as Record<string, unknown>)?.amount as string,
                      );
                      const receivedXLM = parseFloat(p.amount as string);
                      if (Math.abs(receivedXLM - expectedXLM) < 0.001) {
                        logger.info(
                          { received: receivedXLM, expected: expectedXLM },
                          'XLM amount verified',
                        );
                        await createETHHTLCForOrder(od, orderId);
                      } else {
                        logger.warn(
                          { received: receivedXLM, expected: expectedXLM },
                          'XLM amount mismatch',
                        );
                      }
                      break;
                    }
                  }
                }
              }
            }

            lastProcessedStellarLedger = currentLedger;
          },
        }),
      );

      // ── EscrowFactory contract event poller ─────────────────────────────
      const escrowFactoryEventBindings: ContractEventBinding[] = [];

      if (isMainnet) {
        escrowFactoryEventBindings.push({
          eventName: 'SrcEscrowCreated',
          handler: async (srcImmutables: Record<string, unknown>) => {
            logger.info(
              {
                orderHash: srcImmutables.orderHash,
                hashlock: srcImmutables.hashlock,
                amountEth: ethers.formatEther(srcImmutables.amount as bigint),
              },
              'MAINNET SrcEscrowCreated event',
            );
            for (const [orderId, orderData] of activeOrders.entries()) {
              const od = orderData as Record<string, unknown>;
              if (od.hashLock === srcImmutables.hashlock) {
                logger.info(
                  { orderId, orderHash: srcImmutables.orderHash },
                  'Matched src escrow to order',
                );
                od.orderHash = srcImmutables.orderHash;
                od.status = 'src_escrow_created';
                break;
              }
            }
          },
        });

        escrowFactoryEventBindings.push({
          eventName: 'DstEscrowCreated',
          handler: async (
            escrowAddress: string,
            hashlock: string,
            taker: bigint,
          ) => {
            logger.info(
              { escrowAddress, hashlock, taker: taker.toString() },
              'MAINNET DstEscrowCreated event',
            );
            for (const [orderId, orderData] of activeOrders.entries()) {
              const od = orderData as Record<string, unknown>;
              if (od.hashLock === hashlock) {
                logger.info({ orderId, escrowAddress }, 'Matched dst escrow to order');
                od.escrowAddress = escrowAddress;
                od.status = 'dst_escrow_created';
                break;
              }
            }
          },
        });
      } else {
        escrowFactoryEventBindings.push({
          eventName: 'EscrowCreated',
          handler: async (
            escrowId: bigint,
            escrowAddress: string,
            resolver: string,
            token: string,
            amount: bigint,
            hashLock: string,
            timelock: bigint,
            safetyDeposit: bigint,
            chainId: bigint,
          ) => {
            logger.info(
              {
                escrowId: escrowId.toString(),
                escrowAddress,
                resolver,
                amountEth: ethers.formatEther(amount),
                hashLock,
                chainId: chainId.toString(),
                safetyDepositEth: ethers.formatEther(safetyDeposit),
              },
              'TESTNET EscrowCreated event',
            );
            for (const [orderId, orderData] of activeOrders.entries()) {
              const od = orderData as Record<string, unknown>;
              if (od.hashLock === hashLock) {
                logger.info(
                  { orderId, escrowId: escrowId.toString() },
                  'Matched escrow to order',
                );
                od.escrowId = escrowId.toString();
                od.escrowAddress = escrowAddress;
                od.status = 'escrow_active';
                break;
              }
            }
          },
        });

        escrowFactoryEventBindings.push({
          eventName: 'EscrowFunded',
          handler: async (
            escrowId: bigint,
            funder: string,
            amount: bigint,
            safetyDeposit: bigint,
          ) => {
            logger.info(
              {
                escrowId: escrowId.toString(),
                funder,
                amountEth: ethers.formatEther(amount),
                safetyDepositEth: ethers.formatEther(safetyDeposit),
              },
              'TESTNET EscrowFunded event',
            );
            for (const [orderId, orderData] of activeOrders.entries()) {
              const od = orderData as Record<string, unknown>;
              if (od.escrowId === escrowId.toString()) {
                logger.info({ orderId, escrowId: escrowId.toString() }, 'Escrow funded');
                od.status = 'escrow_funded';
                break;
              }
            }
          },
        });
      }

      if (escrowFactoryEventBindings.length > 0) {
        escrowFactoryPoller = await startContractEventPoller(
          escrowFactoryContract,
          provider,
          escrowFactoryEventBindings,
          {
            label: 'escrow-factory',
            intervalMs: activePollIntervalMs,
            idleIntervalMs: idlePollIntervalMs,
            isActive: () => needsChainMonitoring(activeOrders),
            isAttentive: () => hasRecentVisitor(),
          },
        );
      }

      logger.info('EscrowFactory event listeners set up successfully');

      // ── HTLCBridge event listener (testnet only) ─────────────────────────
      if (defaultNetworkMode !== 'mainnet') {
        logger.info('Starting EthereumEventListener for HTLCBridge monitoring');
        ethereumListener.configurePolling({
          isActive: () => needsChainMonitoring(activeOrders),
          isAttentive: () => hasRecentVisitor(),
        });
        await ethereumListener.startListening();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to setup EscrowFactory events');
      throw err;
    }
  }

  // ── Public handle ─────────────────────────────────────────────────────────

  return {
    async onOrderStored(orderId: string): Promise<void> {
      if (!needsChainMonitoring(activeOrders)) return;
      await ensureChainMonitoring();
      wakeChainPollers();
    },

    async shutdown(): Promise<void> {
      logger.info('Event orchestrator shutting down');
      await stopChainMonitoring();
    },
  };
}
