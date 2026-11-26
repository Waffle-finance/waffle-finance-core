/**
 * @fileoverview WaffleFinance Relayer — boot file.
 *
 * Reduced boot file that delegates concern handling to extracted services and routers:
 *   config/networks.ts          → network addresses, ABIs, adapters
 *   config/startup-config.ts    → startup config: network mode, runtime config,
 *                                 env-validation input, retry and watchdog settings
 *   services/pricing-service.ts → SWR price cache, dynamic safety deposit
 *   core/event-orchestrator.ts  → chain polling, contract event listeners
 *   routes/orders.ts            → order management & processing API
 *   routes/admin.ts             → relayer admin & status API
 *   logger.ts                   → Pino structured logger
 *   request-context.ts          → AsyncLocalStorage request-ID middleware
 */

import { loadRelayerConfig } from '@wafflefinance/config/node';
import express, { type Request, type Response } from 'express';
import cors from 'cors';

import { getLogger } from './logger.js';
import { requestIdMiddleware } from './request-context.js';
import {
  buildEnvironmentValidationInput,
  buildRelayerStartupConfig,
  resolveRefundWatchdogSettings,
  resolveStartupDependencyOptions,
} from './config/startup-config.js';
import { createEventOrchestrator } from './core/event-orchestrator.js';
import { startRefundWatchdog } from './services/refund-watchdog.js';
import { requireAdminAuth } from './middleware/admin-auth.js';
import { gasPriceTracker } from './services/gas-tracker.js';
import { getMonitor } from './services/monitoring.js';
import { logSolanaStatus } from './utils/solana-config.js';
import {
  buildSupportPolicy,
  logSupportPolicy,
} from './support.js';
import { assertSupportPolicy, SupportPolicyValidationError } from '@wafflefinance/config';
import {
  solanaPlaceholderMode,
  orderQueueDepth,
} from './metrics.js';
import { validateRelayerStartup, formatStartupErrors } from './config-validator.js';
import { validateEnvironment, formatValidationErrors } from '@wafflefinance/config';
import { configureSitePresence } from './utils/site-presence.js';
import { needsChainMonitoring } from './utils/order-poll-utils.js';
import { metricsRouter } from './routes/metrics.js';
import { healthRouter } from './routes/health.js';
import { ordersRouter } from './routes/orders.js';
import { adminRouter } from './routes/admin.js';

const logger = getLogger();

// Config
const startupConfig = buildRelayerStartupConfig(loadRelayerConfig());
const DEFAULT_NETWORK_MODE = startupConfig.defaultNetworkMode;

export const RELAYER_CONFIG = startupConfig.runtimeConfig;

import { assertStartupDependencies, logStartupTransition } from './startup-health-check.js';
logger.info({ network: DEFAULT_NETWORK_MODE }, 'Default network mode');
logger.info(
  { escrowFactory: RELAYER_CONFIG.ethereum.escrowFactoryAddress },
  'Default escrow factory',
);

const app = express();

