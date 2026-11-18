/**
 * Runtime guards for values read back out of `localStorage` and environment
 * configuration (#733).
 *
 * Why the SDK guards storage it does not itself touch
 * ─────────────────────────────────────────────────────
 * `coordinator/history-client.ts` documents an explicit contract:
 *
 * > `HistoryRecord` is intentionally serialisable (no Date objects, no
 * > bigint) so it can be round-tripped through `JSON.stringify`/localStorage
 * > without data loss.
 *
 * That contract has the mirror-image half, and nothing enforces it. A page
 * that caches a history page in `localStorage` reads it back with a bare
 * `JSON.parse` and casts. `JSON.parse` returns `any`, so a cache written by
 * an older SDK — or truncated by a quota error, or hand-edited by a curious
 * user — produces an object that satisfies `HistoryPage` at compile time and
 * throws `Cannot read properties of undefined` in a React render. The same
 * applies to the coordinator base URL and operator key that every frontend
 * reads out of `import.meta.env` / `process.env`: `VITE_COORDINATOR_URL` is
 * whatever the build machine's shell had in it, and a typo there produces a
 * client that fetches `undefined/api/orders/...`.
 *
 * The SDK cannot own those reads — it is a library, and it never calls
 * `localStorage` or `process.env` itself (verified: no occurrences in
 * `src/`). But it *is* the component that defines the shapes those values
 * must have, so it owns the guards. A consumer's cache layer becomes
 *
 * ```ts
 * const cached = readCache('wf.history.eth');       // unknown | null
 * if (cached !== null) {
 *   const page = assertPersistedHistoryPage(cached);  // HistoryPage, or throws
 * }
 * ```
 *
 * Deliberate design choices
 * ────────────────────────
 * • The input is `unknown`, never `any`. `JSON.parse` is typed `any`, and a
 *   guard that accepts `any` invites `as` at the call site.
 * • A *whole-page* guard, not a per-record one, so a partially-written cache
 *   is rejected rather than half-applied.
 * • `null` is accepted for every nullable field, because a cache written by
 *   an older SDK omits fields that the current type considers required. The
 *   guard distinguishes "null" (known-absent) from "missing" (unknown), and
 *   only the latter is an error — that is what makes a cache forward
 *   compatible without being permissive about garbage.
 * • Deep equality is not attempted against a previous version's shape; that
 *   is a migration concern and belongs in the consumer, not in a guard.
 */

import type { OrderStatus } from '../types/index.js';
import type { CoordinatorDirection } from '../coordinator/contract.js';
import { assertGuard, GuardIssueCollector, type GuardResult } from './result.js';
import { parsePublicOrderId, parseUnixSeconds } from './branded.js';
import { KNOWN_ORDER_STATUSES } from './coordinator-response.js';

// ── Persisted history page ──────────────────────────────────────────────────

/**
 * The `HistoryPage` shape as persisted, matching
 * `coordinator/history-client.ts`'s `HistoryPage` field-for-field.
 *
 * Declared here rather than imported so the *storage* contract is written
 * down independently of the client that produces it. `test/guards-persisted
 * .test.ts` asserts the two agree, so a change to one without the other is
 * a test failure rather than silent cache corruption.
 */
export interface PersistedHistoryPage {
  readonly transactions: readonly PersistedHistoryRecord[];
  readonly nextCursor: string | null;
  readonly fetchedAt: number;
}

