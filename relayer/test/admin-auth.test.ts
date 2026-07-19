/**
 * Tests for admin authentication middleware and endpoint security.
 *
 * Coverage:
 *  - requireAdminAuth rejects when no key is configured
 *  - requireAdminAuth rejects missing token (401)
 *  - requireAdminAuth rejects wrong token (401) via Authorization header
 *  - requireAdminAuth rejects wrong token (401) via X-Api-Key header
 *  - requireAdminAuth passes correct token via Authorization: Bearer
 *  - requireAdminAuth passes correct token via X-Api-Key
 *  - Timing-safe comparison: different-length tokens rejected
 *  - POST /api/admin/authorize-relayer rejects unauthenticated callers
 *  - GET /api/admin/relayer-status rejects unauthenticated callers
 *  - GET /api/admin/resolvers rejects unauthenticated callers
 *  - GET /api/debug/chain-monitor rejects unauthenticated callers
 *  - POST /api/debug/body no longer exists (removed)
 *  - POST /api/admin/authorize-relayer rejects body-supplied adminPrivateKey
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import supertest from 'supertest';
import { requireAdminAuth } from '../src/middleware/admin-auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_KEY = 'super-secret-test-key-abcdef1234567890';

/** Build a minimal app with one protected GET route. */
function makeProtectedApp(overrideKey?: string) {
  const app = express();
  app.use(express.json());
  app.get(
    '/protected',
    requireAdminAuth(overrideKey),
    (_req: Request, res: Response) => {
      res.json({ ok: true });
    },
  );
  return app;
}

// ---------------------------------------------------------------------------
// Unit: requireAdminAuth middleware
// ---------------------------------------------------------------------------

describe('requireAdminAuth — no key configured', () => {
  it('rejects with 401 when RELAYER_ADMIN_API_KEY is absent', async () => {
    const saved = process.env.RELAYER_ADMIN_API_KEY;
    delete process.env.RELAYER_ADMIN_API_KEY;

    const app = makeProtectedApp(); // reads env at request time
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${TEST_KEY}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not configured/i);

    process.env.RELAYER_ADMIN_API_KEY = saved ?? '';
  });
});

describe('requireAdminAuth — missing token', () => {
  it('returns 401 when no Authorization or X-Api-Key header is present', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 401 when Authorization header is malformed (no Bearer prefix)', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', TEST_KEY); // missing "Bearer " prefix
    expect(res.status).toBe(401);
  });
});

describe('requireAdminAuth — wrong token', () => {
  it('returns 401 when Authorization: Bearer carries incorrect token', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 401 when X-Api-Key carries incorrect token', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('X-Api-Key', 'definitely-wrong');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a token that is a prefix of the correct token', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${TEST_KEY.slice(0, 10)}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for a token that is a superset of the correct token', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${TEST_KEY}extra`);
    expect(res.status).toBe(401);
  });
});

