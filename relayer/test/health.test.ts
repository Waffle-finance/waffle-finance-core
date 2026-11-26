/**
 * Tests for the relayer /healthz, /readyz, and /health endpoints.
 *
 * Strategy: mount healthRouter on a standalone Express app so we never
 * have to boot the full relayer (which requires live env vars and real
 * network access).
 *
 * For /readyz tests we stub `global.fetch` to simulate RPC probe results
 * without making real network calls.  This keeps the suite fast, hermetic,
 * and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { healthRouter, validateProbeTimeout, type HealthStatus } from '../src/routes/health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(healthRouter());
  return app;
}

/** Create a fetch stub that always returns 200 OK with an empty JSON body. */
function stubFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '{}',
  } as unknown as Response);
}

/** Create a fetch stub that always rejects with a network error. */
function stubFetchError(message = 'connection refused') {
  return vi.fn().mockRejectedValue(new Error(message));
}

/** Create a fetch stub that always returns a non-OK HTTP status. */
function stubFetchHttpError(status = 503) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// /healthz — liveness
// ---------------------------------------------------------------------------

describe('GET /healthz — liveness', () => {
  it('always returns 200 regardless of dependency health', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes the correct service name', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/healthz');
    expect(res.body.service).toBe('wafflefinance-relayer');
  });

  it('includes uptime, version, and timestamp fields', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/healthz');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.version).toBe('string');
    expect(typeof res.body.timestamp).toBe('number');
  });

  it('does not include any checks array (liveness has no dependency probes)', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/healthz');
    expect(res.body.checks).toBeUndefined();
  });

  it('responds with JSON content-type', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/healthz');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ---------------------------------------------------------------------------
// /readyz — readiness
// ---------------------------------------------------------------------------

describe('GET /readyz — readiness with real RPC probes', () => {
  // Save and restore env vars around each test so they are fully isolated.
  let savedEthRpc: string | undefined;
  let savedHorizon: string | undefined;
  let savedSoroban: string | undefined;
  let savedSolanaProgram: string | undefined;
  let savedSolanaRpc: string | undefined;

  beforeEach(() => {
    savedEthRpc = process.env.ETHEREUM_RPC_URL;
    savedHorizon = process.env.STELLAR_HORIZON_URL;
    savedSoroban = process.env.SOROBAN_RPC_URL;
    savedSolanaProgram = process.env.SOLANA_HTLC_PROGRAM;
    savedSolanaRpc = process.env.SOLANA_RPC_URL;

    // Default: give eth + stellar real-looking URLs so the stubbed fetch
    // is exercised. Soroban and Solana default to placeholder/unset so
    // they short-circuit without hitting fetch.
    process.env.ETHEREUM_RPC_URL = 'https://eth.internal/rpc';
    process.env.STELLAR_HORIZON_URL = 'https://horizon.internal';
    delete process.env.SOROBAN_RPC_URL;
    process.env.SOLANA_HTLC_PROGRAM = 'PLACEHOLDER';
    delete process.env.SOLANA_RPC_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original values (undefined → delete the key)
    if (savedEthRpc === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = savedEthRpc;
    if (savedHorizon === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = savedHorizon;
    if (savedSoroban === undefined) delete process.env.SOROBAN_RPC_URL;
    else process.env.SOROBAN_RPC_URL = savedSoroban;
    if (savedSolanaProgram === undefined) delete process.env.SOLANA_HTLC_PROGRAM;
    else process.env.SOLANA_HTLC_PROGRAM = savedSolanaProgram;
    if (savedSolanaRpc === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = savedSolanaRpc;
  });

  it('returns 200 and status=ok when all configured probes succeed', async () => {
    vi.stubGlobal('fetch', stubFetchOk());

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    // With our default env setup (eth + stellar configured, both probes OK)
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes ethereum_rpc and stellar_rpc in the checks array', async () => {
    vi.stubGlobal('fetch', stubFetchOk());

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    const names = (res.body.checks as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('ethereum_rpc');
    expect(names).toContain('stellar_rpc');
  });

  it('includes solana_rpc as disabled_placeholder when SOLANA_HTLC_PROGRAM=PLACEHOLDER', async () => {
    vi.stubGlobal('fetch', stubFetchOk());

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    const solanaCheck = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === 'solana_rpc',
    );
    expect(solanaCheck).toBeDefined();
    expect(solanaCheck!.ok).toBe(true);
    expect(solanaCheck!.detail).toBe('disabled_placeholder');
  });

  it('includes soroban_rpc as disabled_placeholder when SOROBAN_RPC_URL is unset', async () => {
    vi.stubGlobal('fetch', stubFetchOk());

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    const sorobanCheck = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === 'soroban_rpc',
    );
    expect(sorobanCheck).toBeDefined();
    expect(sorobanCheck!.ok).toBe(true);
    expect(sorobanCheck!.detail).toBe('disabled_placeholder');
  });

  it('reports soroban_rpc as failing when the RPC probe returns non-OK', async () => {
    process.env.SOROBAN_RPC_URL = 'http://soroban.internal/rpc';
    // Stub: ethereum+stellar return ok, soroban returns 503.
    // We can't easily differentiate by URL in a single stub, so we accept
    // that all three configured probes will get the same 503 response. The
    // key assertion is that soroban_rpc.ok=false and detail contains 'http_503'.
    vi.stubGlobal('fetch', stubFetchHttpError(503));

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    const sorobanCheck = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === 'soroban_rpc',
    );
    expect(sorobanCheck).toBeDefined();
    expect(sorobanCheck!.ok).toBe(false);
    expect(sorobanCheck!.detail).toContain('http_503');
  });

  it('reports solana_rpc as failing when the RPC probe returns a connection error', async () => {
    // Override: set a real-looking Solana program and RPC URL.
    process.env.SOLANA_HTLC_PROGRAM = 'SomeRealProgramAddress1234567890ABCDEF1234567';
    process.env.SOLANA_RPC_URL = 'http://solana.internal/rpc';
    vi.stubGlobal('fetch', stubFetchError('ECONNREFUSED'));

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    const solanaCheck = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === 'solana_rpc',
    );
    expect(solanaCheck).toBeDefined();
    expect(solanaCheck!.ok).toBe(false);
    expect(solanaCheck!.detail).toBe('connection_error');
  });

  it('returns 503 and status=degraded when any configured probe fails', async () => {
    // Force ethereum_rpc probe to fail
    vi.stubGlobal('fetch', stubFetchError('ECONNREFUSED'));

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('check entries include a latencyMs field for real probes', async () => {
    vi.stubGlobal('fetch', stubFetchOk());

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    // Real probes (ethereum, stellar) should have latencyMs
    const ethCheck = (res.body.checks as Array<{ name: string; latencyMs?: number }>).find(
      (c) => c.name === 'ethereum_rpc',
    );
    // latencyMs may be 0 in fast test environments, but should be defined
    expect(typeof ethCheck?.latencyMs).toBe('number');
  });

  it('returns 503 with a fallback error check when the readiness logic itself throws', async () => {
    // Stub fetch to throw synchronously — probeJsonRpc catches this and
    // returns { ok: false, detail: 'connection_error' }, so /readyz returns
    // 503 with status=degraded (not the outer catch path, but still 503).
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      throw new Error('unexpected internal error');
    }));

    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks.length).toBeGreaterThan(0);
  });

  it('does not include sensitive fields in the response', async () => {
    vi.stubGlobal('fetch', stubFetchOk());

    const app = makeApp();
    const res = await supertest(app).get('/readyz');
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/private/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/RELAYER_/);
  });
});