export interface PersistedHistoryRecord {
  readonly id: string;
  readonly direction: CoordinatorDirection;
  readonly status: OrderStatus;
  readonly hashlock: string;
  readonly src: PersistedHistoryLeg;
  readonly dst: PersistedHistoryLeg;
  readonly secret: {
    readonly revealed: boolean;
    readonly preimage: string | null;
    readonly revealedTx: string | null;
  };
  readonly resolver: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A cached leg.
 *
 * `safetyDeposit` is present on the source leg and **absent** on the
 * destination leg — `HistoryRecord`'s `dst` has no such key at all, not a
 * `null` one. That asymmetry is why this is optional rather than
 * `string | null`: modelling it as nullable would make a caller that writes
 * `"safetyDeposit": null` onto a destination leg look valid, when a consumer
 * reading it back would then see a key the type never promised.
 */
export interface PersistedHistoryLeg {
  readonly chain: string;
  readonly address: string;
  readonly asset: string;
  readonly amount: string;
  readonly safetyDeposit?: string | null;
  readonly orderId: string | null;
  readonly lockTx: string | null;
  readonly timelock: number | null;
}

const KNOWN_DIRECTIONS: readonly string[] = [
  'eth_to_xlm',
  'xlm_to_eth',
  'eth_to_sol',
  'sol_to_eth',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: GuardIssueCollector
): void {
  const value = source[key];
  if (value === null) return;
  if (typeof value !== 'string') {
    issues.add(`${path}.${key}`, 'must be a string or null');
    return;
  }
  if (key === 'orderId' && value.length === 0) {
    issues.add(`${path}.orderId`, 'must be null rather than an empty string when not locked');
  }
}

function nullableInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: GuardIssueCollector
): void {
  const value = source[key];
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.add(`${path}.${key}`, 'must be an integer number or null');
  }
}

function validatePersistedLeg(input: unknown, path: string, issues: GuardIssueCollector): void {
  if (!isRecord(input)) {
    issues.add(path, 'must be an object');
    return;
  }
  if (typeof input['chain'] !== 'string' || input['chain'].length === 0) {
    issues.add(`${path}.chain`, 'must be a non-empty string');
  }
  if (typeof input['address'] !== 'string' || input['address'].length === 0) {
    issues.add(`${path}.address`, 'must be a non-empty string');
  }
  if (typeof input['asset'] !== 'string' || input['asset'].length === 0) {
    issues.add(`${path}.asset`, 'must be a non-empty string');
  }
  if (typeof input['amount'] !== 'string' || !/^\d+$/.test(input['amount'])) {
    issues.add(`${path}.amount`, 'must be a decimal integer string');
  }
  if (
    input['safetyDeposit'] !== undefined &&
    input['safetyDeposit'] !== null &&
    !/^\d+$/.test(String(input['safetyDeposit']))
  ) {
    issues.add(`${path}.safetyDeposit`, 'must be a decimal integer string, null, or absent');
  }
  nullableString(input, 'orderId', path, issues);
  nullableString(input, 'lockTx', path, issues);
  nullableInteger(input, 'timelock', path, issues);
}

function validatePersistedRecord(input: unknown, path: string, issues: GuardIssueCollector): void {
  if (!isRecord(input)) {
    issues.add(path, 'must be an object');
    return;
  }
  const id = input['id'];
  if (typeof id !== 'string') {
    issues.add(`${path}.id`, 'must be a string');
  } else if (!parsePublicOrderId(id).ok) {
    issues.add(`${path}.id`, 'must be a canonical public order id (wf_0x + 64 hex chars)');
  }
  if (typeof input['direction'] !== 'string' || !KNOWN_DIRECTIONS.includes(input['direction'])) {
    issues.add(`${path}.direction`, `must be one of: ${KNOWN_DIRECTIONS.join(', ')}`);
  }
  if (
    typeof input['status'] !== 'string' ||
    !KNOWN_ORDER_STATUSES.includes(input['status'] as OrderStatus)
  ) {
    issues.add(`${path}.status`, 'must be a known order status');
  }
  if (typeof input['hashlock'] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input['hashlock'])) {
    issues.add(`${path}.hashlock`, 'must be a 0x-prefixed 64-char hex string');
  }
  const secret = input['secret'];
  if (!isRecord(secret)) {
    issues.add(`${path}.secret`, 'must be an object');
  } else {
    if (typeof secret['revealed'] !== 'boolean') {
      issues.add(`${path}.secret.revealed`, 'must be a boolean');
    }
    if (secret['preimage'] !== null && typeof secret['preimage'] !== 'string') {
      issues.add(`${path}.secret.preimage`, 'must be a string or null');
    }
    if (secret['revealedTx'] !== null && typeof secret['revealedTx'] !== 'string') {
      issues.add(`${path}.secret.revealedTx`, 'must be a string or null');
    }
  }

  if (input['resolver'] !== null && typeof input['resolver'] !== 'string') {
    issues.add(`${path}.resolver`, 'must be a string or null');
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (!parseUnixSeconds(input[key], `${path}.${key}`).ok) {
      issues.add(`${path}.${key}`, 'must be an absolute unix timestamp in seconds');
    }
  }

  validatePersistedLeg(input['src'], `${path}.src`, issues);
  validatePersistedLeg(input['dst'], `${path}.dst`, issues);
}

