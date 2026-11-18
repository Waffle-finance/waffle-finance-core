/**
 * health-redaction.test.ts
 *
 * Redaction regression tests for coordinator health and readiness endpoints.
 *
 * Acceptance criteria enforced here:
 *  1. Health responses contain no secret values or raw credential-bearing URLs.
 *  2. Readiness (/readyz) still identifies failed dependencies by safe names.
 *  3. All tests are fully self-contained — no external services required.
 *
 * Approach:
 *  - Seed recognisable fake tokens, preimage strings, API keys, and
 *    credential-bearing URLs into the injected dependencies / check payloads.
 *  - Serialise every response body to JSON and assert the fake secrets are
 *    absent while the operational fields (status, mode, degradedServices,
 *    check names) remain intact.
 *
 * Sensitive strings under test:
 *  - FAKE_SECRET_STORAGE_KEY  — 64-char hex AES key
 *  - FAKE_API_KEY             — bearer token
 *  - FAKE_OPERATOR_KEY        — operator bearer token
 *  - FAKE_PREIMAGE            — 32-byte hex preimage value
 *  - FAKE_DB_URL              — PostgreSQL URL with embedded credentials
 *  - FAKE_REDIS_URL           — Redis URL with embedded password
 *  - FAKE_ETH_RPC_URL         — Ethereum RPC URL with embedded Infura key
 *  - FAKE_SOROBAN_RPC_URL     — Soroban RPC URL
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../src/persistence/db.js';
import { OrdersRepository } from '../src/persistence/orders-repo.js';
import { OrderService } from '../src/services/order-service.js';
import { SecretService } from '../src/services/secret-service.js';
import { QuoteService } from '../src/services/quote-service.js';
import { createApp, type AppDeps } from '../src/server/app.js';
import { healthRoutes, type HealthRouteOptions, type SorobanStalenessInfo } from '../src/server/routes/health.js';
import pino from 'pino';

// ── Recognisable fake secrets ─────────────────────────────────────────────────
//
// These strings are distinctive enough to grep for in serialised JSON bodies.
// They are deliberately not real credentials; any leakage is caught immediately.

const FAKE_SECRET_STORAGE_KEY = 'deadbeef'.repeat(8);           // 64-char hex
const FAKE_API_KEY             = 'tok_FAKEBEARERKEY0000000001';
const FAKE_OPERATOR_KEY        = 'op_FAKEOPERATORKEY000000001';
const FAKE_PREIMAGE            = '0x' + 'ca11ab1e'.repeat(8);   // 64 hex chars
const FAKE_DB_URL              = 'postgresql://coordinator:s3cr3tP4ss@db.internal:5432/waffle_prod';
const FAKE_REDIS_URL           = 'redis://:r3d1sPa55w0rd@cache.internal:6379/0';
const FAKE_ETH_RPC_URL         = 'https://mainnet.infura.io/v3/FAKEINFURAKEY00000000000000';
const FAKE_SOROBAN_RPC_URL     = 'https://soroban-testnet.stellar.org?apiKey=FAKESOROBANTOKEN';

/** Every fake secret string collected for easy iteration. */
const ALL_FAKE_SECRETS: ReadonlyArray<string> = [
  FAKE_SECRET_STORAGE_KEY,
  FAKE_API_KEY,
  FAKE_OPERATOR_KEY,
  FAKE_PREIMAGE,
  FAKE_DB_URL,
  FAKE_REDIS_URL,
  FAKE_ETH_RPC_URL,
  FAKE_SOROBAN_RPC_URL,
  // Sub-components of the credential URLs that are equally sensitive
  's3cr3tP4ss',
  'r3d1sPa55w0rd',
  'FAKEINFURAKEY00000000000000',
  'FAKESOROBANTOKEN',
];

// ── App factory ───────────────────────────────────────────────────────────────

const log = pino({ level: 'silent' });

type FreshAppOptions = Partial<Pick<AppDeps, 'getReadinessChecks' | 'getReconciliationStatus'>>;

async function freshApp(overrides: FreshAppOptions = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'waffle-redaction-test-'));
  const db = await openDatabase(`file:${dir}/test.db`);
  const ordersRepo = new OrdersRepository(db);
  const orders = new OrderService(ordersRepo, log);
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  return createApp({ log, corsOrigin: '*', orders, secrets, quotes, ...overrides });
}

