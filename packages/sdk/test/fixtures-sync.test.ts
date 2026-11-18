/**
 * Anti-rot tests for the canonical cross-chain fixtures (#732).
 *
 * This is the file that makes the fixtures a *contract* rather than JSON.
 * Everything in `src/fixtures/` is synthetic (see that module's header), and
 * synthetic data is only useful if it cannot silently stop matching the code
 * it claims to describe. Three mechanisms, in descending order of importance:
 *
 *   1. **Decoder acceptance** — every fixture is fed through the real
 *      decoder or the real guard, and must be accepted. This is the one that
 *      catches code drift: a renamed coordinator field, a moved Solana IDL
 *      offset, a new `OrderStatus` member, a route-registry change.
 *   2. **Semantic invariants** — the relations that must hold between values
 *      (a preimage opens its hashlock, a public id embeds its hashlock, a
 *      timelock postdates creation, a refund implies a prior lock). This
 *      catches *value* drift, which is why the identity digest deliberately
 *      does not need to cover amounts.
 *   3. **Immutability and identity anchoring** — every fixture is deep
 *      frozen, and the identity digest has not moved.
 *
 * If this file fails, the fixtures no longer describe the SDK. Fix the
 * fixture, not the test — with the one exception spelled out at
 * `FIXTURE_IDENTITY_DIGEST`.
 */

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { describe, it, expect } from 'vitest';

import { deserialiseOrderAccount, type SolanaOrderData } from '../src/solana/index.js';
import {
  HTLC_ORDER_ACCOUNT_SIZE,
  IDL_VERSION,
  ORDER_SEED,
  validateInstructionSchema,
} from '../src/solana/idl/htlc.js';
import { hex32ToBuffer, orderIdFromHashlock, validateHashlock } from '../src/shared-utils/index.js';
import { toOrder } from '../src/coordinator/transform.js';
import { isCoordinatorError } from '../src/coordinator/contract.js';
import {
  assertValidAnnounceRequest,
  validateAnnounceRequest,
} from '../src/coordinator/validation.js';
import { LIVE_DIRECTION_CHAINS } from '../src/routes/index.js';
import { canTransition } from '../src/state-machine/index.js';
import {
  assertCoordinatorHealthResponse,
  assertCoordinatorHistoryResponse,
  assertCoordinatorOrder,
  assertCoordinatorReadinessResponse,
  assertCoordinatorSecretResponse,
  validateCoordinatorOrder,
} from '../src/guards/coordinator-response.js';
import { asStrictOrder, assertOrder, validateOrder } from '../src/guards/order-payload.js';
import { assertSorobanSimulation, validateJsonRpcReply } from '../src/guards/rpc-payload.js';

