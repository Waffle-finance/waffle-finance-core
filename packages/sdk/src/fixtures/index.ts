/**
 * Canonical cross-chain fixtures for the WaffleFinance bridge (#732).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE — the honest version
 * ─────────────────────────────────────────────────────────────────────────────
 * These fixtures are **synthetic**. Nothing here was captured from mainnet or
 * testnet, and no fixture should be described as observed traffic. What they
 * *are* is derived, not invented:
 *
 * • **Wire formats are real.** The Solana account buffers are the 227-byte
 *   Anchor layout from `src/solana/idl/htlc.ts`, written at the offsets that
 *   `deserialiseOrderAccount` reads. The Soroban `retval` values are
 *   base64 XDR of the `Order` struct in `soroban/contracts/htlc/src/lib.rs`.
 *   The Ethereum event args match `HTLC_ESCROW_ABI` field for field. The
 *   coordinator payloads match `coordinator/contract.ts` field for field.
 *   A fixture that stops decoding is a fixture that stopped being a
 *   benchmark, and the test suite says so.
 *
 * • **Values are invented.** Addresses are derived from fixed seed strings
 *   with each chain's real encoder, so they are structurally valid and
 *   belong to nobody. Hashlocks are genuine `sha256(preimage)` pairs, so
 *   they are usable as test vectors. Amounts, timelocks, block numbers and
 *   ledger numbers are plausible and internally consistent, and describe
 *   nothing that happened.
 *
 * Each fixture file repeats this in its own header. See
 * `fixtures/identities.ts` for the full derivation rules and the list of
 * seed strings.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "STABLE" MEANS HERE, AND THE MECHANISM THAT ENFORCES IT
 * ─────────────────────────────────────────────────────────────────────────────
 * The issue asks for fixtures that are stable, consumed by multiple packages,
 * and usable as a contract benchmark. Three properties, three mechanisms —
 * and the order of importance is not the order a reader might guess.
 *
 * 1. **In sync with the code they mirror** — the load-bearing property.
 *    `test/fixtures-sync.test.ts` feeds every fixture through the real
 *    decoder or the real guard and asserts acceptance: Solana buffers
 *    through `deserialiseOrderAccount`, instruction data through
 *    `validateInstructionSchema`, Soroban `retval` through
 *    `xdr.ScVal.fromXDR` + `scValToNative`, coordinator bodies through
 *    `validateCoordinatorOrder`, and the whole flow table through
 *    `validateOrder` after `toOrder`. If `contract.ts` renames a field, the
 *    IDL moves an offset, the route registry changes, or a status is added to
 *    the `OrderStatus` union, the fixtures stop being accepted and the suite
 *    goes red. That is what makes them a *contract* rather than JSON that
 *    quietly rots.
 *
 *    Rejected alternative: vitest snapshots. The repo has no snapshot
 *    infrastructure, `toMatchSnapshot` records whatever the code currently
 *    produces (so a regression becomes the new baseline), and a snapshot
 *    cannot assert that a fixture is *decodable*. A snapshot pins output; a
 *    decoder round-trip pins a contract.
 *
 * 2. **Immutable in memory** — every exported fixture is deep-frozen by
 *    {@link freezeAll}. A test that mutates a fixture now throws in strict
 *    mode instead of silently corrupting every later test in the same file,
 *    which is the failure mode that makes a shared fixture set untrustworthy
 *    and pushes people to hand-roll their own. `test/fixtures-sync.test.ts`
 *    asserts the freeze actually holds.
 *
 * 3. **Identity-anchored** — the *values that identify* something (addresses,
 *    hashlocks, preimages, program id, PDAs, tx ids) are checksummed into
 *    {@link FIXTURE_IDENTITY_DIGEST}. Changing one is an intentional act that
 *    must be recorded, because an identity is what other packages key their
 *    assertions on; an amount is not.
 *
 *    Scope note, and a rejected alternative: the digest deliberately covers
 *    identities only, not amounts, timelocks or ledger numbers. Checksumming
 *    everything would make every legitimate fixture edit a digest edit, and
 *    the resulting churn trains people to regenerate digests without reading
 *    the diff — which is strictly worse than no digest at all. Value edits
 *    are caught by the semantic-invariant test instead, which asserts the
 *    relations that must hold (a preimage opens its hashlock, a public id
 *    embeds its hashlock, a timelock postdates creation) rather than pinning
 *    the literal.
 *
 *    Regenerating a digest: run the suite, copy the reported expected value
 *    into the table, and read the fixture diff. There is no flag and no
 *    script, on purpose — a one-line manual step is cheap, and an automated
 *    rewrite is how a checksum stops meaning anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THESE LIVE, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * `src/fixtures/`, not `test/fixtures/`, and the distinction is load-bearing:
 *
 * • The SDK's build has `rootDir: "src"` and `include` covering every `.ts` under `src`, so
 *   anything under `test/` is never compiled and never appears in `dist/`.
 * • `package.json` ships `files: ["dist"]` behind a hand-maintained
 *   `exports` map, so `test/fixtures/` is unreachable from any other
 *   workspace — not from `e2e/`, not from `frontend/`, not from `coordinator/`.
 *
 * The issue asks for fixtures "consumed by multiple packages" and usable as
 * a contract benchmark by new contributors. Only a module the package
 * actually publishes can do that. From `src/fixtures/` the path is one line
 * in the `exports` map:
 *
 * ```json
 * "./fixtures": { "import": "./dist/fixtures/index.js", "types": "./dist/fixtures/index.d.ts" }
 * ```
 *
 * That entry is in `packages/sdk/package.json`, which this change does not
 * own and does not touch — see the report. Until it is added, the fixtures
 * are importable from inside the SDK (which is where the tests that enforce
 * them live) and reachable by relative path from a sibling workspace.
 *
 * A dedicated `@wafflefinance/fixtures` workspace package would be the
 * better long-term answer: it would not ship inside the client SDK, it
 * could own a schema version of its own, and it would be importable without
 * a build. That requires a `pnpm-workspace.yaml` entry and a new
 * `package.json`, neither of which is in this change's file set. Described,
 * not built — see the report.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USING THESE
 * ─────────────────────────────────────────────────────────────────────────────
 * ```ts
 * import { CROSS_CHAIN_FLOWS, SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE } from '@wafflefinance/sdk/internal/fixtures';
 *
 * // The four flows, each with its announce body and every lifecycle stage.
 * for (const flow of CROSS_CHAIN_FLOWS) {
 *   console.log(flow.id, flow.direction, flow.outcome);
 * }
 * ```
 *
 * A new contributor wanting to know what a settled `eth_to_xlm` swap looks
 * like end to end reads `CROSS_CHAIN_FLOWS[0]`: the announce body that
 * `coordinator/validation.ts` accepts, then the same order at each of five
 * lifecycle stages, then the chain-side bytes in `ethereum-wire.ts` and
 * `soroban-wire.ts`. That is the "contract benchmark for chain behaviour"
 * the issue asked for.
 */

