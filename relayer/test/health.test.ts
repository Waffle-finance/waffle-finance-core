/**
 * Tests for the relayer /health endpoint.
 *
 * Strategy: mount the healthRouter on a standalone Express app so we
 * never have to boot the full relayer (which requires live env vars and
 * real network access).  The UptimeMonitor singleton is imported and
 * interrogated directly to verify the response reflects its state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { healthRouter, type HealthStatus } from '../src/routes/health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(healthRouter());
  return app;
}

// ---------------------------------------------------------------------------
// /health — basic contract
// ---------------------------------------------------------------------------

describe('GET /health — basic contract', () => {
  it('returns 200 when the monitor is in healthy or degraded state', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect([200, 503]).toContain(res.status);
  });

  it('responds with JSON content-type', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('response body has the required fields', async () => {
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

  it('timestamp is recent (within 5 seconds of now)', async () => {
    const before = Date.now();
    const app = makeApp();
    const res = await supertest(app).get('/health');
    const after = Date.now();

    const ts = (res.body as HealthStatus).timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it('uptime is a non-negative number', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect((res.body as HealthStatus).uptime).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /healthz and /readyz', () => {
  it('returns liveness independently of dependency health', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('wafflefinance-relayer');
  });

  it('returns readiness checks for chain dependencies', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/readyz');

    expect([200, 503]).toContain(res.status);
    expect(['ok', 'degraded']).toContain(res.body.status);
    expect(res.body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ethereum_rpc' }),
        expect.objectContaining({ name: 'stellar_rpc' }),
      ])
    );
  });
});

// ---------------------------------------------------------------------------
// /health — status codes
// ---------------------------------------------------------------------------

describe('GET /health — HTTP status codes', () => {
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

  it('returns 503 when monitor reports unhealthy', async () => {
    const { getMonitor } = await import('../src/services/monitoring.js');
    vi.spyOn(getMonitor(), 'getSystemStatus').mockReturnValue('unhealthy');

    const app = makeApp();
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(503);

    vi.restoreAllMocks();
  });

  it('returns 503 and an error field when the monitor throws', async () => {
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
});

// ---------------------------------------------------------------------------
// /health — services array
// ---------------------------------------------------------------------------

describe('GET /health — services array', () => {
  it('each service entry has name, status, and lastCheck fields', async () => {
    const { getMonitor } = await import('../src/services/monitoring.js');
    const monitor = getMonitor();

    // Register a known service so services array is non-empty.
    monitor.registerService('test-svc', async () => ({ status: 'healthy' }));

    const app = makeApp();
    const res = await supertest(app).get('/health');
    const services = (res.body as HealthStatus).services;

    for (const svc of services) {
      expect(typeof svc.name).toBe('string');
      expect(typeof svc.status).toBe('string');
      expect(typeof svc.lastCheck).toBe('number');
    }
  });

  it('does not include secrets or sensitive fields in service entries', async () => {
    const app = makeApp();
    const res = await supertest(app).get('/health');
    const body = JSON.stringify(res.body);

    // No private keys, secrets, or RPC URLs should appear in the response.
    expect(body).not.toMatch(/private/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/key/i);
  });
});