app.get('/metrics', (_req: Request, res: Response) => {
  try {
    res.json(getMonitor().getMetrics());
  } catch (err: unknown) {
    logger.error({ err }, 'Metrics fetch failed');
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

app.get('/uptime', (_req: Request, res: Response) => {
  try {
    const monitor = getMonitor();
    const m = monitor.getMetrics();
    res.json({ uptime: m.uptime, startTime: m.timestamp - m.uptime, currentTime: m.timestamp, status: monitor.getSystemStatus() });
  } catch (err: unknown) {
    logger.error({ err }, 'Uptime check failed');
    res.status(500).json({ error: 'Failed to fetch uptime' });
  }
});

async function initializeRelayer() {
  logger.info('Initializing WaffleFinance Relayer Service');

  app.use(cors({
    origin: ['http://localhost:5173','http://localhost:5174','http://127.0.0.1:5173','http://127.0.0.1:5174','https://wafflefinance.vercel.app','https://wafflefinance.vercel.app/'],
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Validate configuration
  validateConfig();

  // Cross-field environment validation (network mode vs chain ID, contract
  // addresses, secret/address pairings, etc.). Runs before any listener binds
  // a port so mismatches surface immediately with a redacted, structured list.
  const envErrors = validateEnvironment(
    buildEnvironmentValidationInput(process.env, RELAYER_CONFIG, DEFAULT_NETWORK_MODE),
  );
  if (envErrors.length > 0) {
    logger.error({ errors: envErrors }, 'Environment validation failed — refusing to start');
    throw new Error(`Relayer environment validation failed:\n${formatValidationErrors(envErrors)}`);
  }
  logStartupTransition('config_validated');

  // ── Startup dependency health checks ─────────────────────────────────────
  //
  // Before the relayer begins processing orders it must confirm that the
  // coordinator (order-book service) and resolver registry are reachable.
  // If dependencies are not ready the relayer retries with exponential
  // back-off.  If max retries are exceeded it exits with a clear error.
  const dependencyOptions = resolveStartupDependencyOptions(process.env);
  logStartupTransition('deps_checking', {
    coordinatorUrl: dependencyOptions.coordinatorUrl ?? '(not set)',
    resolverRegistryUrl: dependencyOptions.resolverRegistryUrl ?? '(not configured)',
  });
  await assertStartupDependencies(dependencyOptions);
  logStartupTransition('deps_ready');
  app.use(requestIdMiddleware);

  const errs = validateRelayerStartup(process.env as Record<string, string | undefined>, {
    ethereumPrivateKey: RELAYER_CONFIG.ethereum.privateKey,
    stellarSecretKey: RELAYER_CONFIG.stellar.secretKey,
  });
  if (errs.length > 0) {
    logger.error({ errors: errs }, 'Relayer startup validation failed — refusing to start');
    throw new Error(`Relayer startup validation failed:\n${formatStartupErrors(errs)}`);
  }

  const solanaProgram = process.env.SOLANA_HTLC_PROGRAM ?? process.env.SOLANA_HTLC_PROGRAM_TESTNET ?? process.env.SOLANA_HTLC_PROGRAM_MAINNET;
  solanaPlaceholderMode.set(logSolanaStatus(solanaProgram) === 'placeholder' ? 1 : 0);

  const supportPolicy = buildSupportPolicy(RELAYER_CONFIG, solanaProgram);
  try {
    assertSupportPolicy(supportPolicy);
  } catch (err) {
    if (err instanceof SupportPolicyValidationError) {
      logger.error({ errors: err.errors }, 'Support policy invalid — refusing to start');
      process.exit(1);
    }
    throw err;
  }
  logSupportPolicy(supportPolicy);

  logger.info({
    nodeEnv: RELAYER_CONFIG.nodeEnv,
    ethereumNetwork: RELAYER_CONFIG.ethereum.network,
    stellarNetwork: RELAYER_CONFIG.stellar.network,
    mockMode: RELAYER_CONFIG.enableMockMode,
    port: RELAYER_CONFIG.port,
  }, 'Relayer configuration');

  if (RELAYER_CONFIG.security.emergencyShutdown) { logger.error('Emergency shutdown active'); process.exit(1); }
  if (RELAYER_CONFIG.security.maintenanceMode) logger.warn('Maintenance mode active');

  const activeOrders = new Map<string, Record<string, unknown>>();

  configureSitePresence(RELAYER_CONFIG.visitorTtlMs);

  const orchestrator = createEventOrchestrator({
    defaultNetworkMode: DEFAULT_NETWORK_MODE,
    activePollIntervalMs: RELAYER_CONFIG.activePollIntervalMs,
    idlePollIntervalMs: RELAYER_CONFIG.idlePollIntervalMs,
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY,
    relayerStellarPublic: process.env.RELAYER_STELLAR_PUBLIC,
  }, activeOrders);

  const storeActiveOrder = async (orderId: string, data: Record<string, unknown>) => {
    activeOrders.set(orderId, data);
    orderQueueDepth.set(activeOrders.size);
    if (needsChainMonitoring(activeOrders)) await orchestrator.onOrderStored(orderId);
  };

  try { gasPriceTracker.startMonitoring(30_000); logger.info('Gas price tracking started'); }
  catch (err) { logger.error({ err }, 'Failed to start gas price tracking'); }

  try {
    const monitor = getMonitor();
    ['ethereum','stellar','gas-tracker','orders'].forEach((s) => monitor.registerService(s, async () => ({ status: 'healthy' })));
    monitor.startMonitoring(30_000);
    logger.info('Uptime monitoring started');
  } catch (err) { logger.error({ err }, 'Failed to start monitoring'); }

  app.use(metricsRouter());
  app.use(healthRouter());
  app.use(ordersRouter({
    relayerConfig: RELAYER_CONFIG,
    defaultNetworkMode: DEFAULT_NETWORK_MODE,
    supportPolicy,
    activeOrders,
    orchestrator,
    storeActiveOrder,
  }));
  app.use(adminRouter({
    relayerConfig: RELAYER_CONFIG,
    defaultNetworkMode: DEFAULT_NETWORK_MODE,
  }));

  app.get('/', (_req: Request, res: Response) => res.json({ message: 'WaffleFinance Relayer API', status: 'running' }));
  app.get('/test', (_req: Request, res: Response) => res.json({ message: 'ROOT test working!', timestamp: new Date().toISOString() }));

  const apiTestHandler = (_req: Request, res: Response) =>
    res.json({ message: 'API endpoints are working!', timestamp: new Date().toISOString() });
  if (process.env.NODE_ENV === 'production') app.get('/api/test', requireAdminAuth(), apiTestHandler);
  else app.get('/api/test', apiTestHandler);

  const testTxHandler = (_req: Request, res: Response) => res.json({
    success: true,
    approvalTransaction: { to: '0x742d35cF0b7bbF6E175239d74a0e0a3d1C7B87E4', value: '0x71afd498d0000', data: '0x', gas: '0x5208', gasPrice: '0x4a817c800' },
    message: 'DEBUG: Simple transaction format',
  });
  if (process.env.NODE_ENV === 'production') app.get('/api/test-transaction', requireAdminAuth(), testTxHandler);
  else app.get('/api/test-transaction', testTxHandler);

  console.log('≡ƒôì DEBUG: Orders endpoints registered successfully');

  // Phase 6.5: EscrowFactory Event Listening (lazy — first swap order only).
  // Chain monitoring itself is owned by the event orchestrator; this block
  // only gates listener startup on re-validated config and starts the watchdog.
  const startChainMonitoring = async () => {
  // Re-validate before binding the port / starting listeners so a config
  // mutated after boot cannot slip past the startup gate.
  const lateErrors = validateEnvironment(
    buildEnvironmentValidationInput(process.env, RELAYER_CONFIG, DEFAULT_NETWORK_MODE),
  );
  if (lateErrors.length > 0) {
    logger.error({ errors: lateErrors }, 'Environment validation failed before listener startup');
    throw new Error(`Relayer environment validation failed:\n${formatValidationErrors(lateErrors)}`);
  }
  logStartupTransition('listeners_starting', { trigger: 'first_swap_order' });
  console.log('≡ƒöù Chain monitoring starting (swap order in flight)...');

  // ≡ƒ¢í∩╕Å Refund watchdog: rescue stuck XLMΓåÆETH orders that the request
  // loop failed to refund (e.g. user closed the tab, RPC outage past
  // our retry budget). Best-effort, never throws into the event loop.
  try {
    const watchdog = resolveRefundWatchdogSettings(DEFAULT_NETWORK_MODE, process.env);
    if (watchdog) {
      startRefundWatchdog({
        horizonUrl: watchdog.horizonUrl,
        refundSecret: watchdog.refundSecret,
        networkMode: watchdog.networkMode,
        activeOrders,
      });
    } else {
      logger.warn('Refund watchdog disabled: RELAYER_STELLAR_SECRET not configured');
    }
  } catch (watchdogErr) {
    logger.error({ err: watchdogErr }, 'Failed to start refund watchdog');
  }

  app.listen(RELAYER_CONFIG.port, () => {
    logger.info({ port: RELAYER_CONFIG.port }, 'HTTP server started');
  });

  // Start HTTP server
  const server = app.listen(RELAYER_CONFIG.port, () => {
    console.log(`≡ƒîÉ HTTP server started on port ${RELAYER_CONFIG.port}`);
  });

  logStartupTransition('ready', { port: RELAYER_CONFIG.port });
  console.log('Γ£à Relayer service initialized successfully');
  console.log('≡ƒÄ» Ready to process cross-chain swaps');
  logger.info('Relayer service initialized successfully');
  logger.info('Ready to process cross-chain swaps');
  };
  void startChainMonitoring;
}

async function gracefulShutdown() {
  logger.info('Shutting down relayer service');
  try {
    const { ethereumListener } = await import('./listeners/ethereum-listener.js');
    await ethereumListener.stopListening();
    logger.info('Ethereum listener stopped');
  } catch (err) { logger.error({ err }, 'Error stopping Ethereum listener'); }
  logger.info('Relayer shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

initializeRelayer().catch((err) => {
  logger.error({ err }, 'Failed to initialize relayer');
  process.exit(1);
});

export default { RELAYER_CONFIG };
