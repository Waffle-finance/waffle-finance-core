/**
 * RPC compatibility helpers.
 *
 * Different RPC providers and node implementations return subtly different
 * shapes for the same JSON-RPC call. This module normalises the differences
 * to a small, documented set of categories so callers do not have to special
 * case each provider.
 *
 * Scope
 * ─────
 * • classifyRpcError     — turn any thrown / returned RPC error into a
 *                          stable {category, retryable, message} triple.
 *                          Categories are intentionally small: callers branch
 *                          on them, not on provider-specific messages.
 * • chainIdsMatch        — robust comparison supporting hex / decimal /
 *                          mixed-case / prefixed / unprefixed forms.
 * • parseBalanceHex      — bigint-friendly parsing of hex / decimal / mixed
 *                          balance strings returned by eth_getBalance and
 *                          analogues.
 * • rpcCallWithFallback  — try a JSON-RPC method against a list of providers
 *                          in order, return the first successful response.
 *
 * Out of scope
 * ────────────
 * The chain-specific adapters (Ethereum / Soroban / Solana) already wrap
 * underlying provider errors into HTLCError. Those wrappers remain the
 * primary normalising layer for chain calls. The helpers in this file are
 * intended for callers (frontend, relayer, resolver) that bypass the SDK
 * adapters — primarily so they do not silently regress when an operator
 * switches an Infura endpoint to Alchemy or Ankr.
 */

// ── Categories ────────────────────────────────────────────────────────────────

export type RpcErrorCategory =
  /** The user explicitly rejected in their wallet. Not retryable. */
  | 'user_rejection'
  /** Method-specific revert — contract code returned false. Not retryable without state change. */
  | 'revert'
  /** Sender has insufficient native balance for value + gas. Not retryable (top up needed). */
  | 'insufficient_funds'
  /** Two transactions with the same nonce were submitted. Retryable with bumped nonce. */
  | 'nonce_conflict'
  /** eth_estimateGas failed. Retryable once with a fixed gas limit (e.g. 300k). */
  | 'gas_estimation_failed'
  /** 429 / provider-imposed limit. Retryable after backoff. */
  | 'rate_limited'
  /** 401 / 403 — missing or invalid API key. Not retryable until credentials are rotated. */
  | 'unauthorized'
  /** Network timeout / DNS / connection refused / 504. Retryable after backoff. */
  | 'timeout'
  /** Generic network error not classified above. Retryable on a fresh attempt. */
  | 'network'
  /** Anything else — we still classify but mark non-retryable. */
  | 'unknown';

export interface RpcError {
  category: RpcErrorCategory;
  retryable: boolean;
  message: string;
  /** Optional provider-reported numeric code (often JSON-RPC -32000-ish). */
  code?: number;
}

// ── classifyRpcError ─────────────────────────────────────────────────────────

/**
 * Recognised patterns in provider-agnostic form. Match long and noisy phrases
 * from EIP-1474 style errors before their JSON-RPC code, then fall through
 * to JSON-RPC code / status.
 */
const PATTERN_TABLE: Array<{
  test: RegExp;
  category: RpcErrorCategory;
  retryable: boolean;
}> = [
  // ── user ──────────────────────────────────────────────────────────────────
  { test: /\buser (rejected|denied|cancelled)/i, category: 'user_rejection', retryable: false },
  { test: /\b(wallet|metamask|rabby|phantom|freighter) .*(rejected|denied|declined)/i, category: 'user_rejection', retryable: false },
  { test: /\baction .* rejected/i, category: 'user_rejection', retryable: false },
  // ── revert ────────────────────────────────────────────────────────────────
  { test: /\b(execution|transaction) reverted\b/i, category: 'revert', retryable: false },
  { test: /\brequired gas exceeds allowance\b/i, category: 'gas_estimation_failed', retryable: true },
  { test: /\binsufficient allowance\b/i, category: 'revert', retryable: false },
  // ── funds ─────────────────────────────────────────────────────────────────
  { test: /\binsufficient funds?( for gas|\b)/i, category: 'insufficient_funds', retryable: false },
  { test: /\bnot enough (balance|funds)\b/i, category: 'insufficient_funds', retryable: false },
  // ── nonce ─────────────────────────────────────────────────────────────────
  { test: /\b(replacement transaction|nonce (too low|already used)|underpriced)\b/i, category: 'nonce_conflict', retryable: true },
  // ── timeouts / network ────────────────────────────────────────────────────
  { test: /\btime(d| )?out\b/i, category: 'timeout', retryable: true },
  { test: /\b(network|fetch failed|failed to fetch|connection (refused|reset))\b/i, category: 'network', retryable: true },
  { test: /\b(etag[\s-]?match|410 gone)\b/i, category: 'network', retryable: true },
];

