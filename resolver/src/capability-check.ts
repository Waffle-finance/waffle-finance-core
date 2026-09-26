/**
 * @file capability-check.ts
 *
 * Runtime capability guard that must pass before any resolver action is
 * attempted (claim, refund, register, etc.).
 *
 * ## Why this exists
 *
 * The support-policy contract (`@wafflefinance/config`) validates that the
 * *configuration* is sufficient to perform an action (correct RPC URL, HTLC
 * address, key material present).  But at startup the resolver may be racing
 * with:
 *   - the RPC endpoint becoming reachable,
 *   - the signing key being loaded from a secret store,
 *   - the chain-fallback policy suspending a degraded chain,
 *   - the registry-status monitor confirming on-chain standing.
 *
 * This module adds a runtime layer that checks all of the above *before each
 * action attempt*, not just once at startup.  A failed capability check is
 * logged with a clear, actionable reason so operators can diagnose without
 * reading raw stack traces.
 *
 * ## Usage
 *
 * ```ts
 * const checker = new CapabilityChecker({ policy, fallback, statusMonitor, log });
 *
 * // Before attempting a claim:
 * checker.assertCanAct("ethereum", "claim");
 *
 * // Or get a result without throwing:
 * const result = checker.check("stellar", "claim");
 * if (!result.ok) {
 *   log.warn({ reason: result.reason }, "skipping claim — capability check failed");
 *   return;
 * }
 * ```
 */

import { supportsAction, type SupportPolicy } from "@wafflefinance/config";
import type { Logger } from "pino";
import type { ChainFallbackPolicy } from "./chain-fallback.js";
import type { ResolverStatusMonitor } from "./registry-status.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The action being attempted — mirrors the support-policy action vocabulary. */
export type ResolverAction = "observe" | "claim" | "refund" | "register" | "unregister";

export interface CapabilityResult {
  ok: boolean;
  /** Machine-readable failure code, or null on success. */
  code: string | null;
  /** Human-readable explanation for logs and operators. */
  reason: string;
}

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown by `assertCanAct` when a capability check fails.
 *
 * `code` is a stable machine-readable identifier for alerting rules:
 *   - `policy_unsupported`  — static config is missing a required value.
 *   - `chain_suspended`     — the chain-fallback policy has suspended this chain.
 *   - `registry_not_ready`  — the resolver's on-chain registry status is
 *                             low_stake / slashed / unbonding / inactive.
 */
export class CapabilityError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

// ── Checker ───────────────────────────────────────────────────────────────────

export interface CapabilityCheckerOptions {
  /** Support policy derived from the loaded config. */
  policy: SupportPolicy;
  /**
   * Chain-fallback policy for suspension checks.  Optional — when absent
   * the suspension check is skipped.
   */
  fallback?: ChainFallbackPolicy;
  /**
   * Registry-status monitor for on-chain standing checks.  Optional — when
   * absent the standing check is skipped.
   */
  statusMonitor?: ResolverStatusMonitor;
  /** Logger for failed capability checks. */
  log?: Logger;
}

/**
 * Runtime capability checker.
 *
 * Checks three layers in order:
 *   1. Static support policy  — is this action configured at all?
 *   2. Chain-fallback policy  — is this chain currently suspended?
 *   3. Registry standing      — is this resolver in good on-chain standing?
 *
 * Layer 1 uses the canonical chain ids from the support policy (`"ethereum"`,
 * `"stellar"`, `"solana"`).  Layers 2 and 3 use the caller-supplied chain
 * key, which may be the policy id or a label (e.g. `"soroban"`).  Pass the
 * same chain string you use elsewhere in the resolver so the fallback and
 * registry checks are always consistent.
 */
export class CapabilityChecker {
  private readonly policy: SupportPolicy;
  private readonly fallback: ChainFallbackPolicy | undefined;
  private readonly statusMonitor: ResolverStatusMonitor | undefined;
  private readonly log: Logger | undefined;

  constructor(opts: CapabilityCheckerOptions) {
    this.policy = opts.policy;
    this.fallback = opts.fallback;
    this.statusMonitor = opts.statusMonitor;
    this.log = opts.log;
  }

