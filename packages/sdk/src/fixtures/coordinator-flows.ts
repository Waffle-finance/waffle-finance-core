/**
 * SYNTHETIC coordinator wire fixtures for four cross-chain flows (#732).
 *
 * PROVENANCE
 * ───────────
 * The *shapes* are the real `coordinator/contract.ts` wire contract, field
 * for field, including the `null`-not-`undefined` convention for
 * `orderId` / `lockTx` / `lockBlock` / `timelock` and the `wf_0x<64 hex>`
 * public-id format. If that contract changes, `guards/coordinator-response.ts`
 * and these fixtures disagree and `test/fixtures-sync.test.ts` fails.
 *
 * The *values* are synthetic. No coordinator was queried; nothing here was
 * captured. See `fixtures/identities.ts` for how every address, hashlock,
 * preimage and transaction id is derived.
 *
 * Why these exist alongside `test/fixtures/coordinator-responses.ts`
 * ────────────────────────────────────────────────────────────────
 * That file already holds unit-level coordinator payloads. The difference
 * is intent and location:
 *
 * • `test/fixtures/` is **test-only** — under the SDK's `test/` directory it
 *   is not compiled, not published, and unreachable from `e2e/`, the
 *   frontend, or the coordinator.
 * • `src/fixtures/` **is** compiled into `dist/` and is therefore reachable
 *   from any workspace as `@wafflefinance/sdk/internal/fixtures`, once an `exports`
 *   subpath is added (that entry lives in `package.json`, which this change
 *   does not touch — see the report). That is what makes the fixtures a
 *   *contract benchmark* for new contributors and for other packages,
 *   rather than a private convenience.
 *
 * So `test/fixtures/coordinator-responses.ts` stays as the unit-level
 * helper for the existing coordinator tests, and this file is the
 * cross-package, cross-chain, whole-flow reference.
 *
 * Coverage: four flows across the four lifecycle stages the issue names.
 *
 *   | Flow | Direction     | Stages                                  |
 *   | ---- | ------------- | --------------------------------------- |
 *   | 1    | eth_to_xlm    | announced → src_locked → dst_locked → secret_revealed → completed |
 *   | 2    | sol_to_eth    | announced → src_locked → expired → refunded |
 *   | 3    | eth_to_sol    | announced → src_locked → dst_locked → secret_revealed → completed |
 *   | 4    | xlm_to_eth    | announced (creation only)                |
 *
 * Amounts are decimal strings in atomic units. ETH is 18 decimals, XLM 7,
 * SOL 9, USDC 6.
 */

import { orderIdFromHashlock, ORDER_ID_PREFIX } from '../shared-utils/index.js';
import type {
  CoordinatorAnnounceRequest,
  CoordinatorChainLeg,
  CoordinatorErrorResponse,
  CoordinatorHealthResponse,
  CoordinatorHistoryResponse,
  CoordinatorOrder,
  CoordinatorReadinessResponse,
  CoordinatorSecretResponse,
} from '../coordinator/contract.js';
import { HTLC_ORDER_ACCOUNT_SIZE } from '../solana/idl/htlc.js';
import { SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE } from './solana-wire.js';
import { FIXTURE_EPOCH } from './ethereum-wire.js';
import {
  ETH_DST,
  ETH_RESOLVER,
  ETH_SRC,
  ETH_TX_CREATE,
  ETH_USDC,
  NATIVE_SOL_MINT,
  NATIVE_ETH_TOKEN,
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
  SOL_TX_CLAIM,
  SOL_TX_REFUND,
  SOL_USDC,
  SOROBAN_CONTRACT_ORDER_ID,
  XLM_DST,
  XLM_SRC,
  XLM_TX_CLAIM,
  XLM_TX_CREATE,
} from './identities.js';

// ── Leg builders ────────────────────────────────────────────────────────────