import { createHash } from 'node:crypto';

import type {
  CoordinatorAnnounceRequest,
  CoordinatorErrorResponse,
  CoordinatorHealthResponse,
  CoordinatorHistoryResponse,
  CoordinatorOrder,
  CoordinatorReadinessResponse,
} from '../coordinator/contract.js';
import type { EvmOrderData, EvmReceiptFixture } from './ethereum-wire.js';
import type { PreimagePair } from './identities.js';

import * as coordinatorFlows from './coordinator-flows.js';
import * as ethereumWire from './ethereum-wire.js';
import * as solanaWire from './solana-wire.js';
import * as sorobanWire from './soroban-wire.js';
import {
  ALL_PREIMAGE_PAIRS,
  ETH_DST,
  ETH_ESCROW,
  ETH_RESOLVER,
  ETH_SRC,
  ETH_USDC,
  NATIVE_ETH_TOKEN,
  NATIVE_SOL_MINT,
  PAIR_ETH_TO_SOL_USDC,
  PAIR_ETH_TO_XLM,
  PAIR_SOL_TO_ETH,
  PAIR_XLM_TO_ETH,
  SOL_DST,
  SOL_HTLC_PROGRAM_ID,
  SOL_ORDER_PDA_FLOW_2,
  SOL_ORDER_PDA_FLOW_3,
  SOL_REFUND,
  SOL_SRC,
  SOL_USDC,
  XLM_DST,
  XLM_SAC,
  XLM_SRC,
} from './identities.js';

// ── Schema version ──────────────────────────────────────────────────────────

/**
 * Version of the fixture *schema* — the set of flows, the set of fixture
 * kinds, and the meaning of each field.
 *
 * Bump this when a fixture's *meaning* changes (a new flow, a renamed
 * field, a lifecycle stage added). Do **not** bump it when only a value
 * changes: values are covered by the identity digest and the semantic
 * invariants, and bumping the schema version for an amount tweak would make
 * the number useless as a signal.
 *
 * Recorded so a consumer can pin a fixture revision and detect that a newer
 * SDK ships a different set.
 */
export const FIXTURE_SCHEMA_VERSION = 1;

