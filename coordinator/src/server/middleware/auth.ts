import type { Request, Response, NextFunction } from "express";
import type { Logger } from "pino";
import { resolveClientIp } from "./ratelimit.js";

export type Role = "operator";

export interface AuthOptions {
  operatorKeys?: ReadonlySet<string>;
  log?: Logger;
  trustedProxies?: ReadonlySet<string>;
}

/**
 * Load the set of valid operator keys from the COORDINATOR_OPERATOR_KEYS env variable.
 * Returns an empty set when the variable is absent or blank.
 */
export function loadOperatorKeys(): ReadonlySet<string> {
  const raw = process.env.COORDINATOR_OPERATOR_KEYS ?? "";
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return new Set(keys);
}

/**
 * Extract a bearer token from `Authorization: Bearer <token>`.
 * Returns `null` when the header is absent or malformed.
 */
function extractBearerToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Express middleware factory to require a specific operational role.
 */
export function requireRole(role: Role, opts: AuthOptions) {
  return function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const token = extractBearerToken(req);
    const ip = resolveClientIp(req, opts.trustedProxies);
    const route = req.originalUrl || req.url;

    if (!token) {
      if (opts.log) {
        opts.log.warn(
          { ip, route, error: "unauthorized" },
          `[auth] Missing or malformed authorization header on ${route} from ${ip}`
        );
      }
      res.status(401).json({
        error: "unauthorized",
        message: "Missing or malformed authorization header"
      });
      return;
    }

    const keys = opts.operatorKeys ?? new Set<string>();
    if (!keys.has(token)) {
      if (opts.log) {
        opts.log.warn(
          { ip, route, error: "forbidden" },
          `[auth] Invalid operator key on ${route} from ${ip}`
        );
      }
      res.status(403).json({
        error: "forbidden",
        message: "Insufficient permissions or invalid operator key"
      });
      return;
    }

    next();
  };
}