// ---------------------------------------------------------------------------
// /health — detailed health status
// ---------------------------------------------------------------------------

describe('GET /health — basic contract', () => {
  it('returns 200 or 503 (depending on monitor state)', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect([200, 503]).toContain(res.status);
  });

  it('responds with JSON content-type', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('response body has required fields', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    const body = res.body as HealthStatus;

    expect(typeof body.status).toBe('string');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(typeof body.timestamp).toBe('number');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
    expect(Array.isArray(body.services)).toBe(true);
  });

  it('timestamp is within 5 seconds of now', async () => {
    const before = Date.now();
    const app = makeApp();
    const res = await supertest(app).get('/health');
    const after = Date.now();

    const ts = (res.body as HealthStatus).timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it('uptime is non-negative', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect((res.body as HealthStatus).uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when monitor reports unhealthy', async () => {
    const { getMonitor } = await import('../src/services/monitoring.js');
    vi.spyOn(getMonitor(), 'getSystemStatus').mockReturnValue('unhealthy');

    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');

    vi.restoreAllMocks();
  });

  it('returns 200 when monitor reports healthy', async () => {
    const { getMonitor } = await import('../src/services/monitoring.js');
    vi.spyOn(getMonitor(), 'getSystemStatus').mockReturnValue('healthy');

    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);

    vi.restoreAllMocks();
  });

  it('returns 200 when monitor reports degraded', async () => {
    const { getMonitor } = await import('../src/services/monitoring.js');
    vi.spyOn(getMonitor(), 'getSystemStatus').mockReturnValue('degraded');

    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);

    vi.restoreAllMocks();
  });

  it('returns 503 with error field when monitor throws', async () => {
    const { getMonitor } = await import('../src/services/monitoring.js');
    vi.spyOn(getMonitor(), 'getSystemStatus').mockImplementation(() => {
      throw new Error('monitor internal failure');
    });

    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(typeof res.body.error).toBe('string');

    vi.restoreAllMocks();
  });

  it('does not include private keys or secrets in the response', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/private/i);
    expect(body).not.toMatch(/secret/i);
  });

  it('service entries include name, status, and lastCheck fields', async () => {
    const { getMonitor } = await import('../src/services/monitoring.js');
    getMonitor().registerService('test-health-svc', async () => ({ status: 'healthy' }));

    const app = makeApp();
    const res = await supertest(app).get('/health');

    for (const svc of (res.body as HealthStatus).services) {
      expect(typeof svc.name).toBe('string');
      expect(typeof svc.status).toBe('string');
      expect(typeof svc.lastCheck).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// validateProbeTimeout — issue 588: nonpositive timeout guard
// ---------------------------------------------------------------------------

describe('validateProbeTimeout — timeout configuration guard', () => {
  it('throws RangeError for a zero timeout', () => {
    expect(() => validateProbeTimeout(0)).toThrow(RangeError);
  });

  it('throws RangeError for a negative timeout', () => {
    expect(() => validateProbeTimeout(-1)).toThrow(RangeError);
    expect(() => validateProbeTimeout(-9999)).toThrow(RangeError);
  });

  it('error message mentions the bad value for zero', () => {
    expect(() => validateProbeTimeout(0)).toThrow(/got 0/);
  });

  it('error message mentions the bad value for a negative number', () => {
    expect(() => validateProbeTimeout(-500)).toThrow(/got -500/);
  });

  it('returns the value unchanged for a valid positive timeout', () => {
    expect(validateProbeTimeout(1)).toBe(1);
    expect(validateProbeTimeout(5000)).toBe(5000);
    expect(validateProbeTimeout(30000)).toBe(30000);
  });

  it('accepts 1 ms as the minimum valid value', () => {
    expect(validateProbeTimeout(1)).toBe(1);
  });

  it('normal health response payloads are unchanged when timeout is valid', async () => {
    // This guards the acceptance criterion: valid config → same payload shape.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Response));

    const savedEth = process.env.ETHEREUM_RPC_URL;
    const savedHorizon = process.env.STELLAR_HORIZON_URL;
    process.env.ETHEREUM_RPC_URL = 'https://eth.internal/rpc';
    process.env.STELLAR_HORIZON_URL = 'https://horizon.internal';

    const app = express();
    app.use(healthRouter());
    const res = await supertest(app).get('/readyz');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.checks)).toBe(true);

    vi.restoreAllMocks();
    if (savedEth === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = savedEth;
    if (savedHorizon === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = savedHorizon;
  });
});

// ---------------------------------------------------------------------------
// Per-chain readiness dependency details (#1084)
// ---------------------------------------------------------------------------

describe('GET /readyz — per-chain dependency details (#1084)', () => {
  let savedEthRpc: string | undefined;
  let savedHorizon: string | undefined;

  beforeEach(() => {
    savedEthRpc = process.env.ETHEREUM_RPC_URL;
    savedHorizon = process.env.STELLAR_HORIZON_URL;
    process.env.ETHEREUM_RPC_URL = 'https://eth.internal/rpc';
    process.env.STELLAR_HORIZON_URL = 'https://horizon.internal';
    delete process.env.SOROBAN_RPC_URL;
    process.env.SOLANA_HTLC_PROGRAM = 'PLACEHOLDER';
    delete process.env.SOLANA_RPC_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEthRpc === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = savedEthRpc;
    if (savedHorizon === undefined) delete process.env.STELLAR_HORIZON_URL;
    else process.env.STELLAR_HORIZON_URL = savedHorizon;
  });

  /**
   * Build a fetch stub whose response depends on the URL and a mutable flag.
   * The ethereum probe POSTs to eth.internal; the stellar probe GETs
   * horizon.internal; everything else (coordinator) returns OK.
   */
  function makeUrlAwareFetch(ethFails: () => boolean) {
    return vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('eth.internal') && ethFails()) {
        throw new Error('ECONNREFUSED');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}',
      } as unknown as Response;
    });
  }

  it('identifies the failing dependency and reports the last successful probe time', async () => {
    let ethFails = false;
    vi.stubGlobal('fetch', makeUrlAwareFetch(() => ethFails));

    const app = makeApp();

    // First request: everything healthy — both chains record a success.
    const res1 = await supertest(app).get('/readyz');
    expect(res1.status).toBe(200);

    // Degrade ethereum only; stellar stays healthy.
    ethFails = true;
    const res2 = await supertest(app).get('/readyz');
    expect(res2.status).toBe(503);

    const ethCheck = (res2.body.checks as Array<Record<string, unknown>>).find((c) => c.name === 'ethereum_rpc');
    const stellarCheck = (res2.body.checks as Array<Record<string, unknown>>).find((c) => c.name === 'stellar_rpc');

    // The failing dependency is identifiable and carries a bounded failure reason.
    expect(ethCheck).toBeDefined();
    expect(ethCheck!.ok).toBe(false);
    expect(ethCheck!.lastFailureReason).toBe('connection_error');
    // It also reports when it was last healthy (probe age), not just "idle".
    expect(typeof ethCheck!.lastSuccessAt).toBe('number');
    expect(ethCheck!.lastSuccessAt).toBeGreaterThan(0);
    expect(typeof ethCheck!.lastSuccessAgeMs).toBe('number');
    expect(ethCheck!.consecutiveFailures).toBe(1);

    // The other chain remains healthy.
    expect(stellarCheck).toBeDefined();
    expect(stellarCheck!.ok).toBe(true);
    expect(stellarCheck!.consecutiveFailures).toBe(0);
    expect(stellarCheck!.lastFailureReason).toBeNull();
  });

  it('distinguishes rpc_connectivity from order_processing kind', async () => {
    vi.stubGlobal('fetch', makeUrlAwareFetch(() => false));
    const app = makeApp();
    const res = await supertest(app).get('/readyz');
    const checks = res.body.checks as Array<Record<string, unknown>>;
    const eth = checks.find((c) => c.name === 'ethereum_rpc');
    const stellar = checks.find((c) => c.name === 'stellar_rpc');
    const coordinator = checks.find((c) => c.name === 'coordinator');
    expect(eth!.kind).toBe('rpc_connectivity');
    expect(stellar!.kind).toBe('rpc_connectivity');
    expect(coordinator!.kind).toBe('order_processing');
  });

  it('reports probe age (lastSuccessAgeMs) for a healthy dependency', async () => {
    vi.stubGlobal('fetch', makeUrlAwareFetch(() => false));
    const app = makeApp();
    await supertest(app).get('/readyz');
    const res = await supertest(app).get('/readyz');
    const eth = (res.body.checks as Array<Record<string, unknown>>).find((c) => c.name === 'ethereum_rpc');
    expect(eth!.ok).toBe(true);
    expect(typeof eth!.lastSuccessAt).toBe('number');
    expect(typeof eth!.lastSuccessAgeMs).toBe('number');
    expect(eth!.lastSuccessAgeMs as number).toBeGreaterThanOrEqual(0);
  });

  it('does not disclose secrets in the failure reason or any field', async () => {
    let ethFails = true;
    vi.stubGlobal('fetch', makeUrlAwareFetch(() => ethFails));
    const app = makeApp();
    const res = await supertest(app).get('/readyz');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/private/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/RELAYER_/);
    // Failure reasons must be bounded categories, not raw payloads.
    const eth = (res.body.checks as Array<Record<string, unknown>>).find((c) => c.name === 'ethereum_rpc');
    expect(eth!.lastFailureReason).toBe('connection_error');
  });

  it('probes are read-only (no state-changing RPC calls are issued)', async () => {
    // The ethereum probe must use eth_blockNumber (a read), not a send. We
    // assert by checking the method the stub received is POST with a
    // read-only JSON-RPC method, and never eth_sendTransaction.
    const fetchMock = makeUrlAwareFetch(() => false);
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp();
    await supertest(app).get('/readyz');
    const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
    const ethCall = calls.find(([url]) => typeof url === 'string' && url.includes('eth.internal'));
    expect(ethCall).toBeDefined();
    const body = JSON.parse(ethCall![1]?.body as string);
    expect(body.method).toBe('eth_blockNumber');
    // No readiness probe should ever send a transaction.
    for (const [, opts] of calls) {
      if (!opts?.body) continue;
      const parsed = JSON.parse(opts.body as string);
      expect(parsed.method).not.toBe('eth_sendTransaction');
    }
  });

  it('keeps probe history across requests on the same router instance', async () => {
    let ethFails = false;
    vi.stubGlobal('fetch', makeUrlAwareFetch(() => ethFails));
    const app = makeApp();
    // Two healthy requests on the SAME app (one router) accumulate history.
    const res1 = await supertest(app).get('/readyz');
    const res2 = await supertest(app).get('/readyz');
    const eth1 = (res1.body.checks as Array<Record<string, unknown>>).find((c) => c.name === 'ethereum_rpc');
    const eth2 = (res2.body.checks as Array<Record<string, unknown>>).find((c) => c.name === 'ethereum_rpc');
    expect(eth1!.consecutiveFailures).toBe(0);
    expect(eth2!.consecutiveFailures).toBe(0);
    // Both report a last successful probe time (history is retained, not reset).
    expect(typeof eth1!.lastSuccessAt).toBe('number');
    expect(typeof eth2!.lastSuccessAt).toBe('number');
  });
});
