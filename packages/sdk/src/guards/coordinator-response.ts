/**
 * Runtime guards for coordinator HTTP responses (#733).
 *
 * The unvalidated trust boundary
 * ──────────────────────────────
 * `coordinator/client.ts` does this on every 2xx response:
 *
 * ```ts
 * return parsed as T;                       // client.ts
 * ```
 *
 * `parsed` came out of `await response.json()` and `T` is whatever the caller
 * asked for — `CoordinatorOrder`, `CoordinatorHistoryResponse`,
 * `CoordinatorHealthResponse`. Nothing checks that the body has `src`, that
 * `status` is a member of the `OrderStatus` union, or that `pagination` is
 * even present. If the coordinator ships a rename, a field becomes optional
 * by accident, or a proxy returns an HTML-ish 200, the SDK hands the
 * consumer an object that satisfies the type but crashes on first property
 * access — with the failure surfacing in the frontend rather than at the
 * boundary that caused it.
 *
 * `coordinator/transform.ts` has the same shape one layer down:
 *
 * ```ts
 * hashlock: wire.hashlock as `0x${string}`,
 * preimage: (wire.secret.preimage as `0x${string}` | null) ?? null,
 * ```
 *
 * Those two casts launder an unvalidated `string` into a hex-literal type.
 * After this module, a caller can replace them with
 * `assertCoordinatorOrder(body)` and delete the casts — see
 * `test/guards-coordinator-response.test.ts` for the equivalence proof.
 *
 * What is checked
 * ───────────────
 * Structural: required keys present, correct JS primitive kind, no
 * `undefined` where the wire contract promises `null`.
 * Semantic:   `direction` is a live route direction, `status` is a member of
 *             the `OrderStatus` union, `id` matches the canonical
 *             `wf_0x<64 hex>` form, the hashlock is a real 32-byte hex
 *             string, amounts are non-negative decimal integer strings, and
 *             `srcChain`/`dstChain` agree with `direction` via the route
 *             registry.
 *
 * Deliberately NOT checked
 * ────────────────────────
 * • Unknown extra fields. The wire contract is additive by design
 *   (`contract.ts` says so); a new coordinator field must not break an SDK
 *   that predates it.
 * • Cross-referencing `hashlock` against the order id. That is an integrity
 *   property, checked separately by
 *   `fixtures/index.ts`'s `FIXTURE_IDENTITIES` digest and by the consumer
 *   that actually cares, not a shape property.
 * • `lockBlock` coherence with `lockTx`. The coordinator owns that invariant.
 *
 * Forward compatibility
 * ─────────────────────
 * A new `OrderStatus` or `Direction` member on the coordinator is a *loud*
 * failure here, by design: an SDK that silently drops an order because the
 * backend learned a new lifecycle state is worse than one that throws. The
 * union in `types/index.ts` is the switch that has to be flipped, and the
 * failure message says so.
 */

import { LIVE_DIRECTION_CHAINS, LIVE_ROUTE_DIRECTIONS, isLiveDirection } from '../routes/index.js';
import type { Chain, Direction, OrderStatus } from '../types/index.js';
import type {
  CoordinatorHistoryResponse,
  CoordinatorOrder,
  CoordinatorReadinessResponse,
  CoordinatorSecretResponse,
} from '../coordinator/contract.js';
import { assertGuard, GuardIssueCollector, type GuardResult } from './result.js';
import { parseChainTxRef, parseHashlock, parsePublicOrderId, parseUnixSeconds } from './branded.js';

// ── Vocabularies (kept next to the guards so a union change fails here too) ──

/**
 * Every `OrderStatus` the SDK understands.
 *
 * Declared locally rather than derived from `types/index.ts`'s union on
 * purpose: TypeScript cannot enumerate a string-literal union at runtime, so
 * the list has to exist in *some* form. Duplicating it in the same file as
 * the guard is what makes a new status a compile error in one place and a
 * test failure in the other — see `test/guards-coordinator-response.test.ts`
 * for the exhaustiveness test that ties the two together.
 */
export const KNOWN_ORDER_STATUSES: readonly OrderStatus[] = [
  'announced',
  'src_locked',
  'dst_locked',
  'secret_revealed',
  'completed',
  'refunded',
  'failed',
  'expired',
  'cancelled',
  'abandoned',
];

