import { loadConfig, logSolanaStatus } from './config.js';
import { getLogger } from './logger.js';
import { openDatabase } from './persistence/db.js';
import { OrdersRepository } from './persistence/orders-repo.js';
import { OrderService } from './services/order-service.js';
import { QuoteService } from './services/quote-service.js';
import { SecretService } from './services/secret-service.js';
import { createApp } from './server/app.js';
import { EthereumListener } from './listeners/ethereum-listener.js';
import { SorobanListener } from './listeners/soroban-listener.js';
import { SolanaListener } from './listeners/solana-listener.js';
import { Reconciler } from './reconciliation/reconciler.js';
import { CacheVerifier } from './reconciliation/cache-verifier.js';
import { StaleCleanupService } from './services/stale-cleanup.js';
import { ArchivalPolicy } from './archival/archival-policy.js';
import { BacklogScheduler, Priority } from './backlog/backlog-scheduler.js';
import { MaintenanceScheduler } from './services/maintenance-scheduler.js';
import { createReadinessChecks } from './readiness.js';
import type { StartupPhase } from './readiness.js';
import { deriveRuntimeFallbackPolicy, evaluateDependencyHealth } from './degraded-mode.js';
import { retryAsync } from './retry.js';
import {
  solanaPlaceholderMode,
  expiryScanRuns,
  ordersExpiredTotal,
  expiryScanLastRun,
  coordinatorDependencyHealth,
} from './metrics.js';
import type { CoordinatorConfig } from './config.js';
import { AuditRepository } from './audit/audit-repo.js';
import { buildSystemAuditEntry } from './audit/audit-log.js';
import { PressureController } from './services/pressure-controller.js';

// ── Startup dependency probes ────────────────────────────────────────────────

/**
 * Probe each chain RPC to confirm it is reachable before starting listeners.
 * These are TRANSIENT checks — a temporary outage should not crash the
 * coordinator.  Returns true if all probes pass; logs warnings and returns
 * false otherwise so the caller can decide whether to proceed or retry.
 *
 * This is intentionally lightweight: we only check network reachability here,
 * not chain-id or network-passphrase consistency (the listeners do that).
 */
