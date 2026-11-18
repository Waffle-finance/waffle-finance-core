/**
 * Runtime guards for chain RPC payloads (#733).
 *
 * The boundaries
 * ──────────────
 * Three different transports carry data the SDK then treats as typed:
 *
 * 1. **Ethereum JSON-RPC.** `shared-utils/rpc-compat.ts`'s
 *    `rpcCallWithFallback` already checks that a reply is an object, that it
 *    carries an `error` member, and that it carries a `result`. It stops
 *    there: `result` is returned as an untyped `T` and a caller that asked
 *    for a transaction receipt gets whatever the provider sent. It also
 *    does not validate that a *successful* reply is JSON-RPC 2.0 — a proxy
 *    returning `{"jsonrpc":"1.0","result":{}}` sails through.
 *
 * 2. **Solana RPC.** `solana/index.ts` does
 *    `Buffer.from(info.data)` on the result of `getAccountInfo`, and
 *    `deserialiseOrderAccount` then indexes into it. A provider that returns
 *    `data: "0x00"` (some do, for a zero-length account) or a
 *    `context`-less envelope turns into a confusing "account data too
 *    small" or a `Buffer.from` on a string.
 *
 * 3. **Soroban RPC.** `soroban/index.ts` reads `(sim as any).result` and
 *    then `result.retval`, with no check that the envelope is a successful
 *    simulation. See the report: on a real `SimulateTransactionResponse`,
 *    `retval` is a **base64 XDR string**, but the SDK passes it straight to
 *    `scValToNative`, which expects an `ScVal`. That is a live defect in
 *    `soroban/index.ts` — outside this agent's file boundary, so it is
 *    reported rather than fixed. {@link decodeSorobanRetval} below is the
 *    correct decode, and the fixtures in `fixtures/soroban-wire.ts` are
 *    byte-exact base64 XDR so the test suite pins the correct behaviour.
 *
 * Relationship to `rpc-compat.ts`
 * ───────────────────────────────
 * This module is the *shape* layer that `rpc-compat.ts` deliberately does not
 * cover. `classifyRpcError` answers "what kind of failure is this, and
 * should I retry"; these guards answer "is this a success payload of the
 * shape I asked for". They compose: on the error path, use
 * `classifyRpcError`; on the success path, use a guard from here. The error
 * taxonomy is not duplicated here.
 */

import { classifyRpcError, type RpcError } from '../shared-utils/rpc-compat.js';
import { assertGuard, GuardIssueCollector, type GuardResult } from './result.js';

// ── JSON-RPC 2.0 envelope ───────────────────────────────────────────────────

/** A JSON-RPC 2.0 success reply, as a *verified* type. */
export interface JsonRpcSuccess<T> {
  /** Discriminant: `false` on a success reply. See {@link JsonRpcReply}. */
  readonly isError: false;
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly result: T;
}

/** A JSON-RPC 2.0 error reply, as a *verified* type. */
export interface JsonRpcFailure {
  /** Discriminant: `true` on an error reply. See {@link JsonRpcReply}. */
  readonly isError: true;
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
  /** Normalised failure, from the SDK's existing `rpc-compat` taxonomy. */
  readonly classified: RpcError;
}

/**
 * A verified JSON-RPC reply.
 *
 * Discriminated on `isError` rather than on the presence of an `error` key:
 * a `result` of `null` is legal, and `error: null` appears on some servers, so
 * key presence is not a reliable narrowing. `isError` is set by this module
 * and carries no wire cost.
 */
export type JsonRpcReply<T> = JsonRpcSuccess<T> | JsonRpcFailure;

/** Canonical base64, as every JSON-RPC / Soroban XDR payload uses. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify a JSON-RPC 2.0 reply envelope.
 *
 * A body carrying `error` is a *failure*, and is returned in the failure arm
 * with `classified` already populated by `classifyRpcError` — so a caller
 * never has to branch on the raw provider error twice.
 */