/** Every chain the coordinator speaks. */
export const KNOWN_COORDINATOR_CHAINS: readonly Chain[] = ['ethereum', 'stellar', 'solana'];

/** Every direction the coordinator accepts (the live subset of `Direction`). */
export const KNOWN_COORDINATOR_DIRECTIONS: readonly Direction[] = LIVE_ROUTE_DIRECTIONS;

// ── Primitive helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: GuardIssueCollector
): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') {
    issues.add(`${path}.${key}`, 'must be a string');
    return undefined;
  }
  return value;
}

function requireNullableString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: GuardIssueCollector
): string | null | undefined {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    issues.add(`${path}.${key}`, 'must be a string or null');
    return undefined;
  }
  return value;
}

function requireInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: GuardIssueCollector
): number | undefined {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.add(`${path}.${key}`, 'must be an integer number');
    return undefined;
  }
  return value;
}

function requireNullableInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: GuardIssueCollector
): number | null | undefined {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.add(`${path}.${key}`, 'must be an integer number or null');
    return undefined;
  }
  return value;
}

// ── Leg ─────────────────────────────────────────────────────────────────────

/**
 * Validate one `CoordinatorChainLeg`.
 *
 * The wire contract says `orderId`, `lockTx`, `lockBlock` and `timelock` are
 * `string | null` / `number | null` and *never* `undefined` — an omitted key
 * is a coordinator bug, and silently reading it as `undefined` is exactly how
 * `chainLeg.timelock` ends up being neither "no timelock" nor a number.
 */
function validateChainLeg(input: unknown, path: string, issues: GuardIssueCollector): void {
  if (!isRecord(input)) {
    issues.add(path, 'must be an object');
    return;
  }

  const chain = input['chain'];
  if (typeof chain !== 'string' || !KNOWN_COORDINATOR_CHAINS.includes(chain as Chain)) {
    issues.add(`${path}.chain`, `must be one of: ${KNOWN_COORDINATOR_CHAINS.join(', ')}`);
  }

  requireString(input, 'address', path, issues);
  requireString(input, 'asset', path, issues);

  const amount = requireString(input, 'amount', path, issues);
  if (amount !== undefined && !/^\d+$/.test(amount)) {
    issues.add(`${path}.amount`, 'must be a decimal integer string of atomic units');
  }

  // `safetyDeposit` is optional on the wire (source leg only) but must be a
  // decimal integer string *when present* — a float here is a token-amount
  // precision bug, not a cosmetic one.
  const safetyDeposit = input['safetyDeposit'];
  if (safetyDeposit !== undefined) {
    if (typeof safetyDeposit !== 'string' || !/^\d+$/.test(safetyDeposit)) {
      issues.add(
        `${path}.safetyDeposit`,
        'must be a decimal integer string of atomic units when present'
      );
    }
  }

  requireNullableString(input, 'orderId', path, issues);

  // `lockTx` must be a transaction id *on this leg's chain*. The three
  // encodings are genuinely different — `0x` + 64 hex, 64 bare hex, base-58
  // 64 bytes — and a coordinator that reports the wrong one produces a
  // "transaction not found" that reads like a dropped transaction.
  const lockTx = requireNullableString(input, 'lockTx', path, issues);
  if (
    lockTx !== undefined &&
    lockTx !== null &&
    typeof chain === 'string' &&
    KNOWN_COORDINATOR_CHAINS.includes(chain as Chain)
  ) {
    const parsed = parseChainTxRef(chain as Chain, lockTx, `${path}.lockTx`);
    if (!parsed.ok) {
      issues.add(`${path}.lockTx`, parsed.issues[0]?.message ?? 'invalid transaction id');
    }
  }

  requireNullableInteger(input, 'lockBlock', path, issues);
  requireNullableInteger(input, 'timelock', path, issues);
}

// ── Secret block ────────────────────────────────────────────────────────────

function validateSecretBlock(input: unknown, path: string, issues: GuardIssueCollector): void {
  if (!isRecord(input)) {
    issues.add(path, 'must be an object');
    return;
  }
  const revealed = input['revealed'];
  if (typeof revealed !== 'boolean') {
    issues.add(`${path}.revealed`, 'must be a boolean');
  }
  const preimage = requireNullableString(input, 'preimage', path, issues);
  if (preimage !== undefined && preimage !== null) {
    const parsed = parseHashlock(preimage);
    if (!parsed.ok) {
      issues.add(`${path}.preimage`, 'must be a 0x-prefixed 64-char hex string when present');
    }
  }
  requireNullableString(input, 'revealedTx', path, issues);
}