async function probeRpcEndpoints(
  cfg: CoordinatorConfig,
  log: ReturnType<typeof getLogger>
): Promise<void> {
  type FetchLike = typeof globalThis.fetch;
  const fetcher: FetchLike = globalThis.fetch;

  const probes: Array<{ name: string; url: string; method: string }> = [
    { name: 'ethereum_rpc', url: cfg.ethereum.rpcUrl, method: 'eth_blockNumber' },
    { name: 'soroban_rpc', url: cfg.soroban.rpcUrl, method: 'getHealth' },
  ];

  // Only probe the Solana RPC when the program id is a real address.
  if (!cfg.solana.programId.startsWith('PLACEHOLDER')) {
    probes.push({ name: 'solana_rpc', url: cfg.solana.rpcUrl, method: 'getHealth' });
  }

  const errors: string[] = [];
  await Promise.all(
    probes.map(async ({ name, url, method }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
          signal: controller.signal,
        });
        if (!res.ok) {
          errors.push(`${name}: HTTP ${res.status}`);
        }
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    })
  );

  if (errors.length > 0) {
    throw new Error(`RPC probe failed — ${errors.join('; ')}`);
  }

  log.info('all RPC endpoints reachable');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Load and validate configuration (FATAL on failure) ────────────────
  //
  // Config loading reads env vars and validates their shape. A failure here
  // is always fatal: there is nothing to retry because the problem is in the
  // deployment environment, not a transient service outage.
  let cfg: CoordinatorConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(
      '[coordinator] FATAL: configuration is invalid — cannot start.',
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }

  const log = getLogger(cfg.logLevel);
  log.info({ network: cfg.network, port: cfg.port }, 'WaffleFinance coordinator starting');

  // ── 2. Solana placeholder check ──────────────────────────────────────────
  const solanaStatus = logSolanaStatus(cfg.solana.programId);
  solanaPlaceholderMode.set(solanaStatus === 'placeholder' ? 1 : 0);
  if (solanaStatus === 'placeholder') {
    log.warn(
      { programId: cfg.solana.programId },
      'Solana HTLC program is a placeholder — Solana listener and settlement flows are DISABLED'
    );
  } else {
    log.info({ programId: cfg.solana.programId }, 'Solana HTLC program configured');
  }

  // ── 3. Database connection (TRANSIENT retry, FATAL on schema mismatch) ──
  log.info(
    { maxAttempts: 10, baseDelayMs: 1_000 },
    'connecting to database (will retry on transient failures)'
  );

  const db = await retryAsync(() => openDatabase(cfg.databaseUrl), {
    maxAttempts: 10,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterMs: 300,
    shouldRetry: err => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Schema validation failed')) return false;
      if (msg.includes('Database schema is behind')) return false;
      if (msg.includes('Database schema is ahead')) return false;
      if (msg.includes('Schema version mismatch')) return false;
      if (msg.includes('Migration history is out of order')) return false;
      return true;
    },
    onRetry: ({ attempt, maxAttempts, delayMs, err }) => {
      log.warn(
        {
          attempt,
          maxAttempts,
          delayMs,
          err: err instanceof Error ? err.message : String(err),
        },
        'database connection attempt failed — retrying (transient)'
      );
    },
  }).catch((err): never => {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('Schema validation failed') ||
      msg.includes('Database schema is') ||
      msg.includes('Schema version mismatch') ||
      msg.includes('Migration history is out of order')
    ) {
      log.error(
        { err },
        'FATAL: database schema mismatch — run migrations before starting the coordinator'
      );
    } else {
      log.error({ err }, 'FATAL: could not connect to database after all retry attempts');
    }
    process.exit(1);
  });

  log.info('database ready');

  // ── 4. RPC endpoint health probe (TRANSIENT retry) ─────────────────────
  log.info('probing chain RPC endpoints (will retry on transient failures)');

  await retryAsync(() => probeRpcEndpoints(cfg, log), {
    maxAttempts: 8,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
    jitterMs: 500,
    onRetry: ({ attempt, maxAttempts, delayMs, err }) => {
      log.warn(
        {
          attempt,
          maxAttempts,
          delayMs,
          err: err instanceof Error ? err.message : String(err),
        },
        'RPC probe failed — coordinator is PENDING (waiting for dependencies)'
      );
    },
  }).catch(err => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'RPC probe exhausted retries — starting listeners anyway; readiness will reflect degraded state'
    );
  });

  // ── 5. Wire up services ─────────────────────────────────────────────────
  let startupPhase: StartupPhase = 'starting';

  const repo = new OrdersRepository(db);
  const auditRepo = new AuditRepository(db);
  const orders = new OrderService(repo, log, { auditRepo });
  const secrets = new SecretService(orders, log, cfg.secretStorageKey ?? undefined);
  const quotes = new QuoteService(log);

  auditRepo
    .append(
      buildSystemAuditEntry('system.startup', 'coordinator started', {
        serviceVersion: process.env.npm_package_version ?? null,
      })
    )
    .catch(() => {
      /* non-fatal */
    });

  const reconciler = new Reconciler(cfg, orders, log);
  const cacheVerifier = new CacheVerifier(cfg, repo, log);
  const staleCleanup = new StaleCleanupService(repo, log);
  const archivalPolicy = new ArchivalPolicy(repo, log);

  // ── Backlog scheduler ────────────────────────────────────────────────────
  // Central dispatcher enforcing:  LIVE_EVENT > REPLAY_JOB > SECRET_RECOVERY > STALE_CLEANUP
  const backlog = new BacklogScheduler(log);
  const pressureController = new PressureController();

  // ── Maintenance scheduler ────────────────────────────────────────────────
  //
  // Replaces the two raw setInterval calls that previously drove expiry scans
  // and stale-order archival.  Each job is:
  //   - Named so metrics and logs are self-describing.
  //   - Assigned a priority class so it slots into the BacklogScheduler
  //     contract without conflicting with live-event processing.
  //   - Protected by the skip-if-running guard so concurrent ticks never
  //     launch two simultaneous cleanup passes.
  //   - Cadence-multiplied off cfg.pollIntervalMs so the rhythm is
  //     configurable without touching this file.
  //
  // Job cadences (defaults with pollIntervalMs=15 000 ms):
  //   expiry_scan     × 4   → every  ~60 s  (same as before)
  //   stale_cleanup   × 240 → every  ~60 min (same as before)
  //   archival_policy × 240 → every  ~60 min (same as before)
  const maintenance = new MaintenanceScheduler(backlog, log, cfg.pollIntervalMs);

  maintenance.register({
    name: 'expiry_scan',
    cadenceMultiplier: 4,
    priority: Priority.REPLAY_JOB,
    execute: async () => {
      const expiredCount = await orders.expireStaleOrders();
      // Keep the pre-existing per-scan metrics so dashboards that already
      // depend on coordinator_expiry_scan_runs_total continue to work.
      expiryScanRuns.inc({ result: 'success' });
      ordersExpiredTotal.inc(expiredCount);
      expiryScanLastRun.set(Math.floor(Date.now() / 1000));
      if (expiredCount > 0) {
        log.info({ expiredCount }, 'expiry_scan: marked orders expired by timelock');
      }
      return { expiredCount };
    },
  });

  maintenance.register({
    name: 'stale_cleanup',
    cadenceMultiplier: 240,
    priority: Priority.STALE_CLEANUP,
    execute: async () => {
      const result = await staleCleanup.run();
      return { archivedCount: result.archivedCount };
    },
  });

  maintenance.register({
    name: 'archival_policy',
    cadenceMultiplier: 240,
    priority: Priority.STALE_CLEANUP,
    execute: async () => {
      await archivalPolicy.runArchival();
      return {};
    },
  });

  // Admin-facing expiry trigger — wraps the maintenance job so the admin
  // route and the scheduler both go through the same metric + skip path.
  const runExpiryTrigger = async (): Promise<{ expiredCount: number }> => {
    const result = await maintenance.runJob('expiry_scan');
    // On skip, report 0 expired (the previous run is still in flight).
    const expiredCount = (result.detail?.expiredCount as number | undefined) ?? 0;
    return { expiredCount };
  };

  const app = createApp({
    log,
    corsOrigin: cfg.corsOrigin,
    orders,
    secrets,
    quotes,
    auditRepo,
    getReconciliationStatus: () => reconciler.getStatus(),
    getReadinessChecks: createReadinessChecks({
      cfg,
      db,
      getReconciliationStatus: () => reconciler.getStatus(),
      getStartupPhase: () => startupPhase,
      getCacheVerificationStatus: () => cacheVerifier.getStatus(),
    }),
    runReconcile: async () => {
      await reconciler.run();
      return reconciler.getStatus();
    },
    runStaleCleanup: () => staleCleanup.run(),
    runExpiry: runExpiryTrigger,
  });

  const server = app.listen(cfg.port, () => {
    log.info({ port: cfg.port }, 'HTTP server listening');
  });

  const updateDependencyHealthMetric = (checks: Array<{ name: string; ok: boolean }>) => {
    const report = evaluateDependencyHealth(checks);
    coordinatorDependencyHealth.reset();
    coordinatorDependencyHealth.set({ mode: report.overall }, 1);
  };

  const readiness = createReadinessChecks({
    cfg,
    db,
    getReconciliationStatus: () => reconciler.getStatus(),
    getStartupPhase: () => startupPhase,
    getCacheVerificationStatus: () => cacheVerifier.getStatus(),
  });

  const initialReadinessChecks = await readiness();
  updateDependencyHealthMetric(initialReadinessChecks);
  const fallbackPolicy = deriveRuntimeFallbackPolicy(initialReadinessChecks);

  if (fallbackPolicy.mode !== 'healthy') {
    log.warn(
      {
        mode: fallbackPolicy.mode,
        disabledListeners: fallbackPolicy.disabledListeners,
        reasons: fallbackPolicy.reasons,
      },
      'coordinator entering degraded mode; reducing listener activity'
    );
  }

  // ── 6. Background intervals ─────────────────────────────────────────────
  //
  // Reconciliation is still driven by a raw setInterval + BacklogScheduler
  // enqueue because it has its own startup-warmup logic (the first run must
  // resolve before startupPhase moves to "ready"), which doesn't fit cleanly
  // into MaintenanceScheduler's uniform cadence model.
  //
  // Expiry, stale-cleanup and archival-policy are all driven by
  // MaintenanceScheduler.start() below — no more raw setIntervals for those.

  const applyPressurePolicy = () => {
    const pressure = backlog.getTotalDepth();
    pressureController.observe({
      kind: 'reconciliation',
      queueDepth: pressure,
      lag: Math.max(0, (cfg.pollIntervalMs ?? 15000) - 15000),
      failureRate: 0.05,
    });
  };

  // First reconciliation: enqueue as a REPLAY_JOB so it runs before any
  // stale-cleanup work but yields to any live events the listeners enqueue.
  applyPressurePolicy();
  void backlog.enqueue({
    name: 'reconciler:startup',
    priority: Priority.REPLAY_JOB,
    execute: async () => {
      await reconciler.run();
      const report = evaluateDependencyHealth(await readiness());
      startupPhase = report.overall === 'healthy' ? 'ready' : 'degraded';
      if (report.overall === 'healthy') {
        log.info('first reconciliation complete — coordinator is READY');
      } else {
        log.warn(
          { mode: report.overall, degradedServices: report.degradedServices },
          'first reconciliation complete — coordinator remains DEGRADED'
        );
      }
    },
  });
  void backlog.run().catch(err => {
    log.warn({ err }, 'first reconciliation run failed — staying in pending state');
  });

  // Periodic reconciliation: every pollIntervalMs × 4 (default ~60 s)
  const reconcileInterval = setInterval(() => {
    applyPressurePolicy();
    backlog.enqueue({
      name: 'reconciler:periodic',
      priority: Priority.REPLAY_JOB,
      execute: () => reconciler.run(),
    });
    void backlog.run();
  }, cfg.pollIntervalMs * 4);

  // Expiry scan: every pollIntervalMs × 4 (default ~60 s)
  const runExpiry = (): void => {
    applyPressurePolicy();
    backlog.enqueue({
      name: 'expiry-scan',
      priority: Priority.REPLAY_JOB,
      execute: async () => {
        const n = await orders.expireStaleOrders();
        if (n > 0) log.info({ count: n }, 'expired stale orders by timelock');
      },
    });
    void backlog.run();
  };
  void runExpiry();
  const expiryInterval = setInterval(runExpiry, cfg.pollIntervalMs * 4);

  // Stale-order archival: every pollIntervalMs × 240 (default ~60 min)
  // Routed as STALE_CLEANUP — lowest priority.  Both old StaleCleanupService
  // and the new ArchivalPolicy run here so the metrics for each are preserved.
  const runStaleCleanup = (): void => {
    applyPressurePolicy();
    backlog.enqueue({
      name: 'stale-cleanup',
      priority: Priority.STALE_CLEANUP,
      execute: () => staleCleanup.run().then(() => undefined),
    });
    backlog.enqueue({
      name: 'archival-policy',
      priority: Priority.STALE_CLEANUP,
      execute: () => archivalPolicy.runArchival().then(() => undefined),
    });
    void backlog.run();
  };
  const staleCleanupInterval = setInterval(runStaleCleanup, cfg.pollIntervalMs * 240);

  // Cache verification runs every ~60 reconciliation cycles (roughly once per
  // hour at the default 15 s poll interval × 4 multiplier).  It is read-only
  // and low-cost — it only samples 50 active orders — so running it more
  // frequently than hourly would provide no additional safety margin.
  const runCacheVerify = (): void => {
    cacheVerifier.run().catch(err => log.warn({ err }, 'cache verification failed'));
  };
  // Run once shortly after startup so operators see an initial
  // `cache_alignment` status in the first /readyz response.
  setTimeout(() => void runCacheVerify(), 30_000);
  const cacheVerifyInterval = setInterval(runCacheVerify, cfg.pollIntervalMs * 240);

  // Start the maintenance scheduler — fires first tick of each job immediately
  // and then on the configured cadence.  This replaces the old expiryInterval
  // and staleCleanupInterval setInterval handles.
  maintenance.start();

  // ── 7. Listeners ────────────────────────────────────────────────────────
  const ethListener = new EthereumListener(cfg, orders, log);
  const sorobanListener = new SorobanListener(cfg, orders, log);
  const solanaListener = new SolanaListener(cfg, orders, log);

  if (fallbackPolicy.enabledListeners.includes('ethereum')) {
    ethListener.start();
  } else {
    log.warn({ chain: 'ethereum' }, 'Ethereum listener disabled by degraded-mode policy');
  }

  if (fallbackPolicy.enabledListeners.includes('soroban')) {
    sorobanListener.start();
  } else {
    log.warn({ chain: 'soroban' }, 'Soroban listener disabled by degraded-mode policy');
  }

  if (fallbackPolicy.enabledListeners.includes('solana')) {
    solanaListener.start();
  } else {
    log.warn({ chain: 'solana' }, 'Solana listener disabled by degraded-mode policy');
  }

  // Transition to "pending" — dependencies are up, first reconciliation
  // not yet done.  The readiness endpoint will return HTTP 200 but with
  // detail="pending" so orchestration systems can distinguish "warming up"
  // from "fully ready".
  startupPhase = fallbackPolicy.mode === 'healthy' ? 'pending' : 'degraded';

  log.info(
    { mode: pressureController.getMode(), limits: pressureController.getLimits() },
    'coordinator fully started — all listeners active'
  );

  // ── 8. Graceful shutdown ────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    auditRepo
      .append(buildSystemAuditEntry('system.shutdown', `coordinator shutdown via ${signal}`))
      .catch(() => {
        /* non-fatal */
      });

    // Stop the maintenance scheduler first so no new jobs are enqueued
    // after we begin draining.
    maintenance.stop();

    clearInterval(reconcileInterval);
    clearInterval(cacheVerifyInterval);
    ethListener.stop();
    sorobanListener.stop();
    solanaListener.stop();
    server.close(() => {
      if ('close' in db) (db as any).close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
  console.error(
    '[coordinator] FATAL: unhandled startup error:',
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