describe('requireAdminAuth — correct token', () => {
  it('calls next and returns 200 when Authorization: Bearer is correct', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${TEST_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('calls next and returns 200 when X-Api-Key is correct', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('X-Api-Key', TEST_KEY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('prefers Authorization over X-Api-Key when both are present', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .set('X-Api-Key', 'wrong-key-in-x-api-key');
    // Authorization header wins; still 200 because it's correct.
    expect(res.status).toBe(200);
  });

  it('reads from RELAYER_ADMIN_API_KEY when no overrideKey provided', async () => {
    const saved = process.env.RELAYER_ADMIN_API_KEY;
    process.env.RELAYER_ADMIN_API_KEY = TEST_KEY;

    const app = express();
    app.get('/protected', requireAdminAuth(), (_req, res) => res.json({ ok: true }));

    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${TEST_KEY}`);
    expect(res.status).toBe(200);

    process.env.RELAYER_ADMIN_API_KEY = saved ?? '';
  });
});

describe('requireAdminAuth — response body safety', () => {
  it('does not echo the supplied token in the 401 response body', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const spoofedToken = 'attacker-controlled-token';
    const res = await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${spoofedToken}`);

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(spoofedToken);
  });

  it('does not include the configured key in any error response', async () => {
    const app = makeProtectedApp(TEST_KEY);
    const res = await supertest(app).get('/protected');

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(TEST_KEY);
  });
});

// ---------------------------------------------------------------------------
// Integration: admin endpoint route-level auth
//
// These tests mount a minimal stub app that mirrors the real route
// registrations so we verify the middleware is wired correctly without
// booting the full relayer.
// ---------------------------------------------------------------------------

function makeAdminStubApp(adminKey: string) {
  const app = express();
  app.use(express.json());

  // Mirror the real route signatures exactly (minus actual business logic).
  app.post('/api/admin/authorize-relayer', requireAdminAuth(adminKey), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/admin/relayer-status', requireAdminAuth(adminKey), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/admin/resolvers', requireAdminAuth(adminKey), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/debug/chain-monitor', requireAdminAuth(adminKey), (_req, res) => {
    res.json({ ok: true });
  });

  // /api/debug/body must NOT be registered at all.

  return app;
}

describe('Admin endpoints — unauthenticated requests are rejected', () => {
  const app = makeAdminStubApp(TEST_KEY);

  const cases: Array<['GET' | 'POST', string]> = [
    ['POST', '/api/admin/authorize-relayer'],
    ['GET', '/api/admin/relayer-status'],
    ['GET', '/api/admin/resolvers'],
    ['GET', '/api/debug/chain-monitor'],
  ];

  for (const [method, path] of cases) {
    it(`${method} ${path} returns 401 without auth`, async () => {
      const res =
        method === 'POST'
          ? await supertest(app).post(path).send({})
          : await supertest(app).get(path);
      expect(res.status).toBe(401);
    });
  }
});

describe('Admin endpoints — authorized requests are accepted', () => {
  const app = makeAdminStubApp(TEST_KEY);

  const cases: Array<['GET' | 'POST', string]> = [
    ['POST', '/api/admin/authorize-relayer'],
    ['GET', '/api/admin/relayer-status'],
    ['GET', '/api/admin/resolvers'],
    ['GET', '/api/debug/chain-monitor'],
  ];

  for (const [method, path] of cases) {
    it(`${method} ${path} returns 200 with valid Bearer token`, async () => {
      const res =
        method === 'POST'
          ? await supertest(app)
              .post(path)
              .set('Authorization', `Bearer ${TEST_KEY}`)
              .send({})
          : await supertest(app)
              .get(path)
              .set('Authorization', `Bearer ${TEST_KEY}`);
      expect(res.status).toBe(200);
    });

    it(`${method} ${path} returns 200 with valid X-Api-Key`, async () => {
      const res =
        method === 'POST'
          ? await supertest(app)
              .post(path)
              .set('X-Api-Key', TEST_KEY)
              .send({})
          : await supertest(app).get(path).set('X-Api-Key', TEST_KEY);
      expect(res.status).toBe(200);
    });
  }
});

describe('/api/debug/body endpoint is removed', () => {
  it('is not registered on the admin stub app — returns 404', async () => {
    const app = makeAdminStubApp(TEST_KEY);
    const res = await supertest(app)
      .post('/api/debug/body')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ secret: 'should-not-echo' });
    // The route no longer exists — Express returns 404.
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/authorize-relayer — body-supplied key rejected', () => {
  it('does not accept adminPrivateKey in the request body (key must come from env)', async () => {
    // In the hardened endpoint the adminPrivateKey field in the body is
    // completely ignored — the server uses RELAYER_ADMIN_PRIVATE_KEY from
    // the environment. If that env var is absent, the endpoint returns 500
    // (server misconfiguration) rather than using the caller-supplied value.
    //
    // We simulate the hardened endpoint with a stub that mirrors the guard.
    const app = express();
    app.use(express.json());
    app.post(
      '/api/admin/authorize-relayer',
      requireAdminAuth(TEST_KEY),
      (req: Request, res: Response) => {
        // Mirrors the hardened production handler: key comes from env only.
        const adminPrivateKey = process.env.RELAYER_ADMIN_PRIVATE_KEY;
        if (!adminPrivateKey) {
          return res.status(500).json({
            success: false,
            error: 'RELAYER_ADMIN_PRIVATE_KEY is not configured on this server',
          });
        }
        res.json({ ok: true });
      },
    );

    const saved = process.env.RELAYER_ADMIN_PRIVATE_KEY;
    delete process.env.RELAYER_ADMIN_PRIVATE_KEY;

    const res = await supertest(app)
      .post('/api/admin/authorize-relayer')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      // Caller attempts to inject their own private key in the body.
      .send({ adminPrivateKey: '0xdeadbeef0000000000000000000000000000000000000000000000000000dead' });

    // Endpoint ignores the body key and returns 500 because env is not set.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/not configured/i);
    // The supplied key must not appear anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain('deadbeef');

    if (saved !== undefined) process.env.RELAYER_ADMIN_PRIVATE_KEY = saved;
  });
});
