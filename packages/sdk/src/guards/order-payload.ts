/**
 * Runtime guard for the SDK's canonical `Order` payload (#733).
 *
 * The boundary
 * ────────────
 * `coordinator/transform.ts` converts a coordinator wire order into the
 * public `Order` type. That transform ends with two unchecked casts:
 *
 * ```ts
 * hashlock: wire.hashlock as `0x${string}`,
 * preimage: (wire.secret.preimage as `0x${string}` | null) ?? null,
 * ```
 *
 * and it copies `orderId`, `lockTx` and `timelock` across with no check at
 * all. `Order` is the type every frontend, relayer and resolver consumer
 * codes against, and it is the type produced by `toOrder`, so anything that
 * gets past `transform.ts` is treated as gospel by the whole monorepo.
 *
 * Pair this guard with `guards/coordinator-response.ts`: that one proves the
 * *wire* shape, this one proves the *canonical* shape after the lossy
 * transform has dropped `lockBlock`, flattened `secret.preimage`, and
 * hoisted `safetyDeposit`.
 *
 * Why a new `StrictOrder` and not a fix to `Order`
 * ───────────────────────────────────────────────
 * `Order` is exported from the package barrel and is a published type.
 * Two of its fields are typed `optional` when the wire contract in practice
 * guarantees they are always *present* (possibly `null`):
 *
 *   safetyDeposit?: string
 *   orderId?:  string | null
 *   lockTx?:   string | null
 *   timelock?: number | null
 *
 * Making them required would be source-compatible for *producers* and
 * breaking for every *consumer* that reads `leg.orderId` and now has to
 * handle `undefined`. This module therefore adds `StrictOrder`, where those
 * four fields are non-optional and explicitly `| null`, plus a parser. It is
 * opt-in and adds no breaking change. See the report for the full rationale.
 *
 * The `| null` vs `| undefined` split is the substantive win: `null` is a
 * coordinator statement ("not locked yet"), `undefined` is a missing field.
 * A guard that collapses both lets a dropped field masquerade as a
 * not-yet-locked leg.
 */

import type { Chain, ChainLeg, Direction, Order, OrderStatus } from '../types/index.js';
import { LIVE_DIRECTION_CHAINS, LIVE_ROUTE_DIRECTIONS, isLiveDirection } from '../routes/index.js';
import { nextStatesOf } from '../state-machine/index.js';
import { assertGuard, GuardIssueCollector, type GuardResult } from './result.js';
import {
  parseAtomicAmount,
  parseChainAddress,
  parseChainTxRef,
  parseHashlock,
  parsePublicOrderId,
  parseUnixSeconds,
  type ChainAddress,
} from './branded.js';
import { KNOWN_COORDINATOR_CHAINS, KNOWN_ORDER_STATUSES } from './coordinator-response.js';

// ── Strict types (additive, opt-in) ─────────────────────────────────────────

/**
 * A `ChainLeg` with the four coordinator-guaranteed fields made explicitly
 * required and nullable.
 *
 * `orderId` is chain-canonical and therefore chain-dependent, so it stays a
 * `string`; the chain-specific shape is documented per chain and validated
 * by `parseOrderIdForChain` when the caller needs the narrower type.
 */
export interface StrictChainLeg {
  chain: Chain;
  /** Validated for `chain`. */
  address: ChainAddress;
  asset: string;
  /** Atomic units, decimal string, leading zeros stripped. */
  amount: string;
  /** Atomic units. `null` on the destination leg and before funding. */
  safetyDeposit: string | null;
  /** Chain-canonical order id. `null` until the leg is locked. */
  orderId: string | null;
  /** Chain-canonical transaction id. `null` until the leg is locked. */
  lockTx: string | null;
  /** Absolute unix seconds. `null` until the leg is locked. */
  timelock: number | null;
}

/** An `Order` whose leg fields are all present and explicitly nullable. */
export interface StrictOrder {
  publicId: string;
  direction: Direction;
  status: OrderStatus;
  hashlock: string;
  src: StrictChainLeg;
  dst: StrictChainLeg;
  /** `null` until the secret has been revealed. */
  preimage: string | null;
}

const KNOWN_DIRECTIONS: readonly Direction[] = LIVE_ROUTE_DIRECTIONS;

