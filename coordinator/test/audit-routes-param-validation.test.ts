/**
 * Focused tests for the strict integer / positive-limit query-param
 * validation in `routes/audit.ts`. Uses stub repo/exporter objects so the
 * test exercises only the route-level parsing behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import pino from 'pino';
import { auditRoutes } from '../src/server/routes/audit.js';
import type { AuditRepository } from '../src/audit/audit-repo.js';
import type { AuditExporter } from '../src/audit/audit-exporter.js';

function buildApp() {
  const log = pino({ level: 'silent' });

  const repo = {
    query: vi.fn().mockResolvedValue({ entries: [], nextCursor: null, totalCount: 0 }),
    tail: vi.fn().mockResolvedValue([]),
  } as unknown as AuditRepository;

  const exporter = {
    orderTimeline: vi.fn(),
    validateOrderSequences: vi.fn(),
    exportNdjson: vi.fn(),
  } as unknown as AuditExporter;

  const app = express();
  app.use('/api', auditRoutes(repo, exporter, log));
  return { app, repo };
}

describe('GET /api/audit — limit query-param validation', () => {
  it('rejects a malformed limit like "12junk" with a bad_request response', async () => {
    const { app, repo } = buildApp();

    const res = await request(app).get('/api/audit').query({ limit: '12junk' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('accepts a valid limit and passes it through unchanged', async () => {
    const { app, repo } = buildApp();

    const res = await request(app).get('/api/audit').query({ limit: '42' });

    expect(res.status).toBe(200);
    expect(repo.query).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 42 }),
    );
  });

  it('rejects a zero limit', async () => {
    const { app, repo } = buildApp();

    const res = await request(app).get('/api/audit').query({ limit: '0' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('rejects a negative limit', async () => {
    const { app, repo } = buildApp();

    const res = await request(app).get('/api/audit').query({ limit: '-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('uses the default limit when omitted', async () => {
    const { app, repo } = buildApp();

    const res = await request(app).get('/api/audit');

    expect(res.status).toBe(200);
    expect(repo.query).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('rejects a malformed afterId', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/audit').query({ afterId: '5abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });
});