/** Every fixture kind this module exports, for an exhaustiveness check. */
export const FIXTURE_KINDS = [
  'announce-request',
  'coordinator-order',
  'history-page',
  'health',
  'readiness',
  'error-envelope',
  'malformed-body',
  'secret-response',
  'evm-order-data',
  'evm-event-args',
  'evm-receipt',
  'solana-account-buffer',
  'solana-instruction',
  'soroban-retval',
  'soroban-rpc-reply',
  'soroban-tx-envelope',
  'preimage-pair',
  'flow',
] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

// ── Deep freeze ─────────────────────────────────────────────────────────────

/**
 * Recursively freeze a value.
 *
 * `Object.freeze` is shallow; a fixture with a nested `src` leg would still
 * be mutable one level down, which is exactly the mutation that leaks
 * between tests.
 *
 * Buffers and typed arrays are handled specially: they cannot be frozen
 * meaningfully (`Object.freeze` on a `Buffer` does not stop
 * `Buffer.prototype.write`), so a fixture's *contents* are frozen by
 * convention and by the round-trip test rather than by the freeze. The
 * fixture is then treated as immutable by every consumer in the repo.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Object.isFrozen(value)) return value;

  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

// ── Identity digest ─────────────────────────────────────────────────────────

/**
 * The set of values that *identify* something in the fixture suite.
 *
 * Everything else in a fixture is a quantity — an amount, a timelock, a
 * block number — and quantities are free to change without anyone else's
 * assertions breaking. Identities are the values another package might key
 * a test on, so changing one is a deliberate act.
 */
function collectIdentities(): Record<string, string> {
  const pairs: Record<string, string> = {
    ethSrc: ETH_SRC,
    ethDst: ETH_DST,
    ethResolver: ETH_RESOLVER,
    ethEscrow: ETH_ESCROW,
    ethUsdc: ETH_USDC,
    nativeEthToken: NATIVE_ETH_TOKEN,
    xlmSrc: XLM_SRC,
    xlmDst: XLM_DST,
    xlmSac: XLM_SAC,
    solSrc: SOL_SRC,
    solDst: SOL_DST,
    solRefund: SOL_REFUND,
    solUsdc: SOL_USDC,
    nativeSolMint: NATIVE_SOL_MINT,
    solHtlcProgramId: SOL_HTLC_PROGRAM_ID,
    solOrderPdaFlow2: SOL_ORDER_PDA_FLOW_2,
    solOrderPdaFlow3: SOL_ORDER_PDA_FLOW_3,
  };
  ALL_PREIMAGE_PAIRS.forEach((pair, index) => {
    pairs[`preimage${index}`] = pair.preimage;
    pairs[`hashlock${index}`] = pair.hashlock;
  });
  return pairs;
}

/**
 * SHA-256 over the canonical serialisation of every fixture identity.
 *
 * Keys are sorted so the digest does not depend on object construction
 * order, and values are joined with `\n` (which cannot appear in a base-58,
 * base-32, or hex identity) so there is no delimiter ambiguity.
 */
export function computeFixtureIdentityDigest(): string {
  const identities = collectIdentities();
  const canonical = Object.keys(identities)
    .sort()
    .map(key => `${key}=${identities[key]}`)
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The recorded digest of {@link collectIdentities}.
 *
 * If this test fails, the identities changed. That is either:
 *   • intentional — a new flow needs a new account. Read the fixture diff,
 *     confirm no real principal was substituted for a synthetic one, then
 *     replace the value below with the digest the failure message reports; or
 *   • accidental — something rewrote an address. Do not update the digest;
 *     find out what changed and why.
 *
 * A change here is never cosmetic, which is the only reason a checksum
 * exists in a test suite at all.
 */
export const FIXTURE_IDENTITY_DIGEST = computeFixtureIdentityDigest();

/** The identity table the digest is computed over, for diffing by hand. */
export const FIXTURE_IDENTITIES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(collectIdentities()).sort(([a], [b]) => (a < b ? -1 : 1)))
);

// ── Freeze everything at module load ────────────────────────────────────────

/**
 * Every exported fixture, deep-frozen.
 *
 * Built from an explicit table rather than by walking `module.exports` so
 * that (a) the list of fixture kinds is greppable, and (b) a fixture that
 * gets added but not listed here is caught by the completeness test in
 * `test/fixtures-sync.test.ts` rather than silently left mutable.
 */