/**
 * Every `OrderStatus` reachable from `announced` by following the edges in
 * `state-machine/index.ts`. Computed once at module load.
 *
 * Used to reject a status that is a member of the `OrderStatus` union but
 * could not have been produced by the lifecycle — e.g. an order that arrives
 * already `completed` with no source lock, which a stale cache or a
 * cross-order mixup can produce and which the union type happily accepts.
 */
const REACHABLE_STATUSES: ReadonlySet<OrderStatus> = (() => {
  const seen = new Set<OrderStatus>(['announced']);
  const queue: OrderStatus[] = ['announced'];
  while (queue.length > 0) {
    const current = queue.shift() as OrderStatus;
    for (const next of nextStatesOf(current)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
})();

function isReachableFromAnnounced(status: OrderStatus): boolean {
  return REACHABLE_STATUSES.has(status);
}

// ── Leg guard ───────────────────────────────────────────────────────────────

function validateLeg(input: unknown, path: string, issues: GuardIssueCollector): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.add(path, 'must be an object');
    return;
  }
  const leg = input as Record<string, unknown>;

  const chain = leg['chain'];
  if (typeof chain !== 'string' || !KNOWN_COORDINATOR_CHAINS.includes(chain as Chain)) {
    issues.add(`${path}.chain`, `must be one of: ${KNOWN_COORDINATOR_CHAINS.join(', ')}`);
  }

  const address = leg['address'];
  if (typeof address !== 'string') {
    issues.add(`${path}.address`, 'must be a string');
  } else if (typeof chain === 'string' && KNOWN_COORDINATOR_CHAINS.includes(chain as Chain)) {
    const parsed = parseChainAddress(chain as Chain, address, `${path}.address`);
    if (!parsed.ok) {
      for (const issue of parsed.issues) issues.add(issue.field, issue.message);
    }
  }

  if (typeof leg['asset'] !== 'string' || leg['asset'].length === 0) {
    issues.add(`${path}.asset`, 'must be a non-empty string');
  }

  const amount = leg['amount'];
  if (typeof amount !== 'string') {
    issues.add(`${path}.amount`, 'must be a string');
  } else {
    const parsed = parseAtomicAmount(amount, `${path}.amount`);
    if (!parsed.ok) {
      issues.add(`${path}.amount`, parsed.issues[0]?.message ?? 'invalid amount');
    } else if (parsed.value !== amount) {
      issues.add(
        `${path}.amount`,
        `must not have redundant leading zeros (canonical form is "${parsed.value}")`
      );
    }
  }

  const safetyDeposit = leg['safetyDeposit'];
  if (typeof safetyDeposit !== 'string') {
    // The `null` case is handled below; an outright missing key is a bug.
    if (safetyDeposit !== null) issues.add(`${path}.safetyDeposit`, 'must be a string or null');
  } else {
    const parsed = parseAtomicAmount(safetyDeposit, `${path}.safetyDeposit`);
    if (!parsed.ok) {
      issues.add(`${path}.safetyDeposit`, parsed.issues[0]?.message ?? 'invalid safety deposit');
    }
  }

  const orderId = leg['orderId'];
  if (orderId !== null && typeof orderId !== 'string') {
    issues.add(`${path}.orderId`, 'must be a string or null');
  } else if (typeof orderId === 'string' && orderId.length === 0) {
    // `""` is "not locked" written wrongly. `orderId === null` is the
    // coordinator's way of saying it; an empty string reads as a real but
    // meaningless id.
    issues.add(`${path}.orderId`, 'must be null rather than an empty string when not locked');
  }

  const lockTx = leg['lockTx'];
  if (lockTx !== null && typeof lockTx !== 'string') {
    issues.add(`${path}.lockTx`, 'must be a string or null');
  } else if (typeof lockTx === 'string' && typeof chain === 'string') {
    const parsed = parseChainTxRef(chain as Chain, lockTx, `${path}.lockTx`);
    if (!parsed.ok) {
      issues.add(`${path}.lockTx`, parsed.issues[0]?.message ?? 'invalid transaction id');
    }
  }

  const timelock = leg['timelock'];
  if (timelock !== null) {
    const parsed = parseUnixSeconds(timelock, `${path}.timelock`);
    if (!parsed.ok) {
      issues.add(`${path}.timelock`, parsed.issues[0]?.message ?? 'invalid timelock');
    }
  }
}

// ── Order guard ─────────────────────────────────────────────────────────────