/** A leg that has not been funded yet. */
function unlockedLeg(
  chain: CoordinatorChainLeg['chain'],
  address: string,
  asset: string,
  amount: string,
  safetyDeposit?: string
): CoordinatorChainLeg {
  return {
    chain,
    address,
    asset,
    amount,
    ...(safetyDeposit === undefined ? {} : { safetyDeposit }),
    orderId: null,
    lockTx: null,
    lockBlock: null,
    timelock: null,
  };
}

/** A leg that has been funded on-chain. */
function lockedLeg(
  base: CoordinatorChainLeg,
  orderId: string,
  lockTx: string,
  timelock: number,
  lockBlock: number | null
): CoordinatorChainLeg {
  return { ...base, orderId, lockTx, lockBlock, timelock };
}

// ── Flow 1: eth_to_xlm, native, settles and claims ──────────────────────────

/** The `POST /api/orders/announce` body for flow 1. */
export const ANNOUNCE_FLOW_1: CoordinatorAnnounceRequest = {
  direction: 'eth_to_xlm',
  hashlock: PAIR_ETH_TO_XLM.hashlock,
  srcChain: 'ethereum',
  srcAddress: ETH_SRC,
  srcAsset: 'native',
  srcAmount: '1000000000000000000',
  srcSafetyDeposit: '1000000000000000',
  dstChain: 'stellar',
  dstAddress: XLM_DST,
  dstAsset: 'native',
  dstAmount: '100000000',
};

/** Flow 1, stage 1: announced. Neither leg locked. */
export const ORDER_FLOW_1_ANNOUNCED: CoordinatorOrder = {
  id: ORDER_ID_PREFIX + PAIR_ETH_TO_XLM.hashlock,
  direction: 'eth_to_xlm',
  status: 'announced',
  hashlock: PAIR_ETH_TO_XLM.hashlock,
  src: unlockedLeg('ethereum', ETH_SRC, 'native', '1000000000000000000', '1000000000000000'),
  dst: unlockedLeg('stellar', XLM_DST, 'native', '100000000'),
  secret: { revealed: false, preimage: null, revealedTx: null },
  resolver: null,
  createdAt: FIXTURE_EPOCH,
  updatedAt: FIXTURE_EPOCH,
};

/** Flow 1, stage 2: the Ethereum source leg is locked. */
export const ORDER_FLOW_1_SRC_LOCKED: CoordinatorOrder = {
  ...ORDER_FLOW_1_ANNOUNCED,
  status: 'src_locked',
  src: lockedLeg(ORDER_FLOW_1_ANNOUNCED.src, '1', ETH_TX_CREATE, FIXTURE_EPOCH + 3_600, 21_000_000),
  updatedAt: FIXTURE_EPOCH + 45,
};

const ORDER_FLOW_1_DST_LEG_BASE = ORDER_FLOW_1_ANNOUNCED.dst;

/** Flow 1, stage 3: a resolver has filled the Stellar destination leg. */
export const ORDER_FLOW_1_DST_LOCKED: CoordinatorOrder = {
  ...ORDER_FLOW_1_SRC_LOCKED,
  status: 'dst_locked',
  dst: lockedLeg(
    ORDER_FLOW_1_DST_LEG_BASE,
    SOROBAN_CONTRACT_ORDER_ID,
    XLM_TX_CREATE,
    FIXTURE_EPOCH + 3_000,
    null
  ),
  resolver: ETH_RESOLVER,
  updatedAt: FIXTURE_EPOCH + 300,
};

/** Flow 1, stage 4: the preimage has been revealed on the destination. */
export const ORDER_FLOW_1_SECRET_REVEALED: CoordinatorOrder = {
  ...ORDER_FLOW_1_DST_LOCKED,
  status: 'secret_revealed',
  secret: { revealed: true, preimage: null, revealedTx: XLM_TX_CLAIM },
  updatedAt: FIXTURE_EPOCH + 330,
};

