/**
 * Unit tests for the canonical Soroban HTLC event decoder.
 *
 * These tests treat `decodeHtlcEvent` as a pure function and exercise every
 * structural path — happy paths for all three lifecycle events, every
 * MalformedReason branch, governance/config topic filtering, and the
 * `isMalformedEvent` type-guard.
 *
 * Real `xdr.ScVal` objects are built via the same pre-baked base64 fixtures
 * used by `listeners.test.ts`, guaranteeing that the decoder is tested against
 * the exact binary format the live RPC node produces.
 */

import { describe, it, expect } from "vitest";
import { xdr, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import {
  decodeHtlcEvent,
  isMalformedEvent,
  HTLC_EVENT_SCHEMA_VERSION,
  type CreatedEvent,
  type ClaimedEvent,
  type RefundedEvent,
  type MalformedEventError,
} from "../src/soroban-events.js";
import {
  makeCreatedEvent,
  makeClaimedEvent,
  makeRefundedEvent,
  makeMalformedDataEvent,
  makeUnknownTopicEvent,
  makeCorruptDataEvent,
  HASHLOCK,
  PREIMAGE,
  ORDER_ID,
  TIMELOCK,
  SENDER_ADDR,
  BENEFICIARY_ADDR,
  REFUND_ADDR,
} from "./fixtures/soroban-xdr-fixtures.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract topics and value from a fixture event object. */
function fixtureArgs(ev: ReturnType<typeof makeCreatedEvent>) {
  return { topics: ev.topic, value: ev.value };
}

function decodeFixture(ev: ReturnType<typeof makeCreatedEvent>) {
  const { topics, value } = fixtureArgs(ev);
  return decodeHtlcEvent(topics, value);
}

// ─── Happy-path: created ─────────────────────────────────────────────────────

describe("decodeHtlcEvent — created", () => {
  it("returns a CreatedEvent with the correct kind and schemaVersion", () => {
    const result = decodeFixture(makeCreatedEvent());
    expect(isMalformedEvent(result)).toBe(false);
    expect(result).not.toBeNull();
    const ev = result as CreatedEvent;
    expect(ev.kind).toBe("created");
    expect(ev.schemaVersion).toBe(HTLC_EVENT_SCHEMA_VERSION);
  });

  it("decodes orderId as bigint matching the fixture value (42n)", () => {
    const ev = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    expect(ev.orderId).toBe(BigInt(ORDER_ID));
  });

  it("decodes hashlock as 0x-prefixed 64-char hex string", () => {
    const ev = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    expect(ev.hashlock).toBe(HASHLOCK);
    expect(/^0x[0-9a-f]{64}$/.test(ev.hashlock)).toBe(true);
  });

  it("decodes timelock as the absolute unix timestamp from the fixture", () => {
    const ev = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    expect(ev.timelock).toBe(TIMELOCK);
    expect(typeof ev.timelock).toBe("number");
  });

  it("decodes sender address from topics[1]", () => {
    const ev = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    expect(ev.sender).toBe(SENDER_ADDR);
    expect(typeof ev.sender).toBe("string");
  });

  it("decodes beneficiary address from topics[2]", () => {
    const ev = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    expect(ev.beneficiary).toBe(BENEFICIARY_ADDR);
  });

  it("decodes amount as a decimal string (not a bigint)", () => {
    const ev = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    expect(typeof ev.amount).toBe("string");
    expect(() => BigInt(ev.amount)).not.toThrow();
  });

  it("decodes safetyDeposit as a decimal string", () => {
    const ev = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    expect(typeof ev.safetyDeposit).toBe("string");
    expect(() => BigInt(ev.safetyDeposit)).not.toThrow();
  });
});

// ─── Happy-path: claimed ──────────────────────────────────────────────────────

describe("decodeHtlcEvent — claimed", () => {
  it("returns a ClaimedEvent with kind='claimed' and correct schemaVersion", () => {
    const result = decodeFixture(makeClaimedEvent());
    expect(isMalformedEvent(result)).toBe(false);
    expect(result).not.toBeNull();
    const ev = result as ClaimedEvent;
    expect(ev.kind).toBe("claimed");
    expect(ev.schemaVersion).toBe(HTLC_EVENT_SCHEMA_VERSION);
  });

  it("decodes orderId from data[0]", () => {
    const ev = decodeFixture(makeClaimedEvent()) as ClaimedEvent;
    expect(ev.orderId).toBe(BigInt(ORDER_ID));
  });

  it("decodes hashlock from topics[2] as 0x-prefixed hex", () => {
    const ev = decodeFixture(makeClaimedEvent()) as ClaimedEvent;
    expect(ev.hashlock).toBe(HASHLOCK);
  });

  it("decodes preimage from data[2] as 0x-prefixed hex", () => {
    const ev = decodeFixture(makeClaimedEvent()) as ClaimedEvent;
    expect(ev.preimage).toBe(PREIMAGE);
    expect(/^0x[0-9a-f]+$/.test(ev.preimage)).toBe(true);
  });

  it("decodes beneficiary address from topics[1]", () => {
    const ev = decodeFixture(makeClaimedEvent()) as ClaimedEvent;
    expect(ev.beneficiary).toBe(BENEFICIARY_ADDR);
  });
});

// ─── Happy-path: refunded ─────────────────────────────────────────────────────

describe("decodeHtlcEvent — refunded", () => {
  it("returns a RefundedEvent with kind='refunded' and correct schemaVersion", () => {
    const result = decodeFixture(makeRefundedEvent());
    expect(isMalformedEvent(result)).toBe(false);
    expect(result).not.toBeNull();
    const ev = result as RefundedEvent;
    expect(ev.kind).toBe("refunded");
    expect(ev.schemaVersion).toBe(HTLC_EVENT_SCHEMA_VERSION);
  });

  it("decodes orderId from data[0]", () => {
    const ev = decodeFixture(makeRefundedEvent()) as RefundedEvent;
    expect(ev.orderId).toBe(BigInt(ORDER_ID));
  });

  it("decodes hashlock from topics[2]", () => {
    const ev = decodeFixture(makeRefundedEvent()) as RefundedEvent;
    expect(ev.hashlock).toBe(HASHLOCK);
  });

  it("decodes refundAddress from topics[1]", () => {
    const ev = decodeFixture(makeRefundedEvent()) as RefundedEvent;
    expect(ev.refundAddress).toBe(REFUND_ADDR);
  });
});

// ─── Unknown / irrelevant topics ─────────────────────────────────────────────

describe("decodeHtlcEvent — unknown topics return null", () => {
  it("returns null for an unknown lifecycle topic symbol", () => {
    const ev = makeUnknownTopicEvent();
    const result = decodeHtlcEvent(ev.topic, ev.value);
    expect(result).toBeNull();
    expect(isMalformedEvent(result)).toBe(false);
  });

  it("returns null for an empty topics array", () => {
    const ev = makeCreatedEvent();
    const result = decodeHtlcEvent([], ev.value);
    expect(result).toBeNull();
  });

  it("returns null for governance 'cfg' topic", () => {
    const cfgTopic = nativeToScVal("cfg", { type: "symbol" }) as xdr.ScVal;
    const ev = makeCreatedEvent();
    const result = decodeHtlcEvent([cfgTopic, ev.topic[1]!], ev.value);
    expect(result).toBeNull();
  });

  it("returns null for 'adm_xfer' topic", () => {
    const admTopic = nativeToScVal("adm_xfer", { type: "symbol" }) as xdr.ScVal;
    const ev = makeCreatedEvent();
    const result = decodeHtlcEvent([admTopic], ev.value);
    expect(result).toBeNull();
  });

  it("returns null when topics[0] is not a symbol (e.g. an integer)", () => {
    const intTopic = nativeToScVal(99, { type: "u32" }) as xdr.ScVal;
    const ev = makeCreatedEvent();
    const result = decodeHtlcEvent([intTopic], ev.value);
    expect(result).toBeNull();
  });
});

// ─── Malformed payloads ───────────────────────────────────────────────────────

describe("decodeHtlcEvent — malformed payloads return MalformedEventError", () => {
  it("returns a MalformedEventError (not null, not a DecodedEvent) when data is not a Vec", () => {
    const ev = makeMalformedDataEvent();
    const result = decodeHtlcEvent(ev.topic, ev.value);
    expect(result).not.toBeNull();
    expect(isMalformedEvent(result)).toBe(true);
    const err = result as MalformedEventError;
    expect(err.isMalformed).toBe(true);
    expect(err.kind).toBe("created");
    expect(err.reason).toBe("data_not_array");
    expect(typeof err.detail).toBe("string");
    expect(err.detail.length).toBeGreaterThan(0);
  });

  it("does not throw when data ScVal is null (corrupt XDR path)", () => {
    const ev = makeCorruptDataEvent();
    expect(() => decodeHtlcEvent(ev.topic, ev.value)).not.toThrow();
    const result = decodeHtlcEvent(ev.topic, ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    const err = result as MalformedEventError;
    expect(err.reason).toBe("xdr_decode_error");
  });

  it("topic_count_mismatch: 'created' with only 2 topics returns MalformedEventError", () => {
    const ev = makeCreatedEvent();
    // Keep only topics[0] (symbol) and topics[1] (sender) — missing beneficiary and hashlock
    const shortTopics = ev.topic.slice(0, 2);
    const result = decodeHtlcEvent(shortTopics, ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    const err = result as MalformedEventError;
    expect(err.reason).toBe("topic_count_mismatch");
    expect(err.kind).toBe("created");
  });

  it("topic_count_mismatch: 'claimed' with only 1 topic returns MalformedEventError", () => {
    const ev = makeClaimedEvent();
    const result = decodeHtlcEvent(ev.topic.slice(0, 1), ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("topic_count_mismatch");
    expect((result as MalformedEventError).kind).toBe("claimed");
  });

  it("topic_count_mismatch: 'refunded' with only 2 topics but missing hashlock returns MalformedEventError", () => {
    const ev = makeRefundedEvent();
    const result = decodeHtlcEvent(ev.topic.slice(0, 2), ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("topic_count_mismatch");
  });

  it("topic_type_mismatch: 'created' with non-bytes hashlock topic returns MalformedEventError", () => {
    const ev = makeCreatedEvent();
    // Replace topics[3] (hashlock bytes) with a u64 symbol — wrong type
    const badHashlock = nativeToScVal(999n, { type: "u64" }) as xdr.ScVal;
    const badTopics: xdr.ScVal[] = [ev.topic[0]!, ev.topic[1]!, ev.topic[2]!, badHashlock];
    const result = decodeHtlcEvent(badTopics, ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("topic_type_mismatch");
    expect((result as MalformedEventError).detail).toContain("hashlock");
  });

  it("topic_type_mismatch: 'claimed' with integer beneficiary topic returns MalformedEventError", () => {
    const ev = makeClaimedEvent();
    // Replace topics[1] (beneficiary address) with a symbol
    const notAddr = nativeToScVal("not_an_address", { type: "symbol" }) as xdr.ScVal;
    // topics[0]=claimed, topics[1]=BAD, topics[2]=hashlock
    const badTopics: xdr.ScVal[] = [ev.topic[0]!, notAddr, ev.topic[2]!];
    const result = decodeHtlcEvent(badTopics, ev.value);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("topic_type_mismatch");
    expect((result as MalformedEventError).detail).toContain("beneficiary");
  });

  it("data_count_mismatch: 'created' with only 4 data elements returns MalformedEventError", () => {
    const ev = makeCreatedEvent();
    // Re-build the data vec with 4 elements instead of 5 (missing timelock)
    const original = scValToNative(ev.value) as unknown[];
    const truncated = original.slice(0, 4);
    const shortData = nativeToScVal(truncated) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, shortData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("data_count_mismatch");
    expect((result as MalformedEventError).kind).toBe("created");
  });

  it("data_count_mismatch: 'claimed' with only 2 data elements returns MalformedEventError", () => {
    const ev = makeClaimedEvent();
    const original = scValToNative(ev.value) as unknown[];
    const shortData = nativeToScVal(original.slice(0, 2)) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, shortData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("data_count_mismatch");
  });

  it("data_count_mismatch: 'refunded' with empty data returns MalformedEventError", () => {
    const ev = makeRefundedEvent();
    const emptyData = nativeToScVal([]) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, emptyData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("data_count_mismatch");
  });

  it("data_type_mismatch: 'created' with string orderId returns MalformedEventError", () => {
    const ev = makeCreatedEvent();
    const original = scValToNative(ev.value) as unknown[];
    // Replace data[0] (orderId bigint) with a plain number
    const badData = nativeToScVal([42, ...original.slice(1)]) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, badData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("data_type_mismatch");
    expect((result as MalformedEventError).detail).toContain("order_id");
  });

  it("data_type_mismatch: 'claimed' with string orderId returns MalformedEventError", () => {
    const ev = makeClaimedEvent();
    const original = scValToNative(ev.value) as unknown[];
    const badData = nativeToScVal(["not-a-bigint", ...original.slice(1)]) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, badData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("data_type_mismatch");
  });

  it("data_type_mismatch: 'refunded' with non-bigint orderId returns MalformedEventError", () => {
    const ev = makeRefundedEvent();
    // Build a Vec with a single string element
    const badData = nativeToScVal(["oops"]) as xdr.ScVal;
    const result = decodeHtlcEvent(ev.topic, badData);
    expect(isMalformedEvent(result)).toBe(true);
    expect((result as MalformedEventError).reason).toBe("data_type_mismatch");
  });
});

// ─── isMalformedEvent type-guard ──────────────────────────────────────────────

describe("isMalformedEvent", () => {
  it("returns false for a valid DecodedHtlcEvent", () => {
    const result = decodeFixture(makeCreatedEvent());
    expect(isMalformedEvent(result)).toBe(false);
  });

  it("returns false for null (unknown topic)", () => {
    expect(isMalformedEvent(null)).toBe(false);
  });

  it("returns true for a MalformedEventError object", () => {
    const err: MalformedEventError = {
      isMalformed: true,
      kind: "created",
      reason: "data_not_array",
      detail: "test",
    };
    expect(isMalformedEvent(err)).toBe(true);
  });

  it("returns false for plain objects that lack isMalformed:true", () => {
    expect(isMalformedEvent({ kind: "created" } as any)).toBe(false);
    expect(isMalformedEvent({ isMalformed: false } as any)).toBe(false);
  });
});

// ─── Schema version ───────────────────────────────────────────────────────────

describe("HTLC_EVENT_SCHEMA_VERSION", () => {
  it("is the integer 1", () => {
    expect(HTLC_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it("is present on every decoded event kind", () => {
    const created = decodeFixture(makeCreatedEvent()) as CreatedEvent;
    const claimed = decodeFixture(makeClaimedEvent()) as ClaimedEvent;
    const refunded = decodeFixture(makeRefundedEvent()) as RefundedEvent;
    for (const ev of [created, claimed, refunded]) {
      expect(ev.schemaVersion).toBe(HTLC_EVENT_SCHEMA_VERSION);
    }
  });
});

// ─── Determinism: same fixture always produces same result ───────────────────

describe("decodeHtlcEvent — determinism", () => {
  it("returns bitwise-identical results for repeated calls with the same XDR", () => {
    const ev = makeCreatedEvent();
    const r1 = decodeHtlcEvent(ev.topic, ev.value) as CreatedEvent;
    const r2 = decodeHtlcEvent(ev.topic, ev.value) as CreatedEvent;
    expect(r1.orderId).toBe(r2.orderId);
    expect(r1.hashlock).toBe(r2.hashlock);
    expect(r1.timelock).toBe(r2.timelock);
    expect(r1.sender).toBe(r2.sender);
    expect(r1.amount).toBe(r2.amount);
  });

  it("never throws regardless of input shape", () => {
    const garbage = [null, undefined, {}, [], 0, "bad"] as any[];
    for (const val of garbage) {
      expect(() => decodeHtlcEvent([], val)).not.toThrow();
      expect(() => decodeHtlcEvent([val], val)).not.toThrow();
    }
  });
});