// ── Order ───────────────────────────────────────────────────────────────────

/**
 * Validate a single coordinator order object (`unknown` in, `CoordinatorOrder` out).
 *
 * ```ts
 * const result = validateCoordinatorOrder(await response.json());
 * if (!result.ok) console.error(result.issues);
 * const order = assertCoordinatorOrder(await response.json());
 * ```
 */
export function validateCoordinatorOrder(input: unknown): GuardResult<CoordinatorOrder> {
  const issues = new GuardIssueCollector();

  if (!isRecord(input)) {
    return issues
      .add('root', 'order must be a JSON object')
      .finish(undefined as unknown as CoordinatorOrder);
  }

  const id = requireString(input, 'id', 'order', issues);
  if (id !== undefined) {
    const parsedId = parsePublicOrderId(id);
    if (!parsedId.ok) {
      issues.add('order.id', 'must be a canonical public order id (wf_0x + 64 hex chars)');
    }
  }

  const direction = requireString(input, 'direction', 'order', issues);
  if (direction !== undefined && !isLiveDirection(direction)) {
    issues.add(
      'order.direction',
      `must be a live coordinator direction: ${KNOWN_COORDINATOR_DIRECTIONS.join(', ')}`
    );
  }

  const status = requireString(input, 'status', 'order', issues);
  if (status !== undefined && !KNOWN_ORDER_STATUSES.includes(status as OrderStatus)) {
    issues.add(
      'order.status',
      `unknown order status "${status}"; known statuses: ${KNOWN_ORDER_STATUSES.join(', ')}`
    );
  }

  const hashlock = requireString(input, 'hashlock', 'order', issues);
  if (hashlock !== undefined) {
    const parsed = parseHashlock(hashlock);
    if (!parsed.ok) {
      issues.add('order.hashlock', parsed.issues[0]?.message ?? 'invalid hashlock');
    } else if (parsed.value !== hashlock) {
      // The wire contract is lowercase. An uppercased hashlock would survive
      // `toOrder` unchanged and then fail the canonical `Order` check, three
      // frames later; rejecting it here names the real problem.
      issues.add('order.hashlock', 'must be lowercase 0x-prefixed hex');
    }
  }

  validateChainLeg(input['src'], 'order.src', issues);
  validateChainLeg(input['dst'], 'order.dst', issues);
  validateSecretBlock(input['secret'], 'order.secret', issues);

  requireNullableString(input, 'resolver', 'order', issues);
  requireInteger(input, 'createdAt', 'order', issues);
  requireInteger(input, 'updatedAt', 'order', issues);

  // Direction / chain coherence. Only checked when all three parsed, so a
  // malformed chain does not produce a second, misleading complaint.
  if (
    direction !== undefined &&
    isLiveDirection(direction) &&
    isRecord(input['src']) &&
    isRecord(input['dst'])
  ) {
    const want = LIVE_DIRECTION_CHAINS[direction];
    const srcChain = input['src']['chain'];
    const dstChain = input['dst']['chain'];
    if (typeof srcChain === 'string' && srcChain !== want.src) {
      issues.add('order.src.chain', `direction ${direction} requires srcChain=${want.src}`);
    }
    if (typeof dstChain === 'string' && dstChain !== want.dst) {
      issues.add('order.dst.chain', `direction ${direction} requires dstChain=${want.dst}`);
    }
  }

  // Timelocks must be absolute unix seconds in a plausible range. A raw
  // duration (a value below the order's own creation time) is a common and
  // hard-to-spot coordinator bug, so it is rejected here rather than
  // producing a permanently-claimable order downstream.
  const createdAt = requireInteger(input, 'createdAt', 'order', issues);
  for (const leg of ['src', 'dst'] as const) {
    if (!isRecord(input[leg])) continue;
    const timelock = input[leg]['timelock'];
    if (typeof timelock !== 'number' || timelock === null) continue;
    if (!parseUnixSeconds(timelock, `${'order'}.${leg}.timelock`).ok) {
      continue; // already reported as a shape problem above
    }
    if (createdAt !== undefined && timelock < createdAt) {
      issues.add(
        `order.${leg}.timelock`,
        `absolute timelock ${timelock} precedes the order's createdAt ${createdAt}; ` +
          'the coordinator must send an absolute unix timestamp, not a duration'
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues: issues.list() };
  }

  // Every field has been checked; the cast below is the one place a cast is
  // justified — it is reached only when each field was individually proven to
  // have the right primitive kind above. This is the difference from
  // `parsed as T`: there is no path to this line that skips a check.
  return { ok: true, value: input as unknown as CoordinatorOrder };
}

// ── History page ────────────────────────────────────────────────────────────

function validatePagination(input: unknown, issues: GuardIssueCollector): void {
  if (!isRecord(input)) {
    issues.add('page.pagination', 'must be an object');
    return;
  }
  requireInteger(input, 'limit', 'page.pagination', issues);
  requireInteger(input, 'count', 'page.pagination', issues);
  if ('nextCursor' in input) {
    const cursor = input['nextCursor'];
    if (cursor !== null && typeof cursor !== 'string') {
      issues.add('page.pagination.nextCursor', 'must be a string or null');
    }
  } else if (!('offset' in input)) {
    issues.add(
      'page.pagination',
      'must be either the cursor variant (nextCursor) or the offset variant (offset)'
    );
  }
  if ('offset' in input) {
    requireInteger(input, 'offset', 'page.pagination', issues);
  }
}

/** Validate a `GET /api/orders/history` response envelope. */
export function validateCoordinatorHistoryResponse(
  input: unknown
): GuardResult<CoordinatorHistoryResponse> {
  const issues = new GuardIssueCollector();

  if (!isRecord(input)) {
    return issues
      .add('page', 'history response must be a JSON object')
      .finish(undefined as unknown as CoordinatorHistoryResponse);
  }

  const transactions = input['transactions'];
  if (!Array.isArray(transactions)) {
    issues.add('page.transactions', 'must be an array');
  } else {
    transactions.forEach((entry, index) => {
      const result = validateCoordinatorOrder(entry);
      if (!result.ok) {
        for (const issue of result.issues) {
          // Re-root the path so the caller can tell which order was bad.
          issues.add(`page.transactions[${index}].${issue.field}`, issue.message);
        }
      }
    });
  }

  validatePagination(input['pagination'], issues);

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return {
    ok: true,
    value: input as unknown as CoordinatorHistoryResponse,
  };
}

// ── Secret ──────────────────────────────────────────────────────────────────

/** Validate a `GET /api/secrets/:publicId` response. */
export function validateCoordinatorSecretResponse(
  input: unknown
): GuardResult<CoordinatorSecretResponse> {
  const issues = new GuardIssueCollector();
  if (!isRecord(input)) {
    return issues
      .add('root', 'secret response must be a JSON object')
      .finish(undefined as unknown as CoordinatorSecretResponse);
  }
  const publicId = requireString(input, 'publicId', 'secret', issues);
  if (publicId !== undefined && !parsePublicOrderId(publicId).ok) {
    issues.add('secret.publicId', 'must be a canonical public order id (wf_0x + 64 hex chars)');
  }
  const preimage = requireString(input, 'preimage', 'secret', issues);
  if (preimage !== undefined && !parseHashlock(preimage).ok) {
    issues.add('secret.preimage', 'must be a 0x-prefixed 64-char hex string');
  }
  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: input as unknown as CoordinatorSecretResponse };
}

