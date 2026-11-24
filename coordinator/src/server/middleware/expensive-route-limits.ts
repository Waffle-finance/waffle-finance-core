/**
 * Per-route rate limits for expensive quote and export endpoints (issue #1133).
 *
 * Quote calculation and lifecycle export cost far more than an ordinary
 * read, so they get their own policies instead of relying on generic read
 * limits. Each policy is deterministic and documented so route registration
 * changes cannot silently leave expensive work unbounded.
 */
import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Logger } from "pino";
import {
  makeRateLimiter,
  loadApiKeys,
  loadTrustedProxies,
  extractBearerToken,
} from "./ratelimit.js";

export interface ExpensiveRoutePolicy {
  /** Stable middleware/bucket name. */
  name: string;
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per IP in the window. */
  max: number;
  /** Route classification used in tests and operator docs. */
  usage: "anonymous" | "authenticated";
}

export const WINDOW_MS = 60_000;

/** Documented policies — the single source of truth for these routes. */
export const EXPENSIVE_ROUTE_POLICIES = {
  "quotes/anonymous": { name: "quotes/anonymous", windowMs: WINDOW_MS, max: 30, usage: "anonymous" },
  "quotes/authenticated": { name: "quotes/authenticated", windowMs: WINDOW_MS, max: 120, usage: "authenticated" },
  "export/anonymous": { name: "export/anonymous", windowMs: WINDOW_MS, max: 10, usage: "anonymous" },
  "export/authenticated": { name: "export/authenticated", windowMs: WINDOW_MS, max: 60, usage: "authenticated" },
} as const satisfies Record<string, ExpensiveRoutePolicy>;

export type ExpensiveRoute = keyof typeof EXPENSIVE_ROUTE_POLICIES;

export interface ExpensiveRouteLimitOptions {
  log?: Logger;
  apiKeys?: ReadonlySet<string>;
  trustedProxies?: ReadonlySet<string>;
}

/**
 * Build the middleware for one expensive route family.
 *
 * The configured API key set is the only identity allowed to bypass the
 * limit. Every bypass is audited with a hash of the key (never the key
 * itself) so operator use remains attributable and secret-free.
 */
export function makeExpensiveRouteLimiter(
  route: ExpensiveRoute,
  opts: ExpensiveRouteLimitOptions = {},
) {
  const policy = EXPENSIVE_ROUTE_POLICIES[route];
  const apiKeys = opts.apiKeys ?? loadApiKeys();
  const trustedProxies = opts.trustedProxies ?? loadTrustedProxies();
  const limiter = makeRateLimiter({
    windowMs: policy.windowMs,
    max: policy.max,
    name: policy.name,
    log: opts.log,
    apiKeys,
    trustedProxies,
  });

  return function expensiveRouteLimiter(req: Request, res: Response, next: NextFunction): void {
    const token = extractBearerToken(req);
    if (token && apiKeys.has(token)) {
      const keyHash = createHash("sha256").update(token).digest("hex").slice(0, 12);
      opts.log?.info(
        { route: policy.name, keyHash, decision: "bypass" },
        "expensive route rate-limit bypass by configured identity",
      );
    }
    limiter(req, res, next);
  };
}

/**
 * Apply the anonymous or authenticated policy for a route family based on
 * whether the caller presents a bearer credential.
 */
export function classifiedExpensiveRouteLimiter(
  family: "quotes" | "export",
  opts: ExpensiveRouteLimitOptions = {},
) {
  const anonymous = makeExpensiveRouteLimiter(`${family}/anonymous`, opts);
  const authenticated = makeExpensiveRouteLimiter(`${family}/authenticated`, opts);
  return function classifiedLimiter(req: Request, res: Response, next: NextFunction): void {
    if (extractBearerToken(req)) authenticated(req, res, next);
    else anonymous(req, res, next);
  };
}