export function validateJsonRpcReply(input: unknown): GuardResult<JsonRpcReply<unknown>> {
  const issues = new GuardIssueCollector();

  if (!isRecord(input)) {
    return issues
      .add('rpc', 'JSON-RPC reply must be a JSON object')
      .finish(undefined as unknown as JsonRpcReply<unknown>);
  }

  if (input['jsonrpc'] !== '2.0') {
    issues.add('rpc.jsonrpc', `must be the string "2.0" (got ${JSON.stringify(input['jsonrpc'])})`);
  }

  const id = input['id'];
  if (id !== null && typeof id !== 'number' && typeof id !== 'string') {
    issues.add('rpc.id', 'must be a number, a string, or null');
  }

  const error = input['error'];
  if (error !== undefined && error !== null) {
    if (!isRecord(error)) {
      issues.add('rpc.error', 'must be an object when present');
    } else {
      if (typeof error['code'] !== 'number') issues.add('rpc.error.code', 'must be a number');
      if (typeof error['message'] !== 'string') issues.add('rpc.error.message', 'must be a string');
    }
  }

  if (!('result' in input) && error === undefined) {
    issues.add('rpc', 'reply must carry exactly one of `result` or `error`');
  }
  if ('result' in input && error !== undefined && error !== null) {
    issues.add('rpc', 'reply must not carry both `result` and `error`');
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };

  if (error !== undefined && error !== null && isRecord(error)) {
    const classified = classifyRpcError({
      ...error,
      message: String(error['message'] ?? 'RPC error'),
    });
    return {
      ok: true,
      value: {
        isError: true as const,
        jsonrpc: '2.0' as const,
        id: (id ?? null) as number | string | null,
        error: error as { code: number; message: string; data?: unknown },
        classified,
      },
    };
  }

  return {
    ok: true,
    value: {
      isError: false as const,
      jsonrpc: '2.0' as const,
      id: (id ?? null) as number | string | null,
      result: input['result'],
    },
  };
}

// ── EVM logs ────────────────────────────────────────────────────────────────

/** One verified `eth_getLogs` entry, as produced by a standard EVM node. */
export interface EvmLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly removed: boolean;
}

/**
 * Verify a single `eth_getLogs` entry.
 *
 * `removed: true` is legal and meaningful — it is how a node signals a log
 * from a reorged block — so it is checked, not rejected.
 */
export function validateEvmLog(input: unknown): GuardResult<EvmLog> {
  const issues = new GuardIssueCollector();
  if (!isRecord(input)) {
    return issues.add('log', 'log must be a JSON object').finish(undefined as unknown as EvmLog);
  }

  const address = input['address'];
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    issues.add('log.address', 'must be a 0x-prefixed 20-byte address');
  }

  const topics = input['topics'];
  if (
    !Array.isArray(topics) ||
    topics.some(t => typeof t !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(t))
  ) {
    issues.add('log.topics', 'must be an array of 0x-prefixed 32-byte hex strings');
  }

  const data = input['data'];
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    issues.add('log.data', 'must be a 0x-prefixed, even-length hex string');
  }

  const txHash = input['transactionHash'];
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    issues.add('log.transactionHash', 'must be a 0x-prefixed 32-byte transaction hash');
  }

  const logIndex = input['logIndex'];
  if (typeof logIndex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(logIndex)) {
    // Standard nodes return logIndex hex-encoded; some return a number.
    if (typeof logIndex !== 'number' || !Number.isInteger(logIndex)) {
      issues.add('log.logIndex', 'must be a hex string or an integer');
    }
  }

  const blockNumber = input['blockNumber'];
  if (
    blockNumber !== null &&
    (typeof blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(blockNumber))
  ) {
    issues.add('log.blockNumber', 'must be a hex string or null');
  }

  const blockHash = input['blockHash'];
  if (
    blockHash !== null &&
    (typeof blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(blockHash))
  ) {
    issues.add('log.blockHash', 'must be a 0x-prefixed 32-byte hash or null');
  }

  const removed = input['removed'];
  if (typeof removed !== 'boolean') {
    issues.add('log.removed', 'must be a boolean');
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };
  return { ok: true, value: input as unknown as EvmLog };
}

// ── Solana account info ─────────────────────────────────────────────────────

/** A verified `getAccountInfo` envelope. */
export interface SolanaAccountInfo {
  readonly executable: boolean;
  readonly owner: string;
  /** Raw account bytes. Never a hex string, never absent. */
  readonly data: Uint8Array;
  readonly lamports: number;
  readonly rentEpoch?: number;
  readonly space: number;
}

/**
 * Verify a `getAccountInfo` result.
 *
 * The important part is `data`. `solana/index.ts` calls
 * `Buffer.from(info.data)` unconditionally, and `Buffer.from` on a hex
 * *string* silently produces the UTF-8 bytes of that string rather than
 * throwing — so a provider that base64- or hex-encodes `data` yields a
 * plausible-looking buffer of the wrong length and the failure shows up
 * three frames later as "account data too small". This guard rejects any
 * `data` that is not a byte array or a numeric array.
 */