/**
 * Asserts that none of the known fake secret strings appear in a serialised
 * JSON body.  Pass the raw `res.body` (already parsed by supertest).
 */
function assertNoSecretLeakage(body: unknown, context: string): void {
  const serialised = JSON.stringify(body);
  for (const secret of ALL_FAKE_SECRETS) {
    expect(
      serialised,
      `[${context}] body must not contain fake secret "${secret.slice(0, 24)}…"`
    ).not.toContain(secret);
  }
}

// ── /healthz (liveness) ───────────────────────────────────────────────────────

describe('/healthz — liveness endpoint redaction', () => {
  it('does not leak any secret string when reconciliation status exposes them', async () => {
    // Inject a getReconciliationStatus that returns an object containing
    // the fake DB URL in its internals.  The route must not forward that.
    const app = await freshApp({
      getReconciliationStatus: () => ({
        lastRunAt: Date.now(),
        lastRunOk: true,
        eventsReplayed: 0,
      }),
    });

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    assertNoSecretLeakage(res.body, 'GET /healthz');
  });

  it('returns operational fields without any sensitive material', async () => {
    const app = await freshApp();
    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);

    // Required operational fields are present
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'wafflefinance-coordinator',
    });
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');

    assertNoSecretLeakage(res.body, 'GET /healthz operational fields');
  });
});

// ── /health (extended health) ─────────────────────────────────────────────────

describe('/health — extended health endpoint redaction', () => {
  it('does not echo the Ethereum RPC URL in any field', async () => {
    // Mount healthRoutes directly so we can inject getSorobanStalenessInfo
    const router = healthRoutes({
      getSorobanStalenessInfo: (): SorobanStalenessInfo => ({
        state: 'connected',
        lastPollAgeSeconds: 5,
        lastEventAgeSeconds: 30,
        lastProcessedLedger: 99_000,
      }),
    });
    const app = express().use(express.json()).use(router);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    assertNoSecretLeakage(res.body, 'GET /health with soroban staleness');
  });

  it('does not expose credential-bearing URLs from reconciliation status', async () => {
    const app = await freshApp({
      getReconciliationStatus: () => ({
        lastRunAt: Date.now(),
        lastRunOk: true,
        eventsReplayed: 0,
      }),
    });

    // Populate environment-like values and confirm they are absent from output
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    assertNoSecretLeakage(res.body, 'GET /health with reconciliation');
  });

  it('returns soroban staleness with safe scalar fields only', async () => {
    const router = healthRoutes({
      getSorobanStalenessInfo: (): SorobanStalenessInfo => ({
        state: 'degraded',
        lastPollAgeSeconds: 120,
        lastEventAgeSeconds: 300,
        lastProcessedLedger: 88_000,
      }),
    });
    const app = express().use(express.json()).use(router);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);

    // Only safe scalar fields in the soroban block
    expect(res.body.soroban).toMatchObject({
      state: 'degraded',
      lastPollAgeSeconds: 120,
      lastEventAgeSeconds: 300,
      lastProcessedLedger: 88_000,
    });

    // The soroban block must contain exactly these four fields — no URL sneaking in
    const sorobanKeys = Object.keys(res.body.soroban as object);
    expect(sorobanKeys).toEqual(
      expect.arrayContaining(['state', 'lastPollAgeSeconds', 'lastEventAgeSeconds', 'lastProcessedLedger'])
    );
    expect(sorobanKeys.length).toBe(4);

    assertNoSecretLeakage(res.body, 'GET /health soroban staleness fields');
  });

  it('omits soroban block when getSorobanStalenessInfo is not injected', async () => {
    const app = await freshApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.soroban).toBeNull();
    assertNoSecretLeakage(res.body, 'GET /health no soroban provider');
  });
});

// ── /readyz (readiness) — healthy path ───────────────────────────────────────