interface MaybeRpcResponse {
  status?: number;
  code?: number;
}

function jsonRpcCodeCategory(code: number): { category: RpcErrorCategory; retryable: boolean } | null {
  // Canonical JSON-RPC 2.0 codes.
  if (code === -32603) return { category: 'network', retryable: true };          // Internal error
  if (code === -32097) return { category: 'rate_limited', retryable: true };
  if (code === -32005) return { category: 'nonce_conflict', retryable: true };    // Limit exceeded (e.g. nonce)
  if (code === -32004) return { category: 'gas_estimation_failed', retryable: true };
  if (code === -32000) return { category: 'revert', retryable: false };          // Server error → node-specific revert often
  return null;
}

function httpStatusCategory(status: number): { category: RpcErrorCategory; retryable: boolean } | null {
  if (status === 408 || status === 504) return { category: 'timeout', retryable: true };
  if (status === 429)                   return { category: 'rate_limited', retryable: true };
  if (status === 502 || status === 503) return { category: 'network', retryable: true };
  if (status === 400)                  return { category: 'revert', retryable: false }; // Bad Request from RPC usually = bad params
  if (status === 401 || status === 403) return { category: 'unauthorized', retryable: false };
  return null;
}

/**
 * Normalise any error-like value into a stable {category, retryable, message}.
 *
 * Safe to call with anything — strings, Errors, JSON-RPC response objects,
 * naked `{ status, code }` shapes, or `null`.
 */
