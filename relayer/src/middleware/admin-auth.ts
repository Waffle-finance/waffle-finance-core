/**
 * Authentication middleware for admin and debug endpoints.
 *
 * Validates a bearer token or API key against the RELAYER_ADMIN_API_KEY
 * environment variable. Requests that omit or present an invalid token
 * receive a 401 response and never reach the route handler.
 *
 * Usage
 * -----
 * Single-route:
 *   app.get('/api/admin/foo', requireAdminAuth(), handler);
 *
 * Router-wide:
 *   const adminRouter = Router();
 *   adminRouter.use(requireAdminAuth());
 *
 * Token format
 * ------------
 * Clients must supply the token in one of two ways (checked in order):
 *   1. Authorization header:  `Authorization: Bearer <token>`
 *   2. X-Api-Key header:      `X-Api-Key: <token>`
 *
 * Configuration
 * -------------
 * Set RELAYER_ADMIN_API_KEY to a long, randomly-generated secret (≥ 32
 * printable ASCII characters recommended). If the variable is absent or
 * blank the middleware refuses ALL requests — the endpoint is effectively
 * disabled until a key is configured.
 *
 * Security notes
 * --------------
 * - Comparison uses a constant-time equality check to prevent timing
 *   attacks that could otherwise let an attacker enumerate the key
 *   character by character.
 * - The supplied token is never logged or included in error responses.
 * - Admin endpoints are intended for internal / operator use only; they
 *   should additionally be firewalled at the network layer in production.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Extract the bearer / API-key token from the request.
 *
 * Returns the raw token string, or `null` when no recognisable credential
 * is present.
 */
function extractToken(req: Request): string | null {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice('bearer '.length).trim();
    if (token.length > 0) return token;
  }

  // 2. X-Api-Key: <token>
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') {
    const token = apiKeyHeader.trim();
    if (token.length > 0) return token;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

/**
 * Compare two strings in constant time to prevent timing-based token
 * enumeration. Returns `true` only when both strings are identical.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  // Encode both strings to UTF-8 buffers for byte-level comparison.
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    // Different lengths — still run a fixed-cost comparison against a
    // zero-filled buffer of the same length as `a` to consume constant
    // time and avoid length-oracle attacks, then return false.
    const dummy = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, dummy);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware function that authenticates the caller.
 *
 * @param overrideKey - Optional key override (useful in tests). When
 *   omitted the middleware reads `process.env.RELAYER_ADMIN_API_KEY`
 *   at request time so the value can be set after module load.
 */
export function requireAdminAuth(overrideKey?: string): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const configuredKey = overrideKey ?? process.env.RELAYER_ADMIN_API_KEY ?? '';

    if (configuredKey.length === 0) {
      // No key configured — lock the endpoint until one is provided.
      res.status(401).json({
        error: 'Admin API key not configured. Set RELAYER_ADMIN_API_KEY.',
      });
      return;
    }

    const suppliedToken = extractToken(req);

    if (suppliedToken === null || !timingSafeStringEqual(suppliedToken, configuredKey)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