/**
 * Validate a history page read back out of `localStorage` / `sessionStorage`.
 *
 * Rejects: a non-object, a missing `transactions` array, a record with a
 * malformed id / direction / status / hashlock, a leg with a non-numeric
 * amount, and a `fetchedAt` that is not an absolute timestamp. A record with
 * every field present but `null` where `null` is legal is accepted — that is
 * the forward-compatible case.
 */
export function validatePersistedHistoryPage(input: unknown): GuardResult<PersistedHistoryPage> {
  const issues = new GuardIssueCollector();

  if (!isRecord(input)) {
    return issues
      .add('cache', 'cached history page must be a JSON object')
      .finish(undefined as unknown as PersistedHistoryPage);
  }

  const transactions = input['transactions'];
  if (!Array.isArray(transactions)) {
    issues.add('cache.transactions', 'must be an array');
  } else {
    transactions.forEach((entry, index) => {
      validatePersistedRecord(entry, `cache.transactions[${index}]`, issues);
    });
  }

  const nextCursor = input['nextCursor'];
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    issues.add('cache.nextCursor', 'must be a string or null');
  }

  if (!parseUnixSeconds(input['fetchedAt'], 'cache.fetchedAt').ok) {
    issues.add('cache.fetchedAt', 'must be an absolute unix timestamp in seconds');
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: input as unknown as PersistedHistoryPage };
}

export function assertPersistedHistoryPage(input: unknown): PersistedHistoryPage {
  return assertGuard(validatePersistedHistoryPage(input), 'persisted history page');
}

// ── Environment / storage-string configuration ──────────────────────────────

/**
 * The subset of SDK configuration that reaches the client from the
 * environment: a coordinator base URL, an optional bearer key, and a
 * timeout.
 */
export interface CoordinatorEnvConfig {
  /** Absolute `http(s)` URL, no trailing slash. */
  readonly baseUrl: string;
  readonly timeoutMs: number | undefined;
  readonly operatorKey: string | undefined;
}

/** What a raw environment value can be before it is trusted. */
const ENV_SOURCES = ['process.env', 'import.meta.env', 'localStorage', 'config file'] as const;

export type EnvSource = (typeof ENV_SOURCES)[number];

/**
 * Validate a coordinator base URL that came from the environment or from
 * storage.
 *
 * `CoordinatorClient` does `options.baseUrl.replace(/\/$/, "")` and then
 * concatenates a path onto it. Every one of these produces a client that
 * silently fetches the wrong URL rather than failing at construction:
 *
 *   • `""`               → `/api/orders/...` against the current origin
 *   • `"coordinator.io"` → `"coordinator.io/api/orders/..."`, an invalid URL
 *   • `"http://…"`       → plaintext, exposing the operator bearer token
 *   * `"https://…/base/"`  → fine (the client strips the slash), kept valid
 */