// ── Health / readiness ──────────────────────────────────────────────────────

/** Validate a `GET /health` response. */
export function validateCoordinatorHealthResponse(
  input: unknown
): GuardResult<CoordinatorHealthResponseLike> {
  const issues = new GuardIssueCollector();
  if (!isRecord(input)) {
    return issues
      .add('root', 'health response must be a JSON object')
      .finish(undefined as unknown as CoordinatorHealthResponseLike);
  }
  if (input['status'] !== 'ok' && input['status'] !== 'degraded') {
    issues.add('health.status', 'must be "ok" or "degraded"');
  }
  requireString(input, 'service', 'health', issues);
  requireString(input, 'version', 'health', issues);
  requireInteger(input, 'uptimeSeconds', 'health', issues);
  requireString(input, 'timestamp', 'health', issues);

  if ('reconciliation' in input) {
    const rec = input['reconciliation'];
    if (rec === null || rec === undefined) {
      // explicitly nullable — nothing to check
    } else if (!isRecord(rec)) {
      issues.add('health.reconciliation', 'must be an object or null');
    } else {
      requireNullableInteger(rec, 'lastRunAt', 'health.reconciliation', issues);
      const ok = rec['lastRunOk'];
      if (ok !== null && typeof ok !== 'boolean') {
        issues.add('health.reconciliation.lastRunOk', 'must be a boolean or null');
      }
      requireInteger(rec, 'eventsReplayed', 'health.reconciliation', issues);
    }
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: input as unknown as CoordinatorHealthResponseLike };
}