export function classifyRpcError(err: unknown): RpcError {
  if (err == null) {
    return { category: 'unknown', retryable: false, message: 'Unknown RPC error' };
  }

  const message =
    typeof err === 'string'
      ? err
      : err instanceof Error
      ? err.message
      : (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string')
        ? (err as { message: string }).message
        : safeStringify(err);

  // ── Pass 1: pattern match on the message (most reliable across providers)
  for (const { test, category, retryable } of PATTERN_TABLE) {
    if (test.test(message)) {
      return { category, retryable, message };
    }
  }

  // ── Pass 2: numeric JSON-RPC code or HTTP status on the same shape
  const candidate = err as MaybeRpcResponse;
  if (typeof candidate?.code === 'number') {
    const fromCode = jsonRpcCodeCategory(candidate.code);
    if (fromCode) {
      return { category: fromCode.category, retryable: fromCode.retryable, message, code: candidate.code };
    }
  }
  if (typeof candidate?.status === 'number') {
    const fromStatus = httpStatusCategory(candidate.status);
    if (fromStatus) {
      return { category: fromStatus.category, retryable: fromStatus.retryable, message };
    }
  }

  // ── Pass 3: tag-shape — Error.message might already have been RetryableNetworkError-like
  return { category: 'unknown', retryable: false, message };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// ── chainIdsMatch ────────────────────────────────────────────────────────────

/**
 * Robust chain id comparison. Recognises:
 *   - 0x-prefixed hex (case insensitive): '0xaa36a7', '0XAA36A7'
 *   - decimal strings: '11155111'
 *   - bigint-like numbers in scientific form are unsupported and rejected.
 *
 * Returns false when either side is null/empty/unparseable — this matches
 * the prior "no claim" semantics used in useNetworkMode.
 */
export function chainIdsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeChainId(a);
  const right = normalizeChainId(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * Lower-level helper: return the chain id as a normalised `0x`-prefixed
 * lowercase hex string, or `null` if the input was unparseable.
 */
export function normalizeChainId(chainId: string | null | undefined): string | null {
  if (!chainId) return null;
  const trimmed = String(chainId).trim();
  if (!trimmed) return null;
  try {
    if (/^0x/i.test(trimmed)) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
    if (/^\d+$/.test(trimmed)) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
  } catch {
    return trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

// ── parseBalanceHex ──────────────────────────────────────────────────────────

/**
 * Parse a balance returned as either a 0x-hex or decimal string into bigint.
 * Returns 0n when the input is empty or unparseable.
 */
export function parseBalanceHex(raw: string | null | undefined): bigint {
  if (!raw) return 0n;
  const trimmed = String(raw).trim();
  if (!trimmed) return 0n;
  try {
    if (/^0x/i.test(trimmed)) return BigInt(trimmed);
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  } catch {
    return 0n;
  }
  return 0n;
}

// ── rpcCallWithFallback ──────────────────────────────────────────────────────

export interface RpcCallOptions {
  /** Injected fetch implementation, defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export interface RpcCallSuccess<T> {
  ok: true;
  provider: string;
  result: T;
  latencyMs: number;
}

export interface RpcCallFailure {
  ok: false;
  attempts: Array<{ provider: string; error: RpcError; latencyMs: number }>;
}

export type RpcCallResult<T> = RpcCallSuccess<T> | RpcCallFailure;

/**
 * Try a JSON-RPC method against `providers` in order. Returns the first
 * successful reply, or a failure enumerating every attempt so the caller
 * can show useful diagnostics.
 *
 * Each provider is tried exactly once. The function does NOT retry on its
 * own beyond sequentially walking the list; callers compose that behaviour
 * via the `signal` option (e.g. an AbortSignal with a 5 s deadline).
 */
export async function rpcCallWithFallback<T = unknown>(
  providers: string[],
  method: string,
  params: unknown[],
  options: RpcCallOptions = {},
): Promise<RpcCallResult<T>> {
  const { fetcher = globalThis.fetch, signal } = options;
  if (!Array.isArray(providers) || providers.length === 0) {
    return { ok: false, attempts: [] };
  }

  const attempts: RpcCallFailure['attempts'] = [];

  for (const provider of providers) {
    const started = Date.now();
    try {
      const response = await fetcher(provider, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal,
      });

      if (!response.ok) {
        const statusCategory = httpStatusCategory(response.status);
        attempts.push({
          provider,
          latencyMs: Date.now() - started,
          error: {
            category: statusCategory?.category ?? 'network',
            retryable: statusCategory?.retryable ?? response.status >= 500,
            message: `HTTP ${response.status} ${response.statusText}`,
          },
        });
        continue;
      }

      const body = await response.json().catch(() => null);
      const latencyMs = Date.now() - started;

      if (!body || typeof body !== 'object') {
        attempts.push({
          provider,
          latencyMs,
          error: { category: 'network', retryable: true, message: 'Malformed JSON-RPC response' },
        });
        continue;
      }

      if ('error' in body && body.error) {
        const errLike = {
          ...(body.error as object),
          message: (body.error as { message?: string }).message ?? 'RPC error',
        };
        attempts.push({
          provider,
          latencyMs,
          error: classifyRpcError(errLike),
        });
        continue;
      }

      const result = (body as { result?: T }).result;
      if (result === undefined) {
        attempts.push({
          provider,
          latencyMs,
          error: { category: 'unknown', retryable: false, message: 'Response missing `result` field' },
        });
        continue;
      }

      return { ok: true, provider, result, latencyMs };
    } catch (err) {
      attempts.push({
        provider,
        latencyMs: Date.now() - started,
        error: classifyRpcError(err),
      });
      // Continue to the next provider regardless of category.
    }
  }

  return { ok: false, attempts };
}