export function validateSolanaAccountInfo(
  input: unknown,
  path = 'info'
): GuardResult<SolanaAccountInfo> {
  const issues = new GuardIssueCollector();
  if (!isRecord(input)) {
    return issues
      .add(path, 'account info must be a JSON object')
      .finish(undefined as unknown as SolanaAccountInfo);
  }

  if (typeof input['executable'] !== 'boolean') {
    issues.add(`${path}.executable`, 'must be a boolean');
  }

  const owner = input['owner'];
  if (typeof owner !== 'string' || owner.length === 0) {
    issues.add(`${path}.owner`, 'must be a non-empty base-58 account id');
  }

  const data = input['data'];
  if (data instanceof Uint8Array) {
    // Acceptable: the raw byte array every standard node returns.
  } else if (
    Array.isArray(data) &&
    data.every(b => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    // Acceptable: a JSON round-trip of the byte array.
  } else {
    issues.add(
      `${path}.data`,
      'must be a byte array (Uint8Array or array of 0-255 integers); a base64/hex string is not accepted'
    );
  }

  const lamports = input['lamports'];
  if (typeof lamports !== 'number' || !Number.isInteger(lamports) || lamports < 0) {
    issues.add(`${path}.lamports`, 'must be a non-negative integer');
  }

  const rentEpoch = input['rentEpoch'];
  if (rentEpoch !== undefined && rentEpoch !== null) {
    if (typeof rentEpoch !== 'number' || !Number.isInteger(rentEpoch)) {
      issues.add(`${path}.rentEpoch`, 'must be an integer when present');
    }
  }

  // Unknown keys are deliberately allowed: providers add fields, and the
  // wire contract in `solana/index.ts` reads only `data`. What must not
  // happen is a *rename*, which is why every key the SDK actually reads is
  // required above.

  if (issues.length > 0) return { ok: false, issues: issues.list() };

  const bytes = data instanceof Uint8Array ? data : (data as number[]);
  const space =
    typeof input['space'] === 'number' && Number.isInteger(input['space'])
      ? input['space']
      : bytes.length;

  return {
    ok: true,
    value: {
      executable: input['executable'] as boolean,
      owner: owner as string,
      data: Uint8Array.from(bytes),
      lamports: lamports as number,
      ...(typeof rentEpoch === 'number' ? { rentEpoch } : {}),
      space,
    },
  };
}

/**
 * Verify a `getMultipleAccounts` / `getProgramAccounts` result array.
 *
 * `null` entries mean "this account does not exist" and are preserved as
 * `null` rather than being coerced to an empty buffer — the distinction
 * matters because "no order here" and "an order with no data here" are
 * different answers.
 */
export function validateSolanaAccountInfoList(
  input: unknown
): GuardResult<ReadonlyArray<SolanaAccountInfo | null>> {
  const issues = new GuardIssueCollector();
  if (!Array.isArray(input)) {
    return issues
      .add('accounts', 'must be an array')
      .finish(undefined as unknown as ReadonlyArray<SolanaAccountInfo | null>);
  }
  const out: Array<SolanaAccountInfo | null> = [];
  input.forEach((entry, index) => {
    if (entry === null) {
      out.push(null);
      return;
    }
    // The path prefix is threaded into the single-account guard rather than
    // prepended afterwards, so an issue is reported once at
    // `accounts[i].field` and never double-prefixed.
    const result = validateSolanaAccountInfo(entry, `accounts[${index}]`);
    if (result.ok) {
      out.push(result.value);
    } else {
      for (const issue of result.issues) issues.add(issue.field, issue.message);
    }
  });
  return issues.finish(out);
}

// ── Soroban simulation ──────────────────────────────────────────────────────

/** A verified `simulateTransaction` success envelope. */
export interface SorobanSimulationSuccess {
  readonly status: 'SUCCESS';
  /** Base64 XDR of the `ScVal` return value. */
  readonly retval: string;
  readonly cost: SorobanSimulationCost;
  readonly latestLedger: number;
  readonly oldestLedger: number;
  readonly latestLedgerCloseTime: number;
}

/** A verified `simulateTransaction` error envelope. */
export interface SorobanSimulationFailure {
  readonly status: 'ERROR';
  readonly error: string;
  readonly events: readonly unknown[];
}

export interface SorobanSimulationCost {
  readonly cpuInsns: string;
  readonly memBytes: string;
}

/**
 * Verify a `soroban/rpc` `simulateTransaction` result.
 *
 * `soroban/index.ts` currently does:
 *
 * ```ts
 * const result = (sim as any).result;
 * if (!result || !result.retval) return null;
 * return scValToNative(result.retval);
 * ```
 *
 * Two problems, both of which this guard is shaped to prevent:
 *   • `result.retval` is never checked to be the base64 XDR string it is on a
 *     real node, and `scValToNative` needs an `ScVal`, not a string.
 *   • `status: "ERROR"` is never consulted, so a failed simulation with a
 *     `result` block is indistinguishable from a success.
 *
 * The failure arm keeps `events` because that is where the contract's
 * diagnostic events land and operators need them in the error.
 */
export function validateSorobanSimulation(
  input: unknown
): GuardResult<SorobanSimulationSuccess | SorobanSimulationFailure> {
  const issues = new GuardIssueCollector();
  if (!isRecord(input)) {
    return issues
      .add('sim', 'simulation result must be a JSON object')
      .finish(undefined as unknown as SorobanSimulationSuccess);
  }

  const status = input['status'];
  if (status !== 'SUCCESS' && status !== 'ERROR') {
    issues.add('sim.status', `must be "SUCCESS" or "ERROR" (got ${JSON.stringify(status)})`);
  }

  if (status === 'SUCCESS') {
    const retval = input['retval'];
    if (typeof retval !== 'string') {
      issues.add('sim.retval', 'must be a base64 XDR string of an ScVal');
    } else if (retval.length === 0) {
      issues.add('sim.retval', 'must not be empty; a void ScVal is still base64 XDR');
    } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(retval)) {
      issues.add('sim.retval', 'must be valid base64');
    }
    const cost = input['cost'];
    if (!isRecord(cost)) {
      issues.add('sim.cost', 'must be an object on a successful simulation');
    } else {
      for (const key of ['cpuInsns', 'memBytes'] as const) {
        const value = cost[key];
        if (typeof value !== 'string' || !/^\d+$/.test(value)) {
          issues.add(`sim.cost.${key}`, 'must be a decimal string');
        }
      }
    }
    for (const key of ['latestLedger', 'oldestLedger', 'latestLedgerCloseTime'] as const) {
      const value = input[key];
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        issues.add(`sim.${key}`, 'must be an integer');
      }
    }
  }

  if (status === 'ERROR') {
    if (typeof input['error'] !== 'string') {
      issues.add('sim.error', 'must be a string when status is ERROR');
    }
    if (!Array.isArray(input['events'])) {
      issues.add('sim.events', 'must be an array when status is ERROR');
    }
  }

  if (issues.length > 0) return { ok: false, issues: issues.list() };

  if (status === 'ERROR') {
    return {
      ok: true,
      value: {
        status: 'ERROR',
        error: input['error'] as string,
        events: (input['events'] as unknown[]) ?? [],
      },
    };
  }

  return {
    ok: true,
    value: {
      status: 'SUCCESS',
      retval: input['retval'] as string,
      cost: {
        cpuInsns: (input['cost'] as Record<string, unknown>)['cpuInsns'] as string,
        memBytes: (input['cost'] as Record<string, unknown>)['memBytes'] as string,
      },
      latestLedger: input['latestLedger'] as number,
      oldestLedger: input['oldestLedger'] as number,
      latestLedgerCloseTime: input['latestLedgerCloseTime'] as number,
    },
  };
}