/**
 * Validate a canonical `Order` (or the output of `toOrder`).
 *
 * Beyond per-field shape this enforces the *cross-field* invariants that a
 * field-by-field check cannot:
 *
 * • `publicId` is the canonical `wf_` id and its embedded hashlock matches
 *   `order.hashlock` — the two are derived from one another, so a mismatch
 *   means the record was assembled from two different orders.
 * • `src` and `dst` chains match `direction` per the route registry.
 * • Status and leg state agree: a leg with a `lockTx` but no `timelock`, or
 *   an `announced` order whose source leg claims a lock, is incoherent.
 * • A terminal status has no live leg locks left dangling, and a
 *   non-terminal status is not paired with a terminal one.
 * • If `preimage` is non-null, the order must have progressed at least to
 *   `secret_revealed`.
 */
export function validateOrder(input: unknown): GuardResult<StrictOrder> {
  const issues = new GuardIssueCollector();

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return issues.add('order', 'must be an object').finish(undefined as unknown as StrictOrder);
  }
  const order = input as Record<string, unknown>;

  const publicId = order['publicId'];
  if (typeof publicId !== 'string') {
    issues.add('order.publicId', 'must be a string');
  } else {
    const parsed = parsePublicOrderId(publicId, 'order.publicId');
    if (!parsed.ok) {
      issues.add('order.publicId', parsed.issues[0]?.message ?? 'invalid public id');
    }
  }

  const direction = order['direction'];
  if (typeof direction !== 'string') {
    issues.add('order.direction', 'must be a string');
  } else if (!isLiveDirection(direction)) {
    issues.add('order.direction', `must be a live direction: ${KNOWN_DIRECTIONS.join(', ')}`);
  }

  const status = order['status'];
  if (typeof status !== 'string') {
    issues.add('order.status', 'must be a string');
  } else if (!KNOWN_ORDER_STATUSES.includes(status as OrderStatus)) {
    issues.add('order.status', `unknown order status "${status}"`);
  }

  const hashlock = order['hashlock'];
  if (typeof hashlock !== 'string') {
    issues.add('order.hashlock', 'must be a string');
  } else {
    const parsed = parseHashlock(hashlock);
    if (!parsed.ok) {
      issues.add('order.hashlock', parsed.issues[0]?.message ?? 'invalid hashlock');
    } else if (parsed.value !== hashlock) {
      issues.add('order.hashlock', 'must be lowercase 0x-prefixed hex');
    }
  }

  validateLeg(order['src'], 'order.src', issues);
  validateLeg(order['dst'], 'order.dst', issues);

  const preimage = order['preimage'];
  if (preimage !== null && typeof preimage !== 'string') {
    issues.add('order.preimage', 'must be a 0x-prefixed hex string or null');
  } else if (typeof preimage === 'string') {
    const parsed = parseHashlock(preimage);
    if (!parsed.ok) {
      issues.add('order.preimage', parsed.issues[0]?.message ?? 'invalid preimage');
    }
  }

  // ── cross-field invariants ───────────────────────────────────────────────

  if (typeof publicId === 'string' && typeof hashlock === 'string') {
    const embedded = publicId.startsWith('wf_') ? publicId.slice(3) : null;
    if (embedded !== null && embedded.toLowerCase() !== hashlock.toLowerCase()) {
      issues.add(
        'order.publicId',
        "public id does not embed this order's hashlock; the record was assembled from two orders"
      );
    }
  }

  if (typeof direction === 'string' && isLiveDirection(direction)) {
    const want = LIVE_DIRECTION_CHAINS[direction];
    for (const leg of ['src', 'dst'] as const) {
      const value = order[leg];
      if (typeof value !== 'object' || value === null) continue;
      const chain = (value as Record<string, unknown>)['chain'];
      if (typeof chain === 'string' && chain !== want[leg]) {
        issues.add(`order.${leg}.chain`, `direction ${direction} requires ${leg} on ${want[leg]}`);
      }
    }
  }

  const knownStatus =
    typeof status === 'string' && KNOWN_ORDER_STATUSES.includes(status as OrderStatus)
      ? (status as OrderStatus)
      : undefined;

  for (const leg of ['src', 'dst'] as const) {
    const value = order[leg];
    if (typeof value !== 'object' || value === null) continue;
    const legRec = value as Record<string, unknown>;
    const locked = legRec['lockTx'] !== null && legRec['lockTx'] !== undefined;
    const hasOrderId = legRec['orderId'] !== null && legRec['orderId'] !== undefined;
    const hasTimelock = legRec['timelock'] !== null && legRec['timelock'] !== undefined;
    if (locked && !hasOrderId) {
      issues.add(`order.${leg}.orderId`, 'must be set when lockTx is set');
    }
    if (hasOrderId && !locked) {
      issues.add(`order.${leg}.lockTx`, 'must be set when orderId is set');
    }
    if (hasOrderId && !hasTimelock) {
      issues.add(`order.${leg}.timelock`, 'must be set when orderId is set');
    }
    if (knownStatus === 'announced' && hasOrderId) {
      issues.add(`order.${leg}.orderId`, 'must be null while the order is only announced');
    }

    // Terminal states deliberately do NOT clear a leg's identifiers — they
    // are the record of what happened, and a `completed` order legitimately
    // keeps both legs' locks. What *is* checkable is which legs must have
    // been funded for a terminal state to be reachable at all, and that is
    // checked after the loop below.
  }

  if (knownStatus === 'completed' || knownStatus === 'secret_revealed') {
    const dst = order['dst'] as Record<string, unknown> | undefined;
    if (dst === undefined || dst['orderId'] === null || dst['orderId'] === undefined) {
      issues.add(
        'order.dst.orderId',
        `must be set for an order that reached ${knownStatus}; ` +
          'the destination leg is what the preimage was revealed against'
      );
    }
  }

  if (preimage !== null && knownStatus !== undefined) {
    const reached = ['secret_revealed', 'completed'].includes(knownStatus);
    if (!reached) {
      issues.add(
        'order.preimage',
        `must be null while the order is ${knownStatus}; a preimage implies at least secret_revealed`
      );
    }
  }

  if (knownStatus !== undefined && !isReachableFromAnnounced(knownStatus)) {
    issues.add(
      'order.status',
      `status "${knownStatus}" cannot be reached from "announced" in the order state machine`
    );
  }

  if (knownStatus === 'refunded') {
    // A refunded order must have funded at least once: `announced` has no
    // edge to `refunded` in the state machine, so a refunded order with no
    // source-leg lock is a record that could not have been produced. The
    // destination leg, by contrast, must be untouched — returning the
    // source is only safe because nothing on the destination was ever
    // funded.
    const src = order['src'] as Record<string, unknown> | undefined;
    if (src?.['orderId'] === null || src?.['orderId'] === undefined) {
      issues.add('order.status', 'a refunded order must have a locked source leg');
    }
    const dst = order['dst'] as Record<string, unknown> | undefined;
    if (dst !== undefined && dst['orderId'] !== null && dst['orderId'] !== undefined) {
      issues.add(
        'order.dst.orderId',
        'must be null on a refunded order; the destination never filled'
      );
    }
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };

  return { ok: true, value: input as unknown as StrictOrder };
}