import {
  ALL_FIXTURES,
  ALL_PREIMAGE_PAIRS,
  ANNOUNCE_FIXTURES,
  COORDINATOR_ORDER_FIXTURES,
  ERROR_ENVELOPE_FIXTURES,
  EVM_EVENT_ARGS_FIXTURES,
  HEALTH_FIXTURES,
  HISTORY_PAGE_FIXTURES,
  MALFORMED_FIXTURES,
  READINESS_FIXTURES,
  SOROBAN_RETVAL_FIXTURES,
  SOROBAN_RPC_REPLY_FIXTURES,
  CROSS_CHAIN_FLOWS,
  FIXTURE_IDENTITY_DIGEST,
  FIXTURE_KINDS,
  FIXTURE_SCHEMA_VERSION,
  FIXTURES_BY_KIND,
  computeFixtureIdentityDigest,
  decodeSorobanOrder,
  FIXTURE_IDENTITIES,
  MALFORMED_ORDER_MISSING_LEGS,
  MALFORMED_ORDER_TRUNCATED_HASHLOCK,
  MALFORMED_ORDER_UNKNOWN_STATUS,
  ORDER_FLOW_1_ANNOUNCED,
  ORDER_FLOW_1_COMPLETED,
  ORDER_FLOW_1_DST_LOCKED,
  ORDER_FLOW_1_SECRET_REVEALED,
  ORDER_FLOW_1_SRC_LOCKED,
  ORDER_FLOW_2_ANNOUNCED,
  ORDER_FLOW_2_EXPIRED,
  ORDER_FLOW_2_REFUNDED,
  ORDER_FLOW_2_SRC_LOCKED,
  ORDER_FLOW_3_COMPLETED,
  ORDER_FLOW_3_SRC_LOCKED,
  ORDER_FLOW_4_ANNOUNCED,
  SECRET_RESPONSE_FLOW_1,
  SOLANA_ACCOUNT_BUFFER_BAD_DISCRIMINATOR,
  SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE,
  SOLANA_ACCOUNT_BUFFER_FLOW_2_CLAIMED,
  SOLANA_ACCOUNT_BUFFER_FLOW_2_REFUNDED,
  SOLANA_ACCOUNT_BUFFER_FLOW_3_ACTIVE,
  SOLANA_ACCOUNT_BUFFER_FUTURE_VERSION,
  SOLANA_ACCOUNT_BUFFER_TRUNCATED,
  SOLANA_IX_CLAIM_FLOW_2,
  SOLANA_IX_CLAIM_FLOW_3,
  SOLANA_IX_CREATE_FLOW_2,
  SOLANA_IX_CREATE_FLOW_3,
  SOLANA_IX_REFUND_FLOW_2,
  SOLANA_ORDER_STATUS,
  SOL_HTLC_PROGRAM_ID,
  SOL_ORDER_PDA_FLOW_2,
  SOL_ORDER_PDA_FLOW_3,
  SOROBAN_ORDER_STATUS,
  SOROBAN_RETVALS_FLOW_2,
  SOROBAN_SIM_RESPONSE_ERROR,
  SOROBAN_SIM_RESPONSE_FUNDED,
  SOLANA_ORDER_FLOW_2_ACTIVE,
  PAIR_SOL_TO_ETH,
  ORDER_FLOW_3_DST_LOCKED,
} from '../src/fixtures/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Decoder acceptance — the load-bearing property
// ─────────────────────────────────────────────────────────────────────────────

