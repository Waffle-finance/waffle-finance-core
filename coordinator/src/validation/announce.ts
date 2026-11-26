import { z } from "zod";
import type { Chain, Direction } from "../persistence/orders-repo.js";
import { validateChainAddress } from "./address.js";
import {
  checkRoutePolicy,
  POLICY_DIRECTION_CHAINS,
  type RouteDenialCode,
} from "./route-policy.js";

/**
 * Centralised validation for order announcements.
 *
 * The schema validates BOTH field shapes and cross-field relationships
 * (direction <-> chains, address format <-> chain, and the full route-policy
 * contract) so that malformed or policy-violating payloads are rejected at
 * parse time with a structured ZodError rather than reaching the service layer.
 *
 * Validation layers, in order:
 *
 *  1. Field shape — Zod primitives on `announceShape` (enum, regex, min).
 *  2. Route-policy guard — `checkRoutePolicy()` from `./route-policy.ts`
 *     checks direction support, placeholder-chain blocking, same-chain routes,
 *     and direction/chain alignment in one authoritative call. Issues a
 *     structured ZodError with a machine-readable `routePolicyCode` extension
 *     so callers can distinguish policy denials from format errors.
 *  3. Address format — per-chain address validation via `./address.ts`.
 *     Only runs when the policy has already approved the route (no point
 *     validating address formats for a chain that can never be used).
 *
 * Chain-address rules live in ./address.ts so they stay consistent with the
 * history endpoint and any future address-aware routes.
 *
 * The `DIRECTION_CHAINS` export is kept for backward compatibility with
 * existing importers (SDK validation mirror, tests) — it now delegates to
 * the canonical `POLICY_DIRECTION_CHAINS` table so there is one source of
 * truth.
 */

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Maximum field lengths for announce payloads.
 *
 * These caps sit well above any real-world value so legitimate orders pass
 * unconditionally, while pathological inputs (multi-MB strings, padding
 * attacks) are caught at the schema layer before reaching persistence or logs.
 *
 * exported so boundary tests can reference the same constants.
 */
export const ANNOUNCE_FIELD_LIMITS = {
  /** direction enum values are short; 20 chars is more than enough. */
  direction: 20,
  /** hashlock is exactly 66 chars (0x + 64 hex); allow 66. */
  hashlock: 66,
  /** chain enum values top out at "ethereum" (8 chars). */
  chain: 20,
  /** Longest realistic address: Stellar G + 55 = 56 chars. 100 chars budget. */
  address: 100,
  /** Asset identifiers: "native" or a Stellar asset code like USDC:G... */
  asset: 200,
  /** Decimal integer strings: 78 chars covers uint256 max (2^256-1). */
  amount: 78,
} as const;

/**
 * The src/dst chains each supported swap direction must use.
 *
 * @deprecated Use `POLICY_DIRECTION_CHAINS` from `./route-policy.ts` directly.
 *   This re-export is kept for backward compatibility with existing importers.
 *   Both maps point to the same data.
 */
export const DIRECTION_CHAINS: Record<Direction, { src: Chain; dst: Chain }> =
  POLICY_DIRECTION_CHAINS;