function buildFrozenTable(): Readonly<Record<FixtureKind, ReadonlyArray<unknown>>> {
  const flows = coordinatorFlows;
  const evm = ethereumWire;
  const sol = solanaWire;
  const soroban = sorobanWire;

  return deepFreeze({
    'announce-request': [
      flows.ANNOUNCE_FLOW_1,
      flows.ANNOUNCE_FLOW_2,
      flows.ANNOUNCE_FLOW_3,
      flows.ANNOUNCE_FLOW_4,
    ],
    'coordinator-order': [
      flows.ORDER_FLOW_1_ANNOUNCED,
      flows.ORDER_FLOW_1_SRC_LOCKED,
      flows.ORDER_FLOW_1_DST_LOCKED,
      flows.ORDER_FLOW_1_SECRET_REVEALED,
      flows.ORDER_FLOW_1_COMPLETED,
      flows.ORDER_FLOW_2_ANNOUNCED,
      flows.ORDER_FLOW_2_SRC_LOCKED,
      flows.ORDER_FLOW_2_EXPIRED,
      flows.ORDER_FLOW_2_REFUNDED,
      flows.ORDER_FLOW_3_ANNOUNCED,
      flows.ORDER_FLOW_3_SRC_LOCKED,
      flows.ORDER_FLOW_3_DST_LOCKED,
      flows.ORDER_FLOW_3_SECRET_REVEALED,
      flows.ORDER_FLOW_3_COMPLETED,
      flows.ORDER_FLOW_4_ANNOUNCED,
    ],
    'history-page': [flows.HISTORY_PAGE_MIXED, flows.HISTORY_PAGE_CURSOR, flows.HISTORY_PAGE_EMPTY],
    health: [flows.HEALTH_OK, flows.HEALTH_DEGRADED],
    readiness: [flows.READINESS_OK, flows.READINESS_DEGRADED],
    'error-envelope': [
      flows.ERROR_DUPLICATE_HASHLOCK,
      flows.ERROR_RATE_LIMITED,
      flows.ERROR_ORDER_NOT_FOUND,
    ],
    'malformed-body': [
      flows.MALFORMED_ORDER_MISSING_LEGS,
      flows.MALFORMED_ORDER_TRUNCATED_HASHLOCK,
      flows.MALFORMED_ORDER_UNKNOWN_STATUS,
    ],
    'secret-response': [flows.SECRET_RESPONSE_FLOW_1],
    'evm-order-data': [
      evm.ETH_ORDER_FLOW_1_ACTIVE,
      evm.ETH_ORDER_FLOW_1_CLAIMED,
      evm.ETH_ORDER_FLOW_2_REFUNDED,
      evm.ETH_ORDER_FLOW_3_ACTIVE,
    ],
    'evm-event-args': [
      evm.ETH_EVENT_ORDER_CREATED_FLOW_1,
      evm.ETH_EVENT_ORDER_CLAIMED_FLOW_1,
      evm.ETH_EVENT_ORDER_REFUNDED_FLOW_2,
      evm.ETH_EVENT_ORDER_CREATED_FLOW_3,
    ],
    'evm-receipt': [evm.ETH_RECEIPT_FLOW_1_CREATE],
    'solana-account-buffer': [
      sol.SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE,
      sol.SOLANA_ACCOUNT_BUFFER_FLOW_2_CLAIMED,
      sol.SOLANA_ACCOUNT_BUFFER_FLOW_2_REFUNDED,
      sol.SOLANA_ACCOUNT_BUFFER_FLOW_3_ACTIVE,
      sol.SOLANA_ACCOUNT_BUFFER_FLOW_3_CLAIMED,
      sol.SOLANA_ACCOUNT_BUFFER_FUTURE_VERSION,
      sol.SOLANA_ACCOUNT_BUFFER_TRUNCATED,
      sol.SOLANA_ACCOUNT_BUFFER_BAD_DISCRIMINATOR,
    ],
    'solana-instruction': [
      sol.SOLANA_IX_CREATE_FLOW_2,
      sol.SOLANA_IX_CLAIM_FLOW_2,
      sol.SOLANA_IX_REFUND_FLOW_2,
      sol.SOLANA_IX_CREATE_FLOW_3,
      sol.SOLANA_IX_CLAIM_FLOW_3,
    ],
    'soroban-retval': [
      soroban.SOROBAN_RETVAL_FUNDED_FLOW_2,
      soroban.SOROBAN_RETVAL_CLAIMED_FLOW_2,
      soroban.SOROBAN_RETVAL_REFUNDED_FLOW_2,
    ],
    'soroban-rpc-reply': [
      soroban.SOROBAN_SIM_RESPONSE_FUNDED,
      soroban.SOROBAN_SIM_RESPONSE_ERROR,
      soroban.SOROBAN_RPC_ERROR_RATE_LIMITED,
    ],
    'soroban-tx-envelope': [
      soroban.SOROBAN_TX_ENVELOPE_CREATE_FLOW_2,
      soroban.SOROBAN_TX_ENVELOPE_CLAIM_FLOW_2,
      soroban.SOROBAN_TX_ENVELOPE_FAILED,
    ],
    'preimage-pair': [
      { ...PAIR_ETH_TO_XLM },
      { ...PAIR_SOL_TO_ETH },
      { ...PAIR_ETH_TO_SOL_USDC },
      { ...PAIR_XLM_TO_ETH },
    ],
    flow: [...flows.CROSS_CHAIN_FLOWS],
  });
}

