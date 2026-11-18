/**
 * @file route-policy.ts
 *
 * Central route-policy guard for the coordinator.
 *
 * ## Why this file exists
 *
 * The coordinator's announcement validation previously checked that a
 * direction's declared src/dst chains were internally consistent (e.g.
 * `eth_to_xlm` must name `ethereum` as srcChain and `stellar` as dstChain).
 * That is a *format* check. It does not answer a different, equally important
 * question: **is this route actually supported end-to-end right now?**
 *
 * Without a policy boundary, the order pipeline silently accepts combinations
 * that can never settle:
 *   - Directions whose destination chain has no settlement code path (Solana
 *     placeholder status means no relayer or resolver can complete the leg).
 *   - Same-chain "bridges" that are structurally valid but semantically
 *     meaningless.
 *   - Unknown chain identifiers that pass Zod enum validation but have no
 *     operational meaning.
 *
 * This module provides a single `checkRoutePolicy` function that evaluates
 * every such constraint at the policy boundary and returns a typed
 * `RouteVerdict`. Both the Zod schema refinement (`announceSchema`) and any
 * future middleware layer call the same function so the policy is never
 * duplicated.
 *
 * ## The model
 *
 * A route is the combination of (direction, srcChain, dstChain). A verdict is
 * either `{ allowed: true }` or `{ allowed: false, code, reason, field? }`.
 * The `code` is a stable machine-readable identifier suitable for metrics and
 * operator tooling. The `reason` is a human-readable explanation that appears
 * verbatim in HTTP 400 responses and logs.
 *
 * ## Solana placeholder awareness
 *
 * Solana appears in the `Direction` enum (`eth_to_sol`, `sol_to_eth`) because
 * the contracts and SDK routes are declared, but no settlement path is
 * implemented yet. The policy explicitly blocks these directions at the
 * coordinator boundary rather than letting orders reach the observation or
 * reconciliation layers where they would silently stall.
 *
 * The same mechanism handles any future chain that is declared but not yet
 * operational: add it to `PLACEHOLDER_CHAINS` and it is automatically blocked
 * with a clear operator-facing message.
 */

import type { Chain, Direction } from "../persistence/orders-repo.js";

// ── Policy constants ──────────────────────────────────────────────────────────

/**
 * The src/dst chains each supported direction must use.
 *
 * This is the authoritative map inside the coordinator. It is structurally
 * identical to the SDK's `LIVE_DIRECTION_CHAINS`, but kept local so the
 * coordinator does not take a runtime dependency on the SDK at validation time.
 * Any divergence between the two is a bug that the schema-contract test will
 * catch.
 */
export const POLICY_DIRECTION_CHAINS: Readonly<
  Record<Direction, { src: Chain; dst: Chain }>
> = {
  eth_to_xlm: { src: "ethereum", dst: "stellar" },
  xlm_to_eth: { src: "stellar", dst: "ethereum" },
  eth_to_sol: { src: "ethereum", dst: "solana" },
  sol_to_eth: { src: "solana", dst: "ethereum" },
} as const;

/**
 * Chains that are declared in the type system but have no live settlement path.
 *
 * An order whose route touches one of these chains will be rejected at the
 * policy boundary rather than being accepted and then stalling in observation
 * or reconciliation. Each entry carries the reason string that surfaces in
 * HTTP responses and logs so operators understand why a request was blocked.
 *
 * Add a chain here whenever its direction is added to `Direction` before the
 * settlement infrastructure is ready. Remove it when the chain goes live.
 */
export const PLACEHOLDER_CHAINS: Readonly<
  Partial<Record<Chain, string>>
> = {} as const;

/**
 * Directions that should be refused even if their chain alignment is correct.
 *
 * Populated automatically from `PLACEHOLDER_CHAINS`: any direction whose
 * source or destination is a placeholder chain is unconditionally blocked.
 */
function buildBlockedDirections(): ReadonlyMap<Direction, string> {
  const blocked = new Map<Direction, string>();
  for (const [direction, { src, dst }] of Object.entries(POLICY_DIRECTION_CHAINS) as [
    Direction,
    { src: Chain; dst: Chain },
  ][]) {
    const srcReason = PLACEHOLDER_CHAINS[src];
    const dstReason = PLACEHOLDER_CHAINS[dst];
    if (srcReason || dstReason) {
      blocked.set(
        direction,
        srcReason ?? dstReason ?? "chain is not yet supported"
      );
    }
  }
  return blocked;
}