/** Validate a `GET /readyz` response. */
export function validateCoordinatorReadinessResponse(
  input: unknown
): GuardResult<CoordinatorReadinessResponse> {
  const issues = new GuardIssueCollector();
  if (!isRecord(input)) {
    return issues
      .add('root', 'readiness response must be a JSON object')
      .finish(undefined as unknown as CoordinatorReadinessResponse);
  }
  if (input['status'] !== 'ok' && input['status'] !== 'degraded') {
    issues.add('readyz.status', 'must be "ok" or "degraded"');
  }
  requireString(input, 'service', 'readyz', issues);
  requireString(input, 'version', 'readyz', issues);
  requireInteger(input, 'uptimeSeconds', 'readyz', issues);
  requireString(input, 'timestamp', 'readyz', issues);

  const checks = input['checks'];
  if (!Array.isArray(checks)) {
    issues.add('readyz.checks', 'must be an array');
  } else {
    checks.forEach((check, index) => {
      const path = `readyz.checks[${index}]`;
      if (!isRecord(check)) {
        issues.add(path, 'must be an object');
        return;
      }
      requireString(check, 'name', path, issues);
      if (typeof check['ok'] !== 'boolean') {
        issues.add(`${path}.ok`, 'must be a boolean');
      }
      if (
        'detail' in check &&
        check['detail'] !== undefined &&
        typeof check['detail'] !== 'string'
      ) {
        issues.add(`${path}.detail`, 'must be a string when present');
      }
      if ('latencyMs' in check && check['latencyMs'] !== undefined) {
        if (typeof check['latencyMs'] !== 'number' || !Number.isInteger(check['latencyMs'])) {
          issues.add(`${path}.latencyMs`, 'must be an integer number when present');
        }
      }
    });
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: input as unknown as CoordinatorReadinessResponse };
}

/**
 * The health response type, re-declared structurally rather than imported so
 * this module has no runtime dependency on `coordinator/client.ts`.
 *
 * Structurally identical to `contract.ts`'s `CoordinatorHealthResponse`.
 */
export interface CoordinatorHealthResponseLike {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  reconciliation?: {
    lastRunAt: number | null;
    lastRunOk: boolean | null;
    eventsReplayed: number;
  } | null;
}

// ── Assertion forms ─────────────────────────────────────────────────────────

export function assertCoordinatorOrder(input: unknown): CoordinatorOrder {
  return assertGuard(validateCoordinatorOrder(input), 'coordinator order');
}

export function assertCoordinatorHistoryResponse(input: unknown): CoordinatorHistoryResponse {
  return assertGuard(validateCoordinatorHistoryResponse(input), 'coordinator history response');
}

export function assertCoordinatorSecretResponse(input: unknown): CoordinatorSecretResponse {
  return assertGuard(validateCoordinatorSecretResponse(input), 'coordinator secret response');
}

export function assertCoordinatorHealthResponse(input: unknown): CoordinatorHealthResponseLike {
  return assertGuard(validateCoordinatorHealthResponse(input), 'coordinator health response');
}

export function assertCoordinatorReadinessResponse(input: unknown): CoordinatorReadinessResponse {
  return assertGuard(validateCoordinatorReadinessResponse(input), 'coordinator readiness response');
}

// Re-exported so a consumer importing only the guards can still name the
// wire types it validates against, without a second import path.
export type {
  CoordinatorChainLeg,
  CoordinatorCursorPagination,
  CoordinatorOffsetPagination,
} from '../coordinator/contract.js';