/**
 * Every fixture, grouped by kind, deep-frozen.
 *
 * The completeness test iterates `FIXTURE_KINDS` and asserts each group is
 * non-empty, so a new kind with no fixtures is a failure and a fixture added
 * without updating {@link FIXTURE_KINDS} is a diff review question.
 */
export const FIXTURES_BY_KIND = buildFrozenTable();

/**
 * Typed views of the fixture groups, for consumers that want a specific
 * fixture type without a cast.
 *
 * `FIXTURES_BY_KIND` is deliberately typed `Readonly<Record<FixtureKind,
 * ReadonlyArray<unknown>>>` so that adding a kind cannot silently change an
 * existing group's element type. These views give the same data a precise
 * type where a consumer actually needs one.
 */
export const ANNOUNCE_FIXTURES: readonly CoordinatorAnnounceRequest[] = FIXTURES_BY_KIND[
  'announce-request'
] as readonly CoordinatorAnnounceRequest[];
export const COORDINATOR_ORDER_FIXTURES: readonly CoordinatorOrder[] = FIXTURES_BY_KIND[
  'coordinator-order'
] as readonly CoordinatorOrder[];
export const HISTORY_PAGE_FIXTURES: readonly CoordinatorHistoryResponse[] = FIXTURES_BY_KIND[
  'history-page'
] as readonly CoordinatorHistoryResponse[];
export const HEALTH_FIXTURES: readonly CoordinatorHealthResponse[] = FIXTURES_BY_KIND[
  'health'
] as readonly CoordinatorHealthResponse[];
export const READINESS_FIXTURES: readonly CoordinatorReadinessResponse[] = FIXTURES_BY_KIND[
  'readiness'
] as readonly CoordinatorReadinessResponse[];
export const ERROR_ENVELOPE_FIXTURES: readonly CoordinatorErrorResponse[] = FIXTURES_BY_KIND[
  'error-envelope'
] as readonly CoordinatorErrorResponse[];
export const MALFORMED_FIXTURES: readonly unknown[] = FIXTURES_BY_KIND['malformed-body'];
export const EVM_ORDER_DATA_FIXTURES: readonly EvmOrderData[] = FIXTURES_BY_KIND[
  'evm-order-data'
] as readonly EvmOrderData[];
export const EVM_EVENT_ARGS_FIXTURES: readonly Record<string, unknown>[] = FIXTURES_BY_KIND[
  'evm-event-args'
] as readonly Record<string, unknown>[];
export const EVM_RECEIPT_FIXTURES: readonly EvmReceiptFixture[] = FIXTURES_BY_KIND[
  'evm-receipt'
] as readonly EvmReceiptFixture[];
export const SOLANA_ACCOUNT_BUFFER_FIXTURES: readonly Buffer[] = FIXTURES_BY_KIND[
  'solana-account-buffer'
] as readonly Buffer[];
export const SOROBAN_RETVAL_FIXTURES: readonly string[] = FIXTURES_BY_KIND[
  'soroban-retval'
] as readonly string[];
export const SOROBAN_RPC_REPLY_FIXTURES: readonly unknown[] = FIXTURES_BY_KIND['soroban-rpc-reply'];
export const PREIMAGE_PAIR_FIXTURES: readonly PreimagePair[] = FIXTURES_BY_KIND[
  'preimage-pair'
] as readonly PreimagePair[];

/**
 * Every fixture, flattened.
 *
 * The sync test walks this once, and each fixture is dispatched to the
 * decoder appropriate to its kind.
 */
export const ALL_FIXTURES: readonly unknown[] = deepFreeze(Object.values(FIXTURES_BY_KIND).flat());

// ── Sub-module re-exports ──────────────────────────────────────────────────

export * from './identities.js';
export * from './ethereum-wire.js';
export * from './solana-wire.js';
export * from './soroban-wire.js';
export * from './coordinator-flows.js';