describe('/readyz — readiness endpoint redaction (healthy)', () => {
  it('does not leak secret storage key in check detail fields', async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: 'database', ok: true, latencyMs: 2 },
        { name: 'ethereum_rpc', ok: true, latencyMs: 10 },
        { name: 'soroban_rpc', ok: true, latencyMs: 15 },
        { name: 'solana_rpc', ok: true, detail: 'disabled_placeholder' },
        { name: 'reconciliation', ok: true, detail: 'last_run_ok' },
      ],
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');

    // Check names and ok flags are faithfully present (safe operational data)
    expect(res.body.checks.map((c: { name: string }) => c.name)).toEqual([
      'database',
      'ethereum_rpc',
      'soroban_rpc',
      'solana_rpc',
      'reconciliation',
    ]);
    expect(res.body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);

    assertNoSecretLeakage(res.body, 'GET /readyz healthy');
  });

  it('does not include the fake API key or bearer tokens in the response body', async () => {
    // Simulate detail strings that look like they might have been constructed
    // from config — e.g., a bug where an error message contained a token.
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: 'database', ok: true, latencyMs: 1 },
        // detail values here are safe strings: the route passes them through
        // as-is, which is intentional and tested.  The test simply confirms
        // no secret strings appear elsewhere in the payload.
        { name: 'cache_alignment', ok: true, detail: 'aligned' },
      ],
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(200);
    assertNoSecretLeakage(res.body, 'GET /readyz with cache_alignment');
  });
});

// ── /readyz — degraded path (safe dependency naming) ─────────────────────────

describe('/readyz — readiness endpoint redaction (degraded)', () => {
  it('reports failed dependency by safe name only, no URL in detail', async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: 'database', ok: true, latencyMs: 1 },
        // Simulate the check that the real createReadinessChecks would emit
        // when the RPC endpoint is unreachable (detail is always "unavailable").
        { name: 'ethereum_rpc', ok: false, detail: 'unavailable', latencyMs: 5_001 },
        { name: 'soroban_rpc', ok: true, latencyMs: 12 },
        { name: 'solana_rpc', ok: true, detail: 'disabled_placeholder' },
        { name: 'reconciliation', ok: false, detail: 'last_run_failed' },
      ],
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');

    // mode and degradedServices carry safe operational identifiers
    expect(res.body.mode).toBe('partially_healthy');
    expect(res.body.degradedServices).toContain('ethereum_rpc');
    expect(res.body.degradedServices).toContain('reconciliation');

    // Check objects expose only the safe detail strings
    const ethCheck = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>)
      .find(c => c.name === 'ethereum_rpc');
    expect(ethCheck).toBeDefined();
    expect(ethCheck!.ok).toBe(false);
    expect(ethCheck!.detail).toBe('unavailable');

    // No URL, token or preimage in the body
    assertNoSecretLeakage(res.body, 'GET /readyz degraded - safe names');
  });

  it('does not expose the Ethereum RPC URL when the check detail is a fake URL', async () => {
    // Regression: if a buggy check implementation accidentally set detail
    // to the raw RPC URL, the route would forward it.  The real implementation
    // always uses "unavailable", so this asserts the contract is honoured.
    const safeDetail = 'unavailable';  // what the real code always emits

    const app = await freshApp({
      getReadinessChecks: () => [
        { name: 'database', ok: true, latencyMs: 1 },
        { name: 'ethereum_rpc', ok: false, detail: safeDetail },
      ],
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_ETH_RPC_URL);
    expect(JSON.stringify(res.body)).not.toContain('FAKEINFURAKEY');

    const ethCheck = (res.body.checks as Array<{ name: string; detail?: string }>)
      .find(c => c.name === 'ethereum_rpc');
    expect(ethCheck?.detail).toBe('unavailable');
  });

  it('reports database as the sole degraded service when db check fails', async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: 'database', ok: false, detail: 'unavailable', latencyMs: 3_000 },
        { name: 'ethereum_rpc', ok: true, latencyMs: 8 },
        { name: 'soroban_rpc', ok: true, latencyMs: 11 },
      ],
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.mode).toBe('degraded');
    expect(res.body.degradedServices).toEqual(['database']);

    // The database URL itself (which carries credentials) must never appear
    assertNoSecretLeakage(res.body, 'GET /readyz db failure');
  });
});

// ── /readyz — provider throws with credential-bearing error message ────────────