/**
 * Flow 1, stage 5: completed.
 *
 * `secret.preimage` is `null` even though the secret is revealed. That is not
 * an oversight — it is the coordinator's documented behaviour: the preimage
 * is only served to an authenticated operator, and this fixture models the
 * public view. The operator view is `SECRET_RESPONSE_FLOW_1`.
 */
export const ORDER_FLOW_1_COMPLETED: CoordinatorOrder = {
  ...ORDER_FLOW_1_SECRET_REVEALED,
  status: 'completed',
  updatedAt: FIXTURE_EPOCH + 360,
};

// ── Flow 2: sol_to_eth, native, times out and refunds ───────────────────────

/** The `POST /api/orders/announce` body for flow 2. */
export const ANNOUNCE_FLOW_2: CoordinatorAnnounceRequest = {
  direction: 'sol_to_eth',
  hashlock: PAIR_SOL_TO_ETH.hashlock,
  srcChain: 'solana',
  srcAddress: SOL_SRC,
  srcAsset: 'native',
  srcAmount: '2000000000',
  srcSafetyDeposit: '10000000',
  dstChain: 'ethereum',
  dstAddress: ETH_DST,
  dstAsset: 'native',
  dstAmount: '600000000000000000',
};

/** Flow 2, stage 1: announced. */
export const ORDER_FLOW_2_ANNOUNCED: CoordinatorOrder = {
  id: ORDER_ID_PREFIX + PAIR_SOL_TO_ETH.hashlock,
  direction: 'sol_to_eth',
  status: 'announced',
  hashlock: PAIR_SOL_TO_ETH.hashlock,
  src: unlockedLeg('solana', SOL_SRC, 'native', '2000000000', '10000000'),
  dst: unlockedLeg('ethereum', ETH_DST, 'native', '600000000000000000'),
  secret: { revealed: false, preimage: null, revealedTx: null },
  resolver: null,
  createdAt: FIXTURE_EPOCH,
  updatedAt: FIXTURE_EPOCH,
};

/**
 * Flow 2, stage 2: the Solana source leg is locked.
 *
 * `lockBlock` is `null` on a Solana leg. There is no block number in the
 * Solana sense — a slot is not a block — and the coordinator contract types
 * it `number | null` precisely so a non-EVM leg can say "not applicable"
 * rather than inventing a number. This is the field a naive producer gets
 * wrong.
 */
export const ORDER_FLOW_2_SRC_LOCKED: CoordinatorOrder = {
  ...ORDER_FLOW_2_ANNOUNCED,
  status: 'src_locked',
  src: lockedLeg(
    ORDER_FLOW_2_ANNOUNCED.src,
    SOL_ORDER_PDA_FLOW_2,
    '4fQhP4LQDY7iXAETTZ9LghgnBGA1vbv9koBPV1PjLJ7NWrSBFFXmgtAfNp54UBY9fjSzuaqj9EZZUPaTXy5BfHaq',
    FIXTURE_EPOCH + 1_800,
    null
  ),
  updatedAt: FIXTURE_EPOCH + 20,
};

/**
 * Flow 2, stage 3: the timelock expired without a destination fill.
 *
 * The destination leg is still null. That is the invariant that makes a
 * refund safe, and `guards/order-payload.ts` checks it.
 */
export const ORDER_FLOW_2_EXPIRED: CoordinatorOrder = {
  ...ORDER_FLOW_2_SRC_LOCKED,
  status: 'expired',
  updatedAt: FIXTURE_EPOCH + 1_900,
};

/**
 * Flow 2, stage 4: refunded.
 *
 * The source leg keeps its lock identifiers — they are the record of what
 * happened — and the refund is visible in `lockTx`. The destination leg
 * stays `null` throughout, because it was never funded.
 */
export const ORDER_FLOW_2_REFUNDED: CoordinatorOrder = {
  ...ORDER_FLOW_2_EXPIRED,
  status: 'refunded',
  src: { ...ORDER_FLOW_2_EXPIRED.src, lockTx: SOL_TX_REFUND },
  updatedAt: FIXTURE_EPOCH + 2_100,
};