/**
 * Decode a Soroban simulation's `retval` into its native JS value.
 *
 * `retval` is base64 XDR. `xdr.ScVal.fromXDR` needs `@stellar/stellar-sdk`,
 * which this module does not import so that it stays dependency-light for
 * consumers that only need the EVM guards. Pass the decoder in:
 *
 * ```ts
 * const sim = assertSorobanSimulation(raw);
 * if (sim.status === 'SUCCESS') {
 *   const order = decodeSorobanRetval(sim.retval, xdr.ScVal.fromXDR, scValToNative);
 * }
 * ```
 *
 * `soroban/index.ts` should use this rather than `scValToNative(retval)`;
 * see the report for why that call cannot work as written.
 */
export function decodeSorobanRetval(
  retval: string,
  fromXdr: (base64: string, format: 'base64') => unknown,
  toNative: (scval: never) => unknown
): unknown {
  if (typeof retval !== 'string' || !BASE64.test(retval)) {
    throw new Error(
      'Soroban simulation retval is not a base64 XDR string; decode it with xdr.ScVal.fromXDR(value, "base64") before calling scValToNative'
    );
  }
  return toNative(fromXdr(retval, 'base64') as never);
}

// ── Assertion forms ─────────────────────────────────────────────────────────

export function assertJsonRpcReply(input: unknown): JsonRpcReply<unknown> {
  return assertGuard(validateJsonRpcReply(input), 'JSON-RPC reply');
}

export function assertEvmLog(input: unknown): EvmLog {
  return assertGuard(validateEvmLog(input), 'EVM log');
}

export function assertSolanaAccountInfo(input: unknown): SolanaAccountInfo {
  return assertGuard(validateSolanaAccountInfo(input), 'Solana account info');
}

export function assertSorobanSimulation(
  input: unknown
): SorobanSimulationSuccess | SorobanSimulationFailure {
  return assertGuard(validateSorobanSimulation(input), 'Soroban simulation result');
}