/** Directions blocked because one of their legs is a placeholder chain. */
export const BLOCKED_DIRECTIONS: ReadonlyMap<Direction, string> =
  buildBlockedDirections();

/** Directions that are fully live (not blocked by any placeholder). */
export const LIVE_DIRECTIONS: ReadonlyArray<Direction> = (
  Object.keys(POLICY_DIRECTION_CHAINS) as Direction[]
).filter((d) => !BLOCKED_DIRECTIONS.has(d));

// ── Verdict types ─────────────────────────────────────────────────────────────

/**
 * Why the policy rejected a route. Stable identifiers — safe to branch on,
 * log as metric labels, and surface in operator dashboards.
 *
 *   DIRECTION_UNSUPPORTED  — the direction slug is not in the policy table.
 *   DIRECTION_BLOCKED      — direction is declared but its chain is a placeholder.
 *   CHAIN_MISMATCH         — declared chains do not match what the direction requires.
 *   SAME_CHAIN_ROUTE       — source and destination are the same chain.
 *   ROUTE_LIFECYCLE_LOCKED — the route is known but locked by a lifecycle constraint.
 */
export type RouteDenialCode =
  | "DIRECTION_UNSUPPORTED"
  | "DIRECTION_BLOCKED"
  | "CHAIN_MISMATCH"
  | "SAME_CHAIN_ROUTE"
  | "ROUTE_LIFECYCLE_LOCKED";

/** A route refusal with a stable code, a human-readable reason, and an optional field path. */
export interface RouteDenial {
  allowed: false;
  code: RouteDenialCode;
  /** Human-readable explanation for HTTP responses, logs, and error messages. */
  reason: string;
  /**
   * The field path that is the primary subject of the denial.
   * Matches the Zod `ctx.addIssue` `path` convention so callers
   * can forward it directly into a ZodError issue.
   */
  field?: string;
}

/** A route acceptance — no fields beyond `allowed`. */
export interface RouteApproval {
  allowed: true;
  /** The canonical source chain resolved from the policy table. */
  srcChain: Chain;
  /** The canonical destination chain resolved from the policy table. */
  dstChain: Chain;
}

/** The result of a route-policy check. */
export type RouteVerdict = RouteApproval | RouteDenial;

// ── Helpers ───────────────────────────────────────────────────────────────────

function deny(
  code: RouteDenialCode,
  reason: string,
  field?: string
): RouteDenial {
  return { allowed: false, code, reason, field };
}

// ── Core policy check ─────────────────────────────────────────────────────────

/**
 * The input shape for a route-policy check.
 *
 * Accepts string literals rather than the narrower `Direction` / `Chain` types
 * so callers can pass raw request-body values before Zod parsing narrows them.
 */
export interface RoutePolicyInput {
  direction: string;
  srcChain: string;
  dstChain: string;
}

/**
 * Evaluate a route-policy check for a coordinator order announcement.
 *
 * Checks, in order:
 *  1. `direction` is a declared direction (in the policy table).
 *  2. `direction` is not blocked by a placeholder chain.
 *  3. `srcChain` and `dstChain` are not the same chain.
 *  4. `srcChain` matches the direction's required source chain.
 *  5. `dstChain` matches the direction's required destination chain.
 *
 * Returns a `RouteApproval` on success so the caller gets back the canonical
 * chain values without having to repeat the table lookup. Returns a
 * `RouteDenial` with a stable `code` and a human-readable `reason` on any
 * failure — the denial is always self-describing so operators can understand
 * why a request was blocked from logs or HTTP responses alone.
 *
 * This function is pure and has no side-effects. It is called inside the
 * `announceSchema` Zod refinement and can also be called from any other
 * validation boundary that needs to enforce the same policy.
 *
 * @example
 * ```ts
 * const verdict = checkRoutePolicy({ direction, srcChain, dstChain });
 * if (!verdict.allowed) {
 *   log.warn({ code: verdict.code, reason: verdict.reason }, "route blocked by policy");
 *   return res.status(400).json({ error: "route_policy_violation", ...verdict });
 * }
 * ```
 */