// ── Flow 3: eth_to_sol, USDC, settles and claims ────────────────────────────

/** The `POST /api/orders/announce` body for flow 3. */
export const ANNOUNCE_FLOW_3: CoordinatorAnnounceRequest = {
  direction: 'eth_to_sol',
  hashlock: PAIR_ETH_TO_SOL_USDC.hashlock,
  srcChain: 'ethereum',
  srcAddress: ETH_SRC,
  srcAsset: ETH_USDC,
  srcAmount: '250000000',
  srcSafetyDeposit: '2000000000000000',
  dstChain: 'solana',
  dstAddress: SOL_DST,
  dstAsset: SOL_USDC,
  dstAmount: '250000000',
};

/** Flow 3, stage 1: announced. The source asset is an ERC-20, the deposit is ETH. */
export const ORDER_FLOW_3_ANNOUNCED: CoordinatorOrder = {
  id: ORDER_ID_PREFIX + PAIR_ETH_TO_SOL_USDC.hashlock,
  direction: 'eth_to_sol',
  status: 'announced',
  hashlock: PAIR_ETH_TO_SOL_USDC.hashlock,
  src: unlockedLeg('ethereum', ETH_SRC, ETH_USDC, '250000000', '2000000000000000'),
  dst: unlockedLeg('solana', SOL_DST, SOL_USDC, '250000000'),
  secret: { revealed: false, preimage: null, revealedTx: null },
  resolver: null,
  createdAt: FIXTURE_EPOCH + 10,
  updatedAt: FIXTURE_EPOCH + 10,
};

/** Flow 3, stage 2: the ERC-20 source leg is locked (approval already granted). */
export const ORDER_FLOW_3_SRC_LOCKED: CoordinatorOrder = {
  ...ORDER_FLOW_3_ANNOUNCED,
  status: 'src_locked',
  src: lockedLeg(
    ORDER_FLOW_3_ANNOUNCED.src,
    '3',
    '0x6bc602b31b403285eaafd18a723935b110ed1acc806483dae2f506841c6b02c9',
    FIXTURE_EPOCH + 1_810,
    21_000_002
  ),
  updatedAt: FIXTURE_EPOCH + 55,
};

/** Flow 3, stage 3: the Solana SPL destination leg is locked. */
export const ORDER_FLOW_3_DST_LOCKED: CoordinatorOrder = {
  ...ORDER_FLOW_3_SRC_LOCKED,
  status: 'dst_locked',
  dst: lockedLeg(
    ORDER_FLOW_3_ANNOUNCED.dst,
    SOL_ORDER_PDA_FLOW_3,
    '4UX738781quhHf5po8Ka5uBCgfZoVhXNnGaSvniLo8v3jTDUdDaAhqJsmGTqRESwv6JwQV1YcYdL7bPi19n7MZqM',
    FIXTURE_EPOCH + 1_500,
    null
  ),
  resolver: ETH_RESOLVER,
  updatedAt: FIXTURE_EPOCH + 400,
};

/** Flow 3, stage 4: the preimage is revealed. */
export const ORDER_FLOW_3_SECRET_REVEALED: CoordinatorOrder = {
  ...ORDER_FLOW_3_DST_LOCKED,
  status: 'secret_revealed',
  secret: { revealed: true, preimage: null, revealedTx: SOL_TX_CLAIM },
  updatedAt: FIXTURE_EPOCH + 430,
};

/** Flow 3, stage 5: completed. */
export const ORDER_FLOW_3_COMPLETED: CoordinatorOrder = {
  ...ORDER_FLOW_3_SECRET_REVEALED,
  status: 'completed',
  updatedAt: FIXTURE_EPOCH + 460,
};

// ── Flow 4: xlm_to_eth, creation only ───────────────────────────────────────