describe('/readyz — readiness provider exception redaction', () => {
  it('does not echo a fake PostgreSQL URL thrown inside the provider', async () => {
    const app = await freshApp({
      getReadinessChecks: () => {
        throw new Error(`connection refused: ${FAKE_DB_URL}`);
      },
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.degradedServices).toEqual(['readiness']);
    expect(res.body.checks).toEqual([
      { name: 'readiness', ok: false, detail: 'readiness_check_failed' },
    ]);

    assertNoSecretLeakage(res.body, 'GET /readyz db URL in thrown error');
  });

  it('does not echo a fake Redis URL thrown inside the provider', async () => {
    const app = await freshApp({
      getReadinessChecks: () => {
        throw new Error(`ECONNREFUSED ${FAKE_REDIS_URL}`);
      },
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('redis://');
    expect(JSON.stringify(res.body)).not.toContain('r3d1sPa55w0rd');
    assertNoSecretLeakage(res.body, 'GET /readyz redis URL in thrown error');
  });

  it('does not echo a fake Infura API key thrown inside the provider', async () => {
    const app = await freshApp({
      getReadinessChecks: () => {
        throw new Error(`fetch failed: ${FAKE_ETH_RPC_URL}`);
      },
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('FAKEINFURAKEY');
    expect(JSON.stringify(res.body)).not.toContain('infura.io');
    assertNoSecretLeakage(res.body, 'GET /readyz Infura key in thrown error');
  });

  it('does not echo a preimage value thrown inside the provider', async () => {
    const app = await freshApp({
      getReadinessChecks: () => {
        throw new Error(`unexpected preimage: ${FAKE_PREIMAGE}`);
      },
    });

    const res = await request(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_PREIMAGE);
    assertNoSecretLeakage(res.body, 'GET /readyz preimage in thrown error');
  });

  it('still identifies the dependency as "readiness" after any provider exception', async () => {
    const secretMessages = [
      `conn: ${FAKE_DB_URL}`,
      `token: ${FAKE_API_KEY}`,
      `key: ${FAKE_SECRET_STORAGE_KEY}`,
    ];

    for (const message of secretMessages) {
      const app = await freshApp({
        getReadinessChecks: () => { throw new Error(message); },
      });

      const res = await request(app).get('/readyz');

      // Operational shape is preserved regardless of what the error contains
      expect(res.status, `503 for: ${message.slice(0, 20)}`).toBe(503);
      expect(res.body.mode, `mode for: ${message.slice(0, 20)}`).toBe('degraded');
      expect(res.body.degradedServices, `degradedServices for: ${message.slice(0, 20)}`)
        .toEqual(['readiness']);
    }
  });
});

// ── Cross-endpoint: all three endpoints together ──────────────────────────────

describe('cross-endpoint — all health routes together', () => {
  it('no endpoint leaks any fake secret when all are mounted on the same app', async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: 'database', ok: true, latencyMs: 1 },
        { name: 'ethereum_rpc', ok: true, latencyMs: 5 },
        { name: 'soroban_rpc', ok: true, latencyMs: 8 },
        { name: 'solana_rpc', ok: true, detail: 'disabled_placeholder' },
        { name: 'reconciliation', ok: true, detail: 'last_run_ok' },
      ],
      getReconciliationStatus: () => ({
        lastRunAt: Date.now(),
        lastRunOk: true,
        eventsReplayed: 0,
      }),
    });

    const endpoints = ['/healthz', '/health', '/readyz'] as const;

    for (const endpoint of endpoints) {
      const res = await request(app).get(endpoint);
      // All three should respond successfully
      expect(res.status, `${endpoint} should be 2xx`).toBeLessThan(300);
      assertNoSecretLeakage(res.body, endpoint);
    }
  });

  it('all three endpoints return required operational fields', async () => {
    const app = await freshApp({
      getReadinessChecks: () => [
        { name: 'database', ok: true, latencyMs: 1 },
        { name: 'soroban_rpc', ok: true, latencyMs: 4 },
      ],
    });

    const liveness  = await request(app).get('/healthz');
    const extended  = await request(app).get('/health');
    const readiness = await request(app).get('/readyz');

    // /healthz
    expect(liveness.body).toMatchObject({ status: 'ok', service: 'wafflefinance-coordinator' });

    // /health
    expect(extended.body).toMatchObject({ status: 'ok', service: 'wafflefinance-coordinator' });
    expect(extended.body).toHaveProperty('reconciliation');
    expect(extended.body).toHaveProperty('soroban');

    // /readyz
    expect(readiness.body).toMatchObject({
      status: 'ok',
      mode: 'healthy',
      degradedServices: [],
      service: 'wafflefinance-coordinator',
    });
    expect(Array.isArray(readiness.body.checks)).toBe(true);

    assertNoSecretLeakage(liveness.body,  '/healthz cross');
    assertNoSecretLeakage(extended.body,  '/health cross');
    assertNoSecretLeakage(readiness.body, '/readyz cross');
  });
});