const announceShape = z.object({
  direction: z.enum(["eth_to_xlm", "xlm_to_eth", "eth_to_sol", "sol_to_eth"]).refine(
    (v) => v.length <= ANNOUNCE_FIELD_LIMITS.direction,
    { message: `direction must be at most ${ANNOUNCE_FIELD_LIMITS.direction} characters` }
  ),
  hashlock: z.string()
    .max(ANNOUNCE_FIELD_LIMITS.hashlock, `hashlock must be at most ${ANNOUNCE_FIELD_LIMITS.hashlock} characters`)
    .regex(HEX32, "hashlock must be 0x + 64 hex chars"),
  srcChain: z.enum(["ethereum", "stellar", "solana"]),
  srcAddress: z.string()
    .min(1, "srcAddress is required")
    .max(ANNOUNCE_FIELD_LIMITS.address, `srcAddress must be at most ${ANNOUNCE_FIELD_LIMITS.address} characters`),
  srcAsset: z.string()
    .min(1, "srcAsset is required")
    .max(ANNOUNCE_FIELD_LIMITS.asset, `srcAsset must be at most ${ANNOUNCE_FIELD_LIMITS.asset} characters`),
  srcAmount: z.string()
    .max(ANNOUNCE_FIELD_LIMITS.amount, `srcAmount must be at most ${ANNOUNCE_FIELD_LIMITS.amount} digits`)
    .regex(/^\d+$/, "srcAmount must be a decimal integer string"),
  srcSafetyDeposit: z.string()
    .max(ANNOUNCE_FIELD_LIMITS.amount, `srcSafetyDeposit must be at most ${ANNOUNCE_FIELD_LIMITS.amount} digits`)
    .regex(/^\d+$/, "srcSafetyDeposit must be a decimal integer string"),
  dstChain: z.enum(["ethereum", "stellar", "solana"]),
  dstAddress: z.string()
    .min(1, "dstAddress is required")
    .max(ANNOUNCE_FIELD_LIMITS.address, `dstAddress must be at most ${ANNOUNCE_FIELD_LIMITS.address} characters`),
  dstAsset: z.string()
    .min(1, "dstAsset is required")
    .max(ANNOUNCE_FIELD_LIMITS.asset, `dstAsset must be at most ${ANNOUNCE_FIELD_LIMITS.asset} characters`),
  dstAmount: z.string()
    .max(ANNOUNCE_FIELD_LIMITS.amount, `dstAmount must be at most ${ANNOUNCE_FIELD_LIMITS.amount} digits`)
    .regex(/^\d+$/, "dstAmount must be a decimal integer string")
});

/**
 * Map a route-policy denial code to the Zod path that best describes the
 * offending field. Used so the ZodError issues that surface in HTTP 400
 * responses point to a specific field, not just to the schema root.
 */
function denialCodeToField(code: RouteDenialCode, field?: string): string {
  if (field) return field;
  switch (code) {
    case "DIRECTION_UNSUPPORTED":
    case "DIRECTION_BLOCKED":
      return "direction";
    case "SAME_CHAIN_ROUTE":
      return "dstChain";
    case "CHAIN_MISMATCH":
      return "srcChain";
    case "ROUTE_LIFECYCLE_LOCKED":
      return "direction";
    default:
      return "direction";
  }
}

export const announceSchema = announceShape.superRefine((input, ctx) => {
  // ── Layer 2: Route-policy guard ────────────────────────────────────────────
  //
  // `checkRoutePolicy` is the single authoritative source of truth for which
  // route combinations the coordinator will accept. It checks:
  //   - direction is declared in the policy
  //   - direction is not blocked (e.g. Solana placeholder)
  //   - srcChain ≠ dstChain
  //   - srcChain and dstChain match what the direction requires
  //
  // On a denial we emit ONE structured issue carrying the policy code in the
  // `params` extension so callers can distinguish policy rejections from
  // format errors without parsing the message string. We then return
  // immediately with ABORT_EARLY so we don't emit redundant downstream
  // issues for fields that are only invalid *because* the direction is wrong.
  const verdict = checkRoutePolicy({
    direction: input.direction,
    srcChain: input.srcChain,
    dstChain: input.dstChain,
  });

  if (!verdict.allowed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [denialCodeToField(verdict.code, verdict.field)],
      message: verdict.reason,
      params: { routePolicyCode: verdict.code },
    });
    // Stop here — address-format checks are meaningless when the route itself
    // is not allowed. Returning after the first policy denial also keeps the
    // error response focused: one clear denial is more actionable than a list
    // of cascading address errors for chains that can never be used.
    return z.NEVER;
  }

  // ── Layer 3: Address format ────────────────────────────────────────────────
  //
  // The policy approved the route, so we know the chain values are canonical.
  // Validate both addresses against their respective chain rules.
  const srcErr = validateChainAddress(input.srcChain, input.srcAddress);
  if (srcErr) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["srcAddress"], message: srcErr });
  }
  const dstErr = validateChainAddress(input.dstChain, input.dstAddress);
  if (dstErr) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dstAddress"], message: dstErr });
  }
});

export type AnnounceInput = z.infer<typeof announceSchema>;