/** The `POST /api/orders/announce` body for flow 4. */
export const ANNOUNCE_FLOW_4: CoordinatorAnnounceRequest = {
  direction: 'xlm_to_eth',
  hashlock: PAIR_XLM_TO_ETH.hashlock,
  srcChain: 'stellar',
  srcAddress: XLM_SRC,
  srcAsset: 'native',
  srcAmount: '50000000',
  srcSafetyDeposit: '100000',
  dstChain: 'ethereum',
  dstAddress: ETH_DST,
  dstAsset: 'native',
  dstAmount: '150000000000000000',
};

/**
 * Flow 4, stage 1: announced and nothing else.
 *
 * The "creation only" flow is the one that catches a coordinator that
 * fabricates lock data. Every nullable field here is `null` and must stay
 * `null` — the guards reject a populated `orderId` on an `announced` order.
 */
export const ORDER_FLOW_4_ANNOUNCED: CoordinatorOrder = {
  id: ORDER_ID_PREFIX + PAIR_XLM_TO_ETH.hashlock,
  direction: 'xlm_to_eth',
  status: 'announced',
  hashlock: PAIR_XLM_TO_ETH.hashlock,
  src: unlockedLeg('stellar', XLM_SRC, 'native', '50000000', '100000'),
  dst: unlockedLeg('ethereum', ETH_DST, 'native', '150000000000000000'),
  secret: { revealed: false, preimage: null, revealedTx: null },
  resolver: null,
  createdAt: FIXTURE_EPOCH + 600,
  updatedAt: FIXTURE_EPOCH + 600,
};

// ── Secret response (operator view) ─────────────────────────────────────────

/**
 * The `GET /api/secrets/:publicId` response for flow 1, once revealed.
 *
 * This is the one place a preimage appears. The `preimage` is
 * `sha256`-consistent with `ORDER_FLOW_1_ANNOUNCED.hashlock`, which the test
 * suite checks.
 */
export const SECRET_RESPONSE_FLOW_1: CoordinatorSecretResponse = {
  publicId: ORDER_ID_PREFIX + PAIR_ETH_TO_XLM.hashlock,
  preimage: PAIR_ETH_TO_XLM.preimage,
};

// ── History page ────────────────────────────────────────────────────────────

/**
 * A `GET /api/orders/history` page for a wallet that has been active across
 * all three chains: one completed swap, one in flight, and one that
 * refunded. This is the shape a real wallet sees, not four orders in a row
 * from the same direction.
 */
export const HISTORY_PAGE_MIXED: CoordinatorHistoryResponse = {
  transactions: [ORDER_FLOW_1_COMPLETED, ORDER_FLOW_3_SRC_LOCKED, ORDER_FLOW_2_REFUNDED],
  pagination: { limit: 50, count: 3, nextCursor: null },
};

/** A cursor-paginated history page with a continuation. */
export const HISTORY_PAGE_CURSOR: CoordinatorHistoryResponse = {
  transactions: [ORDER_FLOW_1_COMPLETED],
  pagination: { limit: 1, count: 1, nextCursor: 'eyJvIjoxLCJ0IjoxfQ' },
};

/** An empty history page — a fresh wallet. */
export const HISTORY_PAGE_EMPTY: CoordinatorHistoryResponse = {
  transactions: [],
  pagination: { limit: 50, count: 0, nextCursor: null },
};

// ── Health / readiness ──────────────────────────────────────────────────────

/** A healthy `GET /health`. */
export const HEALTH_OK: CoordinatorHealthResponse = {
  status: 'ok',
  service: 'wafflefinance-coordinator',
  version: '1.4.0',
  uptimeSeconds: 86_400,
  timestamp: new Date(FIXTURE_EPOCH * 1000).toISOString(),
  reconciliation: { lastRunAt: FIXTURE_EPOCH - 300, lastRunOk: true, eventsReplayed: 0 },
};

