/**
 * @file order-eligibility.ts
 *
 * Registry-eligibility policy for order work (issue #1097).
 *
 * The resolver's standing in each chain's ResolverRegistry (see
 * `registry-status.ts`) decides whether it may take NEW work.  Duties for
 * orders it has ALREADY accepted are a different matter: walking away from an
 * accepted order is what loses user funds, so those keep running.
 *
 * Policy (also documented in docs/operational-policy.md):
 *
 *   | Registry view of this chain         | New order | In-flight claim | Refund |
 *   |-------------------------------------|-----------|-----------------|--------|
 *   | not configured (probe returns null) | accept    | allow           | allow  |
 *   | active, fresh, last probe succeeded | accept    | allow           | allow  |
 *   | inactive / low_stake / slashed /    | refuse    | allow           | allow  |
 *   |   unbonding / unregistered          |           |                 |        |
 *   | never read / last probe failed      | refuse    | allow           | allow  |
 *   | cached value older than staleAfter  | refuse    | allow           | allow  |
 *
 *   - "New order" is any order this resolver has not accepted yet.  A claim
 *     for an order that was never accepted here counts as new work and is
 *     gated the same way: when the registry is unavailable the resolver cannot
 *     prove it may complete it, so it does not start.
 *   - Refunds are always allowed for accepted orders: they only return funds
 *     and remain safe whatever the resolver's standing.
 *   - Fail closed: any doubt about eligibility (unknown, stale, probe error)
 *     refuses new work.  It never cancels work already accepted.
 */

import type { Logger } from "pino";
import { orderEligibilityDecisionsTotal } from "./metrics.js";
import type { RegistryChain, ResolverLifecycleState } from "./registry-status.js";

/** The subset of `ResolverStatusMonitor` the gate relies on (eases testing). */
export interface RegistryStatusSource {
  getState(chain: RegistryChain): ResolverLifecycleState | undefined;
  isStale(chain: RegistryChain, now?: number): boolean;
  isTracked(chain: RegistryChain): boolean | undefined;
  lastProbeFailed(chain: RegistryChain): boolean;
}

export type IneligibleReason =
  | "registry_unavailable"
  | "registry_stale"
  | "not_active"
  | "not_accepted";

export type Eligibility =
  | { eligible: true; basis: "registry_active" | "registry_not_configured" | "in_flight" }
  | { eligible: false; reason: IneligibleReason; state?: ResolverLifecycleState };

export type RecoveryAction = "claim" | "refund";

export interface OrderEligibilityGateOptions {
  monitor: RegistryStatusSource;
  log: Logger;
  now?: () => number;
}

/** Map a listener chain label onto a registry chain, or null if no registry exists for it. */
export function toRegistryChain(chain: string): RegistryChain | null {
  if (chain === "ethereum") return "ethereum";
  if (chain === "soroban" || chain === "stellar") return "soroban";
  return null;
}

export class OrderEligibilityGate {
  private readonly monitor: RegistryStatusSource;
  private readonly log: Logger;
  private readonly now: () => number;
  /** `${chain}:${orderId}` for every order this resolver accepted and has not settled. */
  private readonly accepted = new Set<string>();

  constructor(opts: OrderEligibilityGateOptions) {
    this.monitor = opts.monitor;
    this.log = opts.log.child({ component: "OrderEligibilityGate" });
    this.now = opts.now ?? Date.now;
  }

  /** Whether the resolver may take new work on `chain` right now. */
  checkNewWork(chain: string): Eligibility {
    const rc = toRegistryChain(chain);
    if (rc === null) return { eligible: true, basis: "registry_not_configured" };

    const tracked = this.monitor.isTracked(rc);
    if (tracked === false) return { eligible: true, basis: "registry_not_configured" };
    if (tracked === undefined || this.monitor.lastProbeFailed(rc)) {
      return { eligible: false, reason: "registry_unavailable", state: this.monitor.getState(rc) };
    }
    const state = this.monitor.getState(rc);
    if (state === undefined) return { eligible: false, reason: "registry_unavailable" };
    if (this.monitor.isStale(rc, this.now())) return { eligible: false, reason: "registry_stale", state };
    if (state !== "active") return { eligible: false, reason: "not_active", state };
    return { eligible: true, basis: "registry_active" };
  }

  /**
   * Try to accept a new order.  Records it as in-flight when eligible so later
   * settlement duties keep running even if eligibility is lost.
   */
  accept(chain: string, orderId: string): Eligibility {
    const key = `${chain}:${orderId}`;
    if (this.accepted.has(key)) return this.record(chain, "accept", orderId, { eligible: true, basis: "in_flight" });
    const decision = this.checkNewWork(chain);
    if (decision.eligible) this.accepted.add(key);
    return this.record(chain, "accept", orderId, decision);
  }

  /**
   * Whether a settlement duty may run.  Accepted orders always may; an order
   * this resolver never accepted is new work and goes through `checkNewWork`
   * (claims) or is refused (refunds — nothing of ours to return).
   */
  checkRecovery(chain: string, orderId: string, action: RecoveryAction): Eligibility {
    if (this.accepted.has(`${chain}:${orderId}`)) {
      return this.record(chain, action, orderId, { eligible: true, basis: "in_flight" });
    }
    if (action === "refund") {
      return this.record(chain, action, orderId, { eligible: false, reason: "not_accepted" });
    }
    return this.record(chain, action, orderId, this.checkNewWork(chain));
  }

  /** Mark an order settled; it no longer carries recovery duties. */
  complete(chain: string, orderId: string): void {
    this.accepted.delete(`${chain}:${orderId}`);
  }

  isInFlight(chain: string, orderId: string): boolean {
    return this.accepted.has(`${chain}:${orderId}`);
  }

  inFlightCount(): number {
    return this.accepted.size;
  }

  private record(chain: string, action: string, orderId: string, d: Eligibility): Eligibility {
    orderEligibilityDecisionsTotal.inc({ chain, action, result: d.eligible ? "accepted" : d.reason });
    if (!d.eligible && d.reason !== "not_accepted") {
      this.log.warn(
        { chain, action, orderId, reason: d.reason, registryState: d.state ?? "unknown" },
        "resolver not eligible for new work — skipping order"
      );
    }
    return d;
  }
}
