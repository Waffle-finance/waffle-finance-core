import { describe, expect, it } from "vitest";
import {
  hashlockFromOrderId,
  orderIdFromHashlock,
} from "../packages/sdk/src/shared-utils/index.js";
import { toOrder } from "../packages/sdk/src/coordinator/transform.js";
import { validateAnnounceRequest } from "../packages/sdk/src/coordinator/validation.js";
import type { CoordinatorOrder } from "../packages/sdk/src/coordinator/contract.js";
import {
  ethEventKey,
  semanticKey,
} from "../coordinator/src/reconciliation/event-identity.js";
import type { CoordinatorOrderMetadata } from "../relayer/src/services/coordinator-client.js";
import {
  assertPublicOrderId,
  FIXTURE_CHAIN_ORDER_ID,
  FIXTURE_DST_ADDRESS,
  FIXTURE_HASHLOCK,
  FIXTURE_PUBLIC_ID,
  FIXTURE_REQUEST_ID,
  FIXTURE_RESOLVER,
  FIXTURE_TX_SIGNATURE,
  identifierFixtureSet,
} from "./identifier-fixtures.js";

function historyWire(overrides: Partial<CoordinatorOrder> = {}): CoordinatorOrder {
  return {
    id: FIXTURE_PUBLIC_ID,
    direction: "eth_to_xlm",
    status: "src_locked",
    hashlock: FIXTURE_HASHLOCK,
    src: {
      chain: "ethereum",
      address: FIXTURE_RESOLVER,
      asset: "0x0000000000000000000000000000000000000000",
      amount: "1000000000000000",
      safetyDeposit: "0",
      orderId: FIXTURE_CHAIN_ORDER_ID,
      lockTx: FIXTURE_TX_SIGNATURE,
      lockBlock: 100,
      timelock: 1_800_000_000,
    },
    dst: {
      chain: "stellar",
      address: FIXTURE_DST_ADDRESS,
      asset: "native",
      amount: "1000",
      orderId: null,
      lockTx: null,
      lockBlock: null,
      timelock: null,
    },
    secret: { revealed: false, preimage: null, revealedTx: null },
    resolver: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    ...overrides,
  };
}

describe("cross-service order identifier compatibility (#1127)", () => {
  it("uses shared fixtures with deliberately distinct values", () => {
    const ids = identifierFixtureSet();
    expect(new Set(Object.values(ids)).size).toBe(Object.values(ids).length);
    expect(ids.publicId).toBe(`wf_${FIXTURE_HASHLOCK}`);
    expect(hashlockFromOrderId(ids.publicId)).toBe(FIXTURE_HASHLOCK);
    expect(orderIdFromHashlock(ids.hashlock)).toBe(ids.publicId);
  });

  it("announce preserves hashlock and derives the public ID, never the tx signature", () => {
    const payload = {
      direction: "eth_to_xlm",
      hashlock: FIXTURE_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: FIXTURE_RESOLVER,
      srcAsset: "0x0000000000000000000000000000000000000000",
      srcAmount: "1000000000000000",
      srcSafetyDeposit: "0",
      dstChain: "stellar",
      dstAddress: FIXTURE_DST_ADDRESS,
      dstAsset: "native",
      dstAmount: "1000",
    };
    const verdict = validateAnnounceRequest(payload);
    expect(verdict).toEqual({ ok: true, issues: [] });

    expect(payload.hashlock).toBe(FIXTURE_HASHLOCK);
    expect(orderIdFromHashlock(payload.hashlock)).toBe(FIXTURE_PUBLIC_ID);
    expect(payload).not.toHaveProperty("lockTx");
    expect(payload).not.toHaveProperty("txSignature");
    expect(() => assertPublicOrderId(FIXTURE_TX_SIGNATURE, payload.hashlock)).toThrow(
      /invalid public order id|does not derive from hashlock/,
    );
  });

  it("event ingestion keys use tx signature for identity and hashlock for semantics", () => {
    const dedupKey = ethEventKey("OrderCreated", FIXTURE_TX_SIGNATURE, 7);
    const semantic = semanticKey("ethereum", "OrderCreated", FIXTURE_HASHLOCK);

    expect(dedupKey).toContain(FIXTURE_TX_SIGNATURE);
    expect(dedupKey).not.toContain(FIXTURE_PUBLIC_ID);
    expect(semantic).toContain(FIXTURE_HASHLOCK.slice(2));
    expect(semantic).not.toContain(FIXTURE_TX_SIGNATURE);

    // Claim/refund events identify the order by numeric on-chain ID.
    const claimSemantic = semanticKey("ethereum", "OrderClaimed", FIXTURE_CHAIN_ORDER_ID);
    expect(claimSemantic).toContain(FIXTURE_CHAIN_ORDER_ID);
    expect(claimSemantic).not.toContain(FIXTURE_TX_SIGNATURE);
  });

  it("relayer metadata keeps public ID, order hash and transaction ID separate", () => {
    const metadata: CoordinatorOrderMetadata = {
      orderId: FIXTURE_PUBLIC_ID,
      status: "src_locked",
      hashlock: FIXTURE_HASHLOCK,
      direction: "eth_to_xlm",
      resolverAddress: FIXTURE_RESOLVER,
      createdAt: 1_700_000_000,
    };
    assertPublicOrderId(metadata.orderId, metadata.hashlock!);

    const relayerEvent = {
      orderId: FIXTURE_CHAIN_ORDER_ID,
      orderHash: metadata.hashlock,
      publicId: metadata.orderId,
      txHash: FIXTURE_TX_SIGNATURE,
      requestId: FIXTURE_REQUEST_ID,
    };
    expect(relayerEvent.publicId).not.toBe(relayerEvent.txHash);
    expect(relayerEvent.orderId).not.toBe(relayerEvent.publicId);
    expect(relayerEvent.orderHash).toBe(FIXTURE_HASHLOCK);
  });

  it("history responses preserve each identifier under its documented field name", () => {
    const order = toOrder(historyWire());
    assertPublicOrderId(order.publicId, order.hashlock);

    expect(order.publicId).toBe(FIXTURE_PUBLIC_ID);
    expect(order.hashlock).toBe(FIXTURE_HASHLOCK);
    expect(order.src.orderId).toBe(FIXTURE_CHAIN_ORDER_ID);
    expect(order.src.lockTx).toBe(FIXTURE_TX_SIGNATURE);
    expect(order.src.lockTx).not.toBe(order.publicId);

    // Guard regression: a payload that returns the tx signature as the public
    // order identifier must fail instead of being silently accepted.
    const regressingOrder = toOrder(historyWire({ id: FIXTURE_TX_SIGNATURE }));
    expect(() => assertPublicOrderId(regressingOrder.publicId, regressingOrder.hashlock)).toThrow(
      /does not derive from hashlock|invalid public order id/,
    );
  });
});