  /**
   * Check whether the resolver can perform `action` on `chain`.
   *
   * Returns a `CapabilityResult` — use this form when you want to handle the
   * failure yourself (log and skip) rather than propagate an exception.
   *
   * @param policyChain  The canonical support-policy chain id: `"ethereum"`,
   *                     `"stellar"`, or `"solana"`.
   * @param action       The action to attempt.
   * @param runtimeChain The chain label used in fallback / registry checks.
   *                     Defaults to `policyChain`.  Pass `"soroban"` when
   *                     the policy chain is `"stellar"`.
   */
  check(
    policyChain: string,
    action: ResolverAction,
    runtimeChain?: string
  ): CapabilityResult {
    const chain = runtimeChain ?? policyChain;

    // ── Layer 1: static support policy ──────────────────────────────────────
    const policyResult = supportsAction(
      this.policy,
      policyChain as Parameters<typeof supportsAction>[1],
      action as Parameters<typeof supportsAction>[2]
    );
    if (!policyResult.supported) {
      return {
        ok: false,
        code: "policy_unsupported",
        reason: policyResult.reason ?? `action ${action} not supported on ${policyChain}`,
      };
    }

    // ── Layer 2: chain-fallback suspension check ─────────────────────────────
    if (this.fallback && !this.fallback.canAct(chain)) {
      return {
        ok: false,
        code: "chain_suspended",
        reason:
          `chain ${chain} is currently suspended due to persistent RPC failures. ` +
          `No actions will be issued until the chain recovers.`,
      };
    }

    // ── Layer 3: on-chain registry standing ─────────────────────────────────
    if (this.statusMonitor && !this.statusMonitor.isReady()) {
      // Only block if this chain specifically has a bad state.
      const chainState = this.statusMonitor.getState(
        chain as Parameters<typeof this.statusMonitor.getState>[0]
      );
      if (chainState && chainState !== "active" && chainState !== "unregistered") {
        return {
          ok: false,
          code: "registry_not_ready",
          reason:
            `resolver registry state on ${chain} is "${chainState}" — ` +
            `actions are suspended until the resolver is active and sufficiently staked.`,
        };
      }
    }

    return { ok: true, code: null, reason: "all capability checks passed" };
  }

  /**
   * Assert that the resolver can perform `action` on `chain`.
   *
   * Throws `CapabilityError` when any check fails.  Use this in code paths
   * where you want the error to propagate and be counted by the
   * command-runner's failure metrics.
   */
  assertCanAct(
    policyChain: string,
    action: ResolverAction,
    runtimeChain?: string
  ): void {
    const result = this.check(policyChain, action, runtimeChain);
    if (!result.ok) {
      this.log?.warn(
        { policyChain, runtimeChain: runtimeChain ?? policyChain, action, code: result.code },
        `capability check failed: ${result.reason}`
      );
      throw new CapabilityError(result.code!, result.reason);
    }
  }

  /**
   * Check all required capabilities for a resolver startup.
   *
   * Returns an array of failed checks (empty = all good).  Use this during
   * the `run` command's pre-flight phase to log all missing capabilities in
   * one shot rather than failing on the first one.
   */
  checkAll(
    requirements: Array<{
      policyChain: string;
      action: ResolverAction;
      runtimeChain?: string;
    }>
  ): CapabilityResult[] {
    return requirements
      .map((r) => this.check(r.policyChain, r.action, r.runtimeChain))
      .filter((r) => !r.ok);
  }
}

// ── Standalone helpers ────────────────────────────────────────────────────────

/**
 * Quick one-shot capability check that does not require a `CapabilityChecker`
 * instance.  Suitable for guard clauses in command handlers where the full
 * checker isn't threaded through.
 *
 * Only checks the static support policy — runtime layers (fallback, registry)
 * require a `CapabilityChecker` with those dependencies injected.
 */
export function assertPolicySupports(
  policy: SupportPolicy,
  policyChain: string,
  action: ResolverAction,
  log?: Logger
): void {
  const result = supportsAction(
    policy,
    policyChain as Parameters<typeof supportsAction>[1],
    action as Parameters<typeof supportsAction>[2]
  );
  if (!result.supported) {
    const reason = result.reason ?? `action ${action} not supported on ${policyChain}`;
    log?.warn({ policyChain, action }, `policy capability check failed: ${reason}`);
    throw new CapabilityError("policy_unsupported", reason);
  }
}