export function checkRoutePolicy(input: RoutePolicyInput): RouteVerdict {
  const { direction, srcChain, dstChain } = input;

  // ── 1. Direction must be declared ─────────────────────────────────────────
  const directionEntry = POLICY_DIRECTION_CHAINS[direction as Direction];
  if (!directionEntry) {
    const live = LIVE_DIRECTIONS.join(", ");
    return deny(
      "DIRECTION_UNSUPPORTED",
      `direction "${direction}" is not supported by the coordinator route policy ` +
        `(live directions: ${live})`,
      "direction"
    );
  }

  // ── 2. Direction must not be blocked (placeholder chain) ──────────────────
  const blockedReason = BLOCKED_DIRECTIONS.get(direction as Direction);
  if (blockedReason) {
    return deny(
      "DIRECTION_BLOCKED",
      `direction "${direction}" is blocked by route policy: ${blockedReason}`,
      "direction"
    );
  }

  // ── 3. Source and destination must differ ─────────────────────────────────
  if (srcChain === dstChain) {
    return deny(
      "SAME_CHAIN_ROUTE",
      `srcChain and dstChain are both "${srcChain}" — a cross-chain swap must ` +
        `move value between two different chains`,
      "dstChain"
    );
  }

  // ── 4. srcChain must match what this direction requires ───────────────────
  if (srcChain !== directionEntry.src) {
    return deny(
      "CHAIN_MISMATCH",
      `direction "${direction}" requires srcChain="${directionEntry.src}" ` +
        `but the request declares srcChain="${srcChain}" — ` +
        `the declared source chain is inconsistent with the route policy`,
      "srcChain"
    );
  }

  // ── 5. dstChain must match what this direction requires ───────────────────
  if (dstChain !== directionEntry.dst) {
    return deny(
      "CHAIN_MISMATCH",
      `direction "${direction}" requires dstChain="${directionEntry.dst}" ` +
        `but the request declares dstChain="${dstChain}" — ` +
        `the declared destination chain is inconsistent with the route policy`,
      "dstChain"
    );
  }

  // ── All checks passed ─────────────────────────────────────────────────────
  return {
    allowed: true,
    srcChain: directionEntry.src,
    dstChain: directionEntry.dst,
  };
}

// ── Convenience helpers ───────────────────────────────────────────────────────

/**
 * True when `direction` is live (declared and not blocked by a placeholder).
 * Use for simple boolean guards; prefer `checkRoutePolicy` where the denial
 * reason should be surfaced.
 */
export function isLiveDirection(direction: unknown): direction is Direction {
  return (
    typeof direction === "string" &&
    direction in POLICY_DIRECTION_CHAINS &&
    !BLOCKED_DIRECTIONS.has(direction as Direction)
  );
}

/**
 * List every direction that is currently live, paired with its canonical
 * chain mapping. Useful for `/support` endpoints and operator tooling.
 */
export function listLiveRoutes(): Array<{
  direction: Direction;
  srcChain: Chain;
  dstChain: Chain;
}> {
  return LIVE_DIRECTIONS.map((d) => ({
    direction: d,
    srcChain: POLICY_DIRECTION_CHAINS[d].src,
    dstChain: POLICY_DIRECTION_CHAINS[d].dst,
  }));
}

/**
 * List every direction that is currently blocked, paired with the denial
 * reason. Useful for operator dashboards and `/support` endpoints so
 * operators can see what the coordinator will refuse and why.
 */
export function listBlockedRoutes(): Array<{
  direction: Direction;
  srcChain: Chain;
  dstChain: Chain;
  reason: string;
}> {
  return (Object.keys(POLICY_DIRECTION_CHAINS) as Direction[])
    .filter((d) => BLOCKED_DIRECTIONS.has(d))
    .map((d) => ({
      direction: d,
      srcChain: POLICY_DIRECTION_CHAINS[d].src,
      dstChain: POLICY_DIRECTION_CHAINS[d].dst,
      reason: BLOCKED_DIRECTIONS.get(d)!,
    }));
}