/** A degraded `GET /health` — reconciliation failing. */
export const HEALTH_DEGRADED: CoordinatorHealthResponse = {
  status: 'degraded',
  service: 'wafflefinance-coordinator',
  version: '1.4.0',
  uptimeSeconds: 120,
  timestamp: new Date(FIXTURE_EPOCH * 1000).toISOString(),
  reconciliation: { lastRunAt: FIXTURE_EPOCH - 3_600, lastRunOk: false, eventsReplayed: 14 },
};

/** A healthy `GET /readyz` with every check passing. */
export const READINESS_OK: CoordinatorReadinessResponse = {
  status: 'ok',
  service: 'wafflefinance-coordinator',
  version: '1.4.0',
  uptimeSeconds: 86_400,
  timestamp: new Date(FIXTURE_EPOCH * 1000).toISOString(),
  checks: [
    { name: 'database', ok: true, latencyMs: 3 },
    { name: 'ethereum-rpc', ok: true, latencyMs: 42 },
    { name: 'soroban-rpc', ok: true, latencyMs: 61 },
  ],
};

/** A degraded `GET /readyz` with a failing check and a `detail` string. */
export const READINESS_DEGRADED: CoordinatorReadinessResponse = {
  status: 'degraded',
  service: 'wafflefinance-coordinator',
  version: '1.4.0',
  uptimeSeconds: 120,
  timestamp: new Date(FIXTURE_EPOCH * 1000).toISOString(),
  checks: [
    { name: 'database', ok: true, latencyMs: 3 },
    {
      name: 'solana-rpc',
      ok: false,
      detail: 'connection refused after 3 attempts',
    },
  ],
};

// ── Error envelopes ─────────────────────────────────────────────────────────

/** A well-formed error envelope: a duplicate announce. */
export const ERROR_DUPLICATE_HASHLOCK: CoordinatorErrorResponse = {
  error: 'order_conflict',
  message: 'an order with this hashlock already exists',
  retryable: false,
};

/** A well-formed error envelope that *is* retryable. */
export const ERROR_RATE_LIMITED: CoordinatorErrorResponse = {
  error: 'rate_limited',
  message: 'too many announces from this address; retry in 30s',
  retryable: true,
};

/** A well-formed error envelope for a missing order. */
export const ERROR_ORDER_NOT_FOUND: CoordinatorErrorResponse = {
  error: 'order_not_found',
  message: 'no order exists for the given public ID',
  retryable: false,
};

/**
 * A 200 response that is not a valid order at all.
 *
 * Models the case `guards/coordinator-response.ts` exists for: a proxy or a
 * misrouted request that answers 200 with something else. The client today
 * hands this straight to the caller as a `CoordinatorOrder`.
 */
export const MALFORMED_ORDER_MISSING_LEGS: unknown = {
  id: ORDER_ID_PREFIX + PAIR_ETH_TO_XLM.hashlock,
  direction: 'eth_to_xlm',
  status: 'announced',
  hashlock: PAIR_ETH_TO_XLM.hashlock,
  secret: { revealed: false, preimage: null, revealedTx: null },
  resolver: null,
  createdAt: FIXTURE_EPOCH,
  updatedAt: FIXTURE_EPOCH,
};

/**
 * A 200 order whose `hashlock` is a truncated string.
 *
 * The single most damaging shape a coordinator can return, because
 * `toOrder` casts it straight to `` `0x${string}` `` and a truncated
 * hashlock means a preimage that can never open it.
 */
export const MALFORMED_ORDER_TRUNCATED_HASHLOCK: unknown = {
  ...ORDER_FLOW_1_ANNOUNCED,
  hashlock: PAIR_ETH_TO_XLM.hashlock.slice(0, 34),
};

/** A 200 order carrying a lifecycle status the SDK does not know. */
export const MALFORMED_ORDER_UNKNOWN_STATUS: unknown = {
  ...ORDER_FLOW_1_SRC_LOCKED,
  status: 'arbitration_requested',
};

// ── Solana account-info envelopes ───────────────────────────────────────────