export function validateCoordinatorBaseUrl(
  input: unknown,
  source: EnvSource = 'process.env'
): GuardResult<string> {
  const issues = new GuardIssueCollector();
  if (typeof input !== 'string' || input.trim() === '') {
    return issues
      .add(`${source}.coordinatorUrl`, 'must be a non-empty string')
      .finish(undefined as unknown as string);
  }
  const raw = input.trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return issues
      .add(
        `${source}.coordinatorUrl`,
        `"${raw}" is not an absolute URL; include the scheme, e.g. https://coordinator.example`
      )
      .finish(undefined as unknown as string);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    issues.add(`${source}.coordinatorUrl`, `unsupported scheme "${url.protocol}"; use https:`);
  }
  if (url.protocol === 'http:') {
    issues.add(
      `${source}.coordinatorUrl`,
      'plain http: would send the operator bearer token in clear text; use https:'
    );
  }
  if (url.search !== '' || url.hash !== '') {
    issues.add(`${source}.coordinatorUrl`, 'must not carry a query string or fragment');
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: raw.replace(/\/+$/, '') };
}

/**
 * Validate a whole `CoordinatorClientOptions` object that was assembled from
 * the environment.
 *
 * `operatorKey` is checked for emptiness and for the two characters that
 * break an `Authorization: Bearer` header (whitespace and control
 * characters), not for strength — that is not the SDK's call.
 */
export function validateCoordinatorEnvConfig(
  input: unknown,
  source: EnvSource = 'process.env'
): GuardResult<CoordinatorEnvConfig> {
  const issues = new GuardIssueCollector();
  if (!isRecord(input)) {
    return issues
      .add(source, 'configuration must be an object')
      .finish(undefined as unknown as CoordinatorEnvConfig);
  }
  const record = input as Record<string, unknown>;

  const baseUrl = validateCoordinatorBaseUrl(record['baseUrl'], source);
  if (!baseUrl.ok) {
    for (const issue of baseUrl.issues) issues.add(issue.field, issue.message);
  }

  let timeoutMs: number | undefined;
  if (record['timeoutMs'] !== undefined && record['timeoutMs'] !== null) {
    const value = record['timeoutMs'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      issues.add(`${source}.timeoutMs`, 'must be a positive integer number of milliseconds');
    } else if (value > 120_000) {
      issues.add(`${source}.timeoutMs`, 'must not exceed 120000 ms (2 minutes)');
    } else {
      timeoutMs = value;
    }
  }

  let operatorKey: string | undefined;
  if (record['operatorKey'] !== undefined && record['operatorKey'] !== null) {
    const value = record['operatorKey'];
    if (typeof value !== 'string') {
      issues.add(`${source}.operatorKey`, 'must be a string');
    } else if (value.trim() === '') {
      // An empty bearer token produces `Authorization: Bearer `, which some
      // gateways answer with 401 and others with 200. Treated as unset.
      issues.add(`${source}.operatorKey`, 'must not be blank; omit the key instead');
    } else if (hasUnsafeHeaderChar(value)) {
      issues.add(`${source}.operatorKey`, 'must not contain whitespace or control characters');
    } else {
      operatorKey = value;
    }
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return {
    ok: true,
    value: {
      baseUrl: (baseUrl as { ok: true; value: string }).value,
      timeoutMs,
      operatorKey,
    },
  };
}

/**
 * True when a string contains a character that cannot appear in an
 * `Authorization: Bearer` credential.
 *
 * Written as a character-code scan rather than a regex so the control
 * characters do not have to be written literally (which is unreadable, and
 * trips `no-control-regex`).
 */
function hasUnsafeHeaderChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // 0x09 tab, 0x0A LF, 0x0D CR, 0x20 space, 0x7F DEL, and the C0 range.
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function assertCoordinatorEnvConfig(
  input: unknown,
  source: EnvSource = 'process.env'
): CoordinatorEnvConfig {
  return assertGuard(validateCoordinatorEnvConfig(input, source), 'coordinator environment config');
}