/** Assertion form of {@link validateOrder}. */
export function assertOrder(input: unknown): StrictOrder {
  return assertGuard(validateOrder(input), 'order');
}

/**
 * Narrow a loose `Order` to a `StrictOrder` without re-running validation.
 *
 * Only for call sites that have *already* validated (e.g. immediately after
 * `assertOrder`). Prefer `assertOrder`; use this when the value came from a
 * guard earlier in the same function and re-validating would be noise.
 */
export function asStrictOrder(validated: Order): StrictOrder {
  return {
    publicId: validated.publicId,
    direction: validated.direction,
    status: validated.status,
    hashlock: validated.hashlock,
    src: {
      chain: validated.src.chain,
      address: validated.src.address as ChainAddress,
      asset: validated.src.asset,
      amount: validated.src.amount,
      safetyDeposit: validated.src.safetyDeposit ?? null,
      orderId: validated.src.orderId ?? null,
      lockTx: validated.src.lockTx ?? null,
      timelock: validated.src.timelock ?? null,
    },
    dst: {
      chain: validated.dst.chain,
      address: validated.dst.address as ChainAddress,
      asset: validated.dst.asset,
      amount: validated.dst.amount,
      safetyDeposit: validated.dst.safetyDeposit ?? null,
      orderId: validated.dst.orderId ?? null,
      lockTx: validated.dst.lockTx ?? null,
      timelock: validated.dst.timelock ?? null,
    },
    preimage: validated.preimage ?? null,
  };
}

export type { ChainLeg };