/**
 * A `getAccountInfo` result wrapping a fixture `HTLCOrder` buffer.
 *
 * `Buffer` values do not survive `JSON.stringify` into a plain object, but
 * `web3.js` returns a real `Buffer` over the wire, and the guard in
 * `guards/rpc-payload.ts` requires a byte array rather than a hex or base64
 * string precisely because a string would sail through `Buffer.from`.
 */
export const SOLANA_ACCOUNT_INFO_ACTIVE = {
  executable: false,
  owner: SOL_HTLC_PROGRAM_ID,
  data: SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE,
  lamports: 2_010_000_000,
  rentEpoch: 361,
  space: HTLC_ORDER_ACCOUNT_SIZE,
};

/** A not-yet-created account: `getAccountInfo` returns `null` for the whole value. */
export const SOLANA_ACCOUNT_INFO_ABSENT = null;

// ── The flows, as a table ───────────────────────────────────────────────────

/** The four flows this suite covers, with the orders at each stage. */
export const CROSS_CHAIN_FLOWS = [
  {
    id: 'flow-1-eth-to-xlm-settle-claim',
    title: 'ETH → XLM, native, resolver fills and the beneficiary claims',
    direction: 'eth_to_xlm',
    outcome: 'completed' as const,
    announce: ANNOUNCE_FLOW_1,
    stages: [
      ORDER_FLOW_1_ANNOUNCED,
      ORDER_FLOW_1_SRC_LOCKED,
      ORDER_FLOW_1_DST_LOCKED,
      ORDER_FLOW_1_SECRET_REVEALED,
      ORDER_FLOW_1_COMPLETED,
    ],
  },
  {
    id: 'flow-2-sol-to-eth-expire-refund',
    title: 'SOL → ETH, native, destination never fills and the source refunds',
    direction: 'sol_to_eth',
    outcome: 'refunded' as const,
    announce: ANNOUNCE_FLOW_2,
    stages: [
      ORDER_FLOW_2_ANNOUNCED,
      ORDER_FLOW_2_SRC_LOCKED,
      ORDER_FLOW_2_EXPIRED,
      ORDER_FLOW_2_REFUNDED,
    ],
  },
  {
    id: 'flow-3-eth-to-sol-usdc-settle-claim',
    title: 'USDC → USDC across Ethereum and Solana, settles and claims',
    direction: 'eth_to_sol',
    outcome: 'completed' as const,
    announce: ANNOUNCE_FLOW_3,
    stages: [
      ORDER_FLOW_3_ANNOUNCED,
      ORDER_FLOW_3_SRC_LOCKED,
      ORDER_FLOW_3_DST_LOCKED,
      ORDER_FLOW_3_SECRET_REVEALED,
      ORDER_FLOW_3_COMPLETED,
    ],
  },
  {
    id: 'flow-4-xlm-to-eth-create-only',
    title: 'XLM → ETH, native, announced and never funded (creation only)',
    direction: 'xlm_to_eth',
    outcome: 'announced' as const,
    announce: ANNOUNCE_FLOW_4,
    stages: [ORDER_FLOW_4_ANNOUNCED],
  },
] as const;

/** Re-export so a consumer can build the public id without importing `shared-utils`. */
export { orderIdFromHashlock };

/** Addresses referenced by the flows, for a consumer that wants the full set. */
export const FLOW_ADDRESSES = {
  ethSrc: ETH_SRC,
  ethDst: ETH_DST,
  ethResolver: ETH_RESOLVER,
  ethUsdc: ETH_USDC,
  xlmSrc: XLM_SRC,
  xlmDst: XLM_DST,
  solSrc: SOL_SRC,
  solDst: SOL_DST,
  solRefund: SOL_REFUND,
  solUsdc: SOL_USDC,
  nativeEthToken: NATIVE_ETH_TOKEN,
  nativeSolMint: NATIVE_SOL_MINT,
} as const;