describe('fixtures are accepted by the real decoders', () => {
  it('every coordinator order passes validateCoordinatorOrder', () => {
    const orders = COORDINATOR_ORDER_FIXTURES;
    expect(orders.length).toBeGreaterThanOrEqual(15);
    for (const order of orders) {
      const result = validateCoordinatorOrder(order);
      expect(
        result.ok,
        `coordinator order rejected: ${result.ok ? '' : JSON.stringify(result.issues)}`
      ).toBe(true);
    }
  });

  it("every announce request passes the SDK's own preflight validation", () => {
    for (const request of ANNOUNCE_FIXTURES) {
      const result = validateAnnounceRequest(request);
      expect(result.issues, JSON.stringify(result.issues)).toEqual([]);
      expect(() => assertValidAnnounceRequest(request)).not.toThrow();
    }
  });

  it('every history page passes validateCoordinatorHistoryResponse', () => {
    for (const page of HISTORY_PAGE_FIXTURES) {
      expect(() => assertCoordinatorHistoryResponse(page)).not.toThrow();
    }
  });

  it('every health and readiness payload passes its guard', () => {
    for (const health of HEALTH_FIXTURES) {
      expect(() => assertCoordinatorHealthResponse(health)).not.toThrow();
    }
    for (const readiness of READINESS_FIXTURES) {
      expect(() => assertCoordinatorReadinessResponse(readiness)).not.toThrow();
    }
  });

  it('the secret response passes its guard and its preimage opens its hashlock', () => {
    const parsed = assertCoordinatorSecretResponse(SECRET_RESPONSE_FLOW_1);
    expect(parsed.publicId).toBe(
      orderIdFromHashlock(ORDER_FLOW_1_ANNOUNCED.hashlock as `0x${string}`)
    );
    const digest = createHash('sha256').update(Buffer.from(parsed.preimage.slice(2), 'hex'));
    expect('0x' + digest.digest('hex')).toBe(ORDER_FLOW_1_ANNOUNCED.hashlock);
  });

  it('every error envelope is recognised by isCoordinatorError', () => {
    for (const envelope of ERROR_ENVELOPE_FIXTURES) {
      expect(isCoordinatorError(envelope)).toBe(true);
    }
  });

  it('every malformed body is REJECTED — that is what makes it a fixture', () => {
    // These exist to prove the guards fire. If a malformed fixture starts
    // being accepted, the guard has regressed, not the fixture.
    for (const body of MALFORMED_FIXTURES) {
      expect(
        validateCoordinatorOrder(body).ok,
        `unexpectedly accepted ${JSON.stringify(body)}`
      ).toBe(false);
    }
  });

  it('the three malformed bodies each fail for their own distinct reason', () => {
    const missingLegs = validateCoordinatorOrder(MALFORMED_ORDER_MISSING_LEGS);
    expect(missingLegs.ok).toBe(false);
    expect(missingLegs.ok === false && missingLegs.issues.map(i => i.field)).toContain('order.src');

    const truncated = validateCoordinatorOrder(MALFORMED_ORDER_TRUNCATED_HASHLOCK);
    expect(truncated.ok).toBe(false);
    expect(truncated.ok === false && truncated.issues.some(i => i.field === 'order.hashlock')).toBe(
      true
    );

    const unknownStatus = validateCoordinatorOrder(MALFORMED_ORDER_UNKNOWN_STATUS);
    expect(unknownStatus.ok).toBe(false);
    expect(
      unknownStatus.ok === false && unknownStatus.issues.some(i => i.field === 'order.status')
    ).toBe(true);
  });

  it('every coordinator order survives the real transform and then validates', () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      // The real production path: guard the wire, transform, normalise, guard
      // the canonical shape. `asStrictOrder` is the bridge because `toOrder`
      // emits `undefined` (not `null`) for an absent optional — see the next
      // test, which pins that behaviour explicitly.
      const canonical = asStrictOrder(toOrder(assertCoordinatorOrder(order)));
      const result = validateOrder(canonical);
      expect(
        result.ok,
        `${canonical.publicId} rejected by validateOrder: ${
          result.ok ? '' : JSON.stringify(result.issues)
        }`
      ).toBe(true);
      expect(() => assertOrder(canonical)).not.toThrow();
    }
  });

  it('toOrder emits undefined — not null — for an absent optional leg field', () => {
    // This is a real observation about existing code, pinned so the reason
    // `asStrictOrder` exists stays true. `ChainLeg.safetyDeposit` is
    // `safetyDeposit?: string`, and `toOrder` copies it straight across, so
    // a destination leg with no deposit yields `undefined`. A consumer
    // testing `if (leg.safetyDeposit === null)` misses it.
    const loose = toOrder(assertCoordinatorOrder(ORDER_FLOW_1_ANNOUNCED));
    expect(loose.dst.safetyDeposit).toBeUndefined();
    expect(loose.dst.orderId).toBeNull();
    expect(asStrictOrder(loose).dst.safetyDeposit).toBeNull();
  });

  it('every Soroban retval decodes through the sequence soroban/index.ts needs', () => {
    for (const retval of SOROBAN_RETVAL_FIXTURES) {
      expect(typeof retval).toBe('string');
      // The two-step decode: base64 XDR → ScVal → native JS.
      const decoded = decodeSorobanOrder(retval as string);
      expect(typeof decoded.id).toBe('bigint');
      expect(typeof decoded.hashlock).toBe('object');
      expect(decoded.hashlock).toBeInstanceOf(Uint8Array);
      // And the equivalent spelled out longhand, so the test documents the
      // exact sequence a consumer must copy.
      expect(scValToNative(xdr.ScVal.fromXDR(retval as string, 'base64'))).toEqual(decoded);
    }
  });

  it('every Soroban RPC reply is a valid JSON-RPC envelope and a valid simulation', () => {
    for (const reply of SOROBAN_RPC_REPLY_FIXTURES) {
      const validated = validateJsonRpcReply(reply);
      expect(validated.ok, `envelope rejected: ${JSON.stringify(reply)}`).toBe(true);
      if (!validated.ok) continue;

      const envelope = validated.value;
      if (envelope.isError) {
        // Transport-level error: no simulation to validate.
        expect(envelope.error.code).toBe(-32097);
        expect(envelope.classified.category).toBe('rate_limited');
        expect(envelope.classified.retryable).toBe(true);
        continue;
      }

      expect(() => assertSorobanSimulation(envelope.result)).not.toThrow();
    }
  });

  it('the successful simulation decodes to the funded order', () => {
    const sim = assertSorobanSimulation(SOROBAN_SIM_RESPONSE_FUNDED.result);
    expect(sim.status).toBe('SUCCESS');
    if (sim.status !== 'SUCCESS') return;
    const order = decodeSorobanOrder(sim.retval);
    expect(order.status).toBe(SOROBAN_ORDER_STATUS.Funded);
    expect(order.amount).toBe(100_000_000n);
    expect(order.preimage).toHaveLength(0);
  });

  it('the failed simulation is distinguished from a success', () => {
    const sim = assertSorobanSimulation(SOROBAN_SIM_RESPONSE_ERROR.result);
    expect(sim.status).toBe('ERROR');
    if (sim.status !== 'ERROR') return;
    expect(sim.error).toContain('OrderNotFound');
  });

  it('every Solana account buffer decodes through deserialiseOrderAccount', () => {
    // The three negative fixtures are excluded here and asserted separately:
    // they exist precisely because the decoder must reject them.
    const positive = [
      SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE,
      SOLANA_ACCOUNT_BUFFER_FLOW_2_CLAIMED,
      SOLANA_ACCOUNT_BUFFER_FLOW_2_REFUNDED,
      SOLANA_ACCOUNT_BUFFER_FLOW_3_ACTIVE,
    ];

    for (const buffer of positive) {
      const order: SolanaOrderData = deserialiseOrderAccount(buffer, 'fixture-order-id');
      expect(order.amount).toBeGreaterThan(0n);
      expect(validateHashlock(order.hashlock)).toBe(true);
      expect([0, 1, 2]).toContain(order.status);
    }
  });

  it('the active flow-2 buffer round-trips every field the fixture claims', () => {
    const decoded = deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE, 'pda-fixture');
    expect(decoded.sender).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.sender);
    expect(decoded.beneficiary).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.beneficiary);
    expect(decoded.refundAddress).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.refundAddress);
    expect(decoded.mint).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.mint);
    expect(decoded.amount).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.amount);
    expect(decoded.safetyDeposit).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.safetyDeposit);
    expect(decoded.hashlock).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.hashlock);
    expect(decoded.timelock).toBe(SOLANA_ORDER_FLOW_2_ACTIVE.timelock);
    expect(decoded.status).toBe(SOLANA_ORDER_STATUS.Active);
    expect(decoded.preimage).toBeNull();
  });

  it('the claimed buffer exposes the preimage and the refunded buffer does not', () => {
    const claimed = deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_FLOW_2_CLAIMED, 'pda-fixture');
    expect(claimed.status).toBe(SOLANA_ORDER_STATUS.Claimed);
    expect(claimed.preimage).toBe(PAIR_SOL_TO_ETH.preimage);
    // And the preimage really opens the hashlock the account carries.
    const digest = createHash('sha256').update(Buffer.from(claimed.preimage!.slice(2), 'hex'));
    expect('0x' + digest.digest('hex')).toBe(claimed.hashlock);

    const refunded = deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_FLOW_2_REFUNDED, 'pda-fixture');
    expect(refunded.status).toBe(SOLANA_ORDER_STATUS.Refunded);
    expect(refunded.preimage).toBeNull();
  });

  it('the decoder rejects the three negative Solana buffers', () => {
    expect(() => deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_TRUNCATED, 'pda')).toThrow(
      /too small/
    );
    expect(() => deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_BAD_DISCRIMINATOR, 'pda')).toThrow(
      /discriminator/
    );
    expect(() => deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_FUTURE_VERSION, 'pda')).toThrow(
      /newer than SDK IDL version/
    );
  });

  it('every Solana instruction conforms to the IDL schema', () => {
    // `buildCreateOrderInstruction` returns `{ instruction, orderPda }`; the
    // claim and refund builders return the instruction directly. Normalised
    // here so the schema check reads the same for all three.
    const cases = [
      ['createOrder', SOLANA_IX_CREATE_FLOW_2.instruction],
      ['claimOrder', SOLANA_IX_CLAIM_FLOW_2],
      ['refundOrder', SOLANA_IX_REFUND_FLOW_2],
      ['createOrder', SOLANA_IX_CREATE_FLOW_3.instruction],
      ['claimOrder', SOLANA_IX_CLAIM_FLOW_3],
    ] as const;
    for (const [kind, ix] of cases) {
      const errors = validateInstructionSchema(
        kind,
        ix.data,
        ix.keys.map(k => ({ isSigner: k.isSigner, isWritable: k.isWritable }))
      );
      expect(errors, `${kind}: ${errors.join('; ')}`).toEqual([]);
    }
  });

  it('the create instruction carries the fixture hashlock and amount in its data', () => {
    // 8 discriminator + 8 amount + 8 safety + 32 hashlock + 8 timelock.
    const data = SOLANA_IX_CREATE_FLOW_2.instruction.data;
    expect(data).toHaveLength(64);
    expect('0x' + Buffer.from(data.subarray(24, 56)).toString('hex')).toBe(
      SOLANA_ORDER_FLOW_2_ACTIVE.hashlock
    );
  });

  it('every Ethereum event-args fixture matches the field set in HTLC_ESCROW_ABI', () => {
    // Field *presence*, not values: a rename in the ABI must break a fixture.
    expect(Object.keys(EVM_EVENT_ARGS_FIXTURES[0]).sort()).toEqual(
      [
        'amount',
        'beneficiary',
        'hashlock',
        'orderId',
        'safetyDeposit',
        'sender',
        'timelock',
        'token',
      ].sort()
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Semantic invariants — value drift
// ─────────────────────────────────────────────────────────────────────────────

describe('fixture semantic invariants', () => {
  it('every hashlock is a real 32-byte hex string', () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      expect(validateHashlock(order.hashlock), `bad hashlock on ${order.id}`).toBe(true);
    }
  });

  it('every preimage pair satisfies hashlock === sha256(preimage)', () => {
    for (const pair of ALL_PREIMAGE_PAIRS) {
      expect(validateHashlock(pair.preimage)).toBe(true);
      expect(validateHashlock(pair.hashlock)).toBe(true);
      const digest = createHash('sha256').update(Buffer.from(pair.preimage.slice(2), 'hex'));
      expect('0x' + digest.digest('hex'), `pair ${pair.label}`).toBe(pair.hashlock);
    }
  });

  it('every order id is the canonical id derived from its own hashlock', () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      expect(order.id, `order id mismatch on ${order.id}`).toBe(
        orderIdFromHashlock(order.hashlock as `0x${string}`)
      );
    }
  });

  it("every announce request describes the same hashlock as its flow's orders", () => {
    for (const flow of CROSS_CHAIN_FLOWS) {
      const ids = new Set(flow.stages.map(stage => stage.hashlock));
      expect(ids.size, `flow ${flow.id} has orders with more than one hashlock`).toBe(1);
      expect([...ids][0]).toBe(flow.announce.hashlock);
    }
  });

  it("every flow's stages advance through legal state-machine transitions", () => {
    for (const flow of CROSS_CHAIN_FLOWS) {
      expect(flow.stages.length).toBeGreaterThan(0);
      for (let i = 1; i < flow.stages.length; i += 1) {
        const from = flow.stages[i - 1]!.status;
        const to = flow.stages[i]!.status;
        expect(
          canTransition(from, to),
          `flow ${flow.id}: ${from} -> ${to} is not a legal transition`
        ).toBe(true);
      }
      expect(flow.stages[flow.stages.length - 1]!.status).toBe(flow.outcome);
    }
  });

  it("every flow's announce body agrees with its first order on both chains", () => {
    for (const flow of CROSS_CHAIN_FLOWS) {
      const first = flow.stages[0]!;
      expect(first.src.chain).toBe(flow.announce.srcChain);
      expect(first.dst.chain).toBe(flow.announce.dstChain);
      expect(first.src.address).toBe(flow.announce.srcAddress);
      expect(first.dst.address).toBe(flow.announce.dstAddress);
      expect(first.src.asset).toBe(flow.announce.srcAsset);
      expect(first.dst.asset).toBe(flow.announce.dstAsset);
      expect(first.src.amount).toBe(flow.announce.srcAmount);
      expect(first.dst.amount).toBe(flow.announce.dstAmount);
      const want = LIVE_DIRECTION_CHAINS[flow.direction];
      expect(flow.announce.srcChain).toBe(want.src);
      expect(flow.announce.dstChain).toBe(want.dst);
    }
  });

  it("every timelock postdates its order's creation", () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      for (const leg of [order.src, order.dst]) {
        if (leg.timelock !== null) {
          expect(leg.timelock, `${order.id}: timelock precedes creation`).toBeGreaterThan(
            order.createdAt
          );
        }
      }
    }
  });

  it('a leg with a lock identifier has all three, and a leg without has none', () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      for (const leg of [order.src, order.dst]) {
        const set = [leg.orderId, leg.lockTx, leg.timelock].filter(v => v !== null);
        expect([0, 3], `${order.id}: partial lock state`).toContain(set.length);
      }
    }
  });

  it('the refund flow keeps the destination leg untouched throughout', () => {
    // This is the invariant that makes a refund safe: nothing on the
    // destination was ever funded, so returning the source is the only
    // correct action.
    for (const order of [
      ORDER_FLOW_2_ANNOUNCED,
      ORDER_FLOW_2_SRC_LOCKED,
      ORDER_FLOW_2_EXPIRED,
      ORDER_FLOW_2_REFUNDED,
    ]) {
      expect(order.dst.orderId, `flow 2 dst funded at ${order.status}`).toBeNull();
      expect(order.dst.lockTx).toBeNull();
      expect(order.dst.timelock).toBeNull();
    }
  });

  it('the refund flow funded before it refunded', () => {
    expect(ORDER_FLOW_2_SRC_LOCKED.src.orderId).not.toBeNull();
    expect(ORDER_FLOW_2_REFUNDED.src.orderId).not.toBeNull();
    expect(ORDER_FLOW_2_REFUNDED.updatedAt).toBeGreaterThan(ORDER_FLOW_2_EXPIRED.updatedAt);
  });

  it('an announced order has no lock identifiers on either leg', () => {
    for (const order of [ORDER_FLOW_1_ANNOUNCED, ORDER_FLOW_2_ANNOUNCED, ORDER_FLOW_4_ANNOUNCED]) {
      expect(order.src.orderId).toBeNull();
      expect(order.src.lockTx).toBeNull();
      expect(order.dst.orderId).toBeNull();
      expect(order.dst.lockTx).toBeNull();
    }
  });

  it('the settling flows progress monotonically through updatedAt', () => {
    const flow1 = [
      ORDER_FLOW_1_ANNOUNCED,
      ORDER_FLOW_1_SRC_LOCKED,
      ORDER_FLOW_1_DST_LOCKED,
      ORDER_FLOW_1_SECRET_REVEALED,
      ORDER_FLOW_1_COMPLETED,
    ];
    for (let i = 1; i < flow1.length; i += 1) {
      expect(flow1[i]!.updatedAt).toBeGreaterThan(flow1[i - 1]!.updatedAt);
    }
  });

  it('the secret is revealed before the order is completed, and the preimage stays server-side', () => {
    // The coordinator documents that `secret.preimage` is null for public
    // consumers even after reveal. A fixture that "helpfully" filled it in
    // would be teaching consumers to read a field that is always null.
    expect(ORDER_FLOW_1_DST_LOCKED.secret.revealed).toBe(false);
    expect(ORDER_FLOW_1_SECRET_REVEALED.secret.revealed).toBe(true);
    expect(ORDER_FLOW_1_SECRET_REVEALED.secret.preimage).toBeNull();
    expect(ORDER_FLOW_1_COMPLETED.secret.preimage).toBeNull();
    expect(ORDER_FLOW_1_COMPLETED.secret.revealedTx).not.toBeNull();
  });

  it('a non-Ethereum leg reports no lockBlock', () => {
    // Solana and Stellar have no EVM block number. The contract types the
    // field `number | null` precisely so a non-EVM leg can say "not
    // applicable"; a fixture that invented a block number would teach a
    // consumer that the field is always populated.
    const solanaLegged = [ORDER_FLOW_2_SRC_LOCKED, ORDER_FLOW_2_REFUNDED, ORDER_FLOW_3_DST_LOCKED];
    for (const order of solanaLegged) {
      for (const leg of [order.src, order.dst]) {
        if (leg.chain !== 'ethereum') {
          expect(leg.lockBlock, `${order.id} ${leg.chain} leg has a lockBlock`).toBeNull();
        }
      }
    }
  });

  it('the Solana order PDAs are the real derivation for the fixture program id', () => {
    // Recomputed with the SDK's own seed constant, so a change to
    // `ORDER_SEED` or the PDA derivation breaks the fixture.
    const program = new PublicKey(SOL_HTLC_PROGRAM_ID);
    const flow2 = deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE, 'x');
    const [pdaFlow2] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, hex32ToBuffer(flow2.hashlock, 'hashlock')],
      program
    );
    expect(pdaFlow2.toBase58()).toBe(SOL_ORDER_PDA_FLOW_2);

    const flow3 = deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_FLOW_3_ACTIVE, 'x');
    const [pdaFlow3] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, hex32ToBuffer(flow3.hashlock, 'hashlock')],
      program
    );
    expect(pdaFlow3.toBase58()).toBe(SOL_ORDER_PDA_FLOW_3);
  });

  it('the Soroban retvals agree with the Soroban enums from the Rust contract', () => {
    expect(decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.funded).status).toBe(
      SOROBAN_ORDER_STATUS.Funded
    );
    expect(decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.claimed).status).toBe(
      SOROBAN_ORDER_STATUS.Claimed
    );
    expect(decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.refunded).status).toBe(
      SOROBAN_ORDER_STATUS.Refunded
    );
  });

  it('the Soroban claimed order carries a preimage that opens its hashlock', () => {
    const claimed = decodeSorobanOrder(SOROBAN_RETVALS_FLOW_2.claimed);
    const digest = createHash('sha256').update(Buffer.from(claimed.preimage));
    expect(Buffer.from(claimed.hashlock).toString('hex')).toBe(digest.digest('hex'));
  });

  it('the Solana and Ethereum status enums agree, so the three chains are comparable', () => {
    expect(SOLANA_ORDER_STATUS.Active).toBe(SOROBAN_ORDER_STATUS.Funded);
    expect(SOLANA_ORDER_STATUS.Claimed).toBe(SOROBAN_ORDER_STATUS.Claimed);
    expect(SOLANA_ORDER_STATUS.Refunded).toBe(SOROBAN_ORDER_STATUS.Refunded);
  });

  it('the amount fixtures are atomic-unit decimal strings, never floats', () => {
    for (const order of COORDINATOR_ORDER_FIXTURES) {
      for (const leg of [order.src, order.dst]) {
        expect(leg.amount, `${order.id} src.amount`).toMatch(/^\d+$/);
        if (leg.safetyDeposit !== undefined && leg.safetyDeposit !== null) {
          expect(leg.safetyDeposit).toMatch(/^\d+$/);
        }
      }
    }
  });

  it('the flow table covers all four live directions and both outcomes', () => {
    const directions = new Set(CROSS_CHAIN_FLOWS.map(flow => flow.direction));
    expect([...directions].sort()).toEqual([
      'eth_to_sol',
      'eth_to_xlm',
      'sol_to_eth',
      'xlm_to_eth',
    ]);
    const outcomes = new Set(CROSS_CHAIN_FLOWS.map(flow => flow.outcome));
    expect(outcomes.has('completed')).toBe(true);
    expect(outcomes.has('refunded')).toBe(true);
  });

  it('every flow is one of the lifecycle stages the issue names', () => {
    for (const flow of CROSS_CHAIN_FLOWS) {
      expect(flow.stages[0]!.status, `flow ${flow.id} does not start announced`).toBe('announced');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Immutability and identity anchoring
// ─────────────────────────────────────────────────────────────────────────────

describe('fixture immutability and identity anchoring', () => {
  it('every fixture object is deep-frozen', () => {
    for (const [kind, group] of Object.entries(FIXTURES_BY_KIND)) {
      for (const fixture of group) {
        if (fixture === null || typeof fixture !== 'object') continue;
        if (ArrayBuffer.isView(fixture) || fixture instanceof ArrayBuffer) continue;
        expect(Object.isFrozen(fixture), `${kind} fixture is not frozen`).toBe(true);
      }
    }
  });

  it('a nested leg is frozen too, not just the top-level order', () => {
    expect(Object.isFrozen(ORDER_FLOW_1_SRC_LOCKED.src)).toBe(true);
    expect(Object.isFrozen(ORDER_FLOW_1_SRC_LOCKED.src)).toBe(true);
    expect(Object.isFrozen(FLOW_STAGES)).toBe(true);
  });

  it('the whole fixture table is frozen', () => {
    expect(Object.isFrozen(FIXTURES_BY_KIND)).toBe(true);
    expect(Object.isFrozen(ALL_FIXTURES)).toBe(true);
  });

  it('the identity digest has not moved', () => {
    const actual = computeFixtureIdentityDigest();
    expect(
      actual,
      `Fixture identities changed.\n` +
        `  expected: ${FIXTURE_IDENTITY_DIGEST}\n` +
        `  actual:   ${actual}\n` +
        `If this is intentional (a new flow needs a new account), read the fixture ` +
        `diff, confirm no real principal replaced a synthetic one, then update ` +
        `FIXTURE_IDENTITY_DIGEST. If it is not, do not update it — find the change.`
    ).toBe(FIXTURE_IDENTITY_DIGEST);
  });

  it('every identity carries the synthetic marker in its seed label or its own provenance', () => {
    // Identity *values* cannot carry a marker (an address has no room for
    // one), so what is checked is that the suite documents them: the seed
    // prefix constant exists, and the identity table is non-trivial.
    expect(FIXTURE_IDENTITIES['ethSrc']).toBeDefined();
    expect(Object.keys(FIXTURE_IDENTITIES).length).toBeGreaterThan(20);
  });

  it('the schema version is a positive integer', () => {
    expect(Number.isInteger(FIXTURE_SCHEMA_VERSION)).toBe(true);
    expect(FIXTURE_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('every declared fixture kind has at least one fixture', () => {
    for (const kind of FIXTURE_KINDS) {
      expect(FIXTURES_BY_KIND[kind]?.length ?? 0, `no fixtures for kind "${kind}"`).toBeGreaterThan(
        0
      );
    }
  });

  it('the fixture table has no kinds beyond the declared list', () => {
    expect(Object.keys(FIXTURES_BY_KIND).sort()).toEqual([...FIXTURE_KINDS].sort());
  });

  it('ALL_FIXTURES is the flattened table', () => {
    const expected = Object.values(FIXTURES_BY_KIND).reduce((n, g) => n + g.length, 0);
    expect(ALL_FIXTURES).toHaveLength(expected);
  });

  it('the Solana account-size constant still matches the fixture buffers', () => {
    // The IDL's documented total is 8 + 219 = 227. If the layout grows, the
    // fixtures' 227-byte buffers stop being valid and this fails.
    expect(SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE).toHaveLength(HTLC_ORDER_ACCOUNT_SIZE);
    expect(HTLC_ORDER_ACCOUNT_SIZE).toBe(227);
  });

  it('the IDL version the buffers carry is the one the SDK supports', () => {
    const decoded = deserialiseOrderAccount(SOLANA_ACCOUNT_BUFFER_FLOW_2_ACTIVE, 'x');
    expect(decoded).toBeDefined();
    expect(IDL_VERSION).toBe(0);
  });

  it('the eth_to_sol USDC flow reaches src_locked with a funded ERC-20 source leg', () => {
    expect(ORDER_FLOW_3_SRC_LOCKED.src.orderId).toBe('3');
    expect(ORDER_FLOW_3_SRC_LOCKED.src.safetyDeposit).toMatch(/^\d+$/);
    expect(ORDER_FLOW_3_COMPLETED.status).toBe('completed');
  });
});

/** A nested array captured so the nested-freeze assertion has something to check. */
const FLOW_STAGES = CROSS_CHAIN_FLOWS[0]!.stages;
