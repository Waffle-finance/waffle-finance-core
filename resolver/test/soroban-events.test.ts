/**
 * Unit tests for decodeSorobanHtlcEvent and SorobanEventDecodeError.
 *
 * This file does NOT mock @stellar/stellar-sdk — the real xdr / nativeToScVal
 * / Address implementations are needed to build valid XDR fixture bytes and
 * to exercise the decoder end-to-end.
 */
import { describe, it, expect } from "vitest";
import { xdr, nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import {
  decodeSorobanHtlcEvent,
  SorobanEventDecodeError,
} from "../src/listeners/soroban-events.js";

// ── Fixture addresses ────────────────────────────────────────────────────────
// Use fixed raw 32-byte buffers so we don't depend on Keypair.fromSecret
// (which requires a valid checksum-encoded secret) or Address constructor
// (which can fail under Vitest's module transform).  We derive the expected
// strkeys directly from the raw bytes using StrKey encoders.
const SENDER_BYTES = Buffer.from("aabbccdd".repeat(8), "hex"); // 32 bytes
const BENE_BYTES   = Buffer.from("11223344".repeat(8), "hex"); // 32 bytes
const ASSET_BYTES  = Buffer.from("deadbeef".repeat(8), "hex"); // 32 bytes

const SENDER = StrKey.encodeEd25519PublicKey(SENDER_BYTES);
const BENE   = StrKey.encodeEd25519PublicKey(BENE_BYTES);
const ASSET  = StrKey.encodeContract(ASSET_BYTES);

const HASHLOCK_BUF = Buffer.alloc(32, 0xab);
const PREIMAGE_BUF = Buffer.from("deadbeef", "hex");
const HASHLOCK_HEX = HASHLOCK_BUF.toString("hex");
const PREIMAGE_HEX = PREIMAGE_BUF.toString("hex");

const META = { ledger: 200, txHash: "txabc", contractId: "CCONTRACT" };

// ── XDR encoding helpers ─────────────────────────────────────────────────────
function b64(v: xdr.ScVal): string { return v.toXDR("base64"); }
function sym(s: string)  { return nativeToScVal(s, { type: "symbol" }); }

/** Build an scvAddress ScVal directly from raw key bytes — no StrKey round-trip. */
function addrAccount(raw: Buffer) {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(xdr.AccountId.publicKeyTypeEd25519(raw)),
  );
}
function addrContract(raw: Buffer) {
  return xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeContract(raw));
}

function addrSender()  { return addrAccount(SENDER_BYTES); }
function addrBene()    { return addrAccount(BENE_BYTES); }
function addrAsset()   { return addrContract(ASSET_BYTES); }

function u64(n: bigint)  { return nativeToScVal(n, { type: "u64" }); }
function i128(n: bigint) { return nativeToScVal(n, { type: "i128" }); }
function byts(b: Buffer) { return nativeToScVal(b, { type: "bytes" }); }
function vec(...els: xdr.ScVal[]) { return xdr.ScVal.scvVec(els); }

// ── Canonical fixture builders ───────────────────────────────────────────────
function createdTopics() {
  return [sym("created"), addrSender(), addrBene(), byts(HASHLOCK_BUF)].map(b64);
}
function createdValue() {
  return b64(vec(u64(1n), addrAsset(), i128(1000n), i128(50n), u64(9999999n)));
}
function claimedTopics() {
  return [sym("claimed"), addrBene(), byts(HASHLOCK_BUF)].map(b64);
}
function claimedValue() {
  return b64(vec(u64(1n), addrSender(), byts(PREIMAGE_BUF), i128(1000n), i128(50n)));
}
function refundedTopics() {
  return [sym("refunded"), addrSender(), byts(HASHLOCK_BUF)].map(b64);
}
function refundedValue() {
  return b64(vec(u64(1n), addrBene(), i128(1000n), i128(50n)));
}

// ── "created" ────────────────────────────────────────────────────────────────
describe("decodeSorobanHtlcEvent — created", () => {
  it("decodes a well-formed created event into a typed object", () => {
    const result = decodeSorobanHtlcEvent(createdTopics(), createdValue(), META);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("created");
    if (result!.type !== "created") return;
    expect(result.orderId).toBe(1n);
    expect(result.sender).toBe(SENDER);
    expect(result.beneficiary).toBe(BENE);
    expect(result.asset).toBe(ASSET);
    expect(result.amount).toBe(1000n);
    expect(result.safetyDeposit).toBe(50n);
    expect(result.hashlock).toBe(HASHLOCK_HEX);
    expect(result.timelock).toBe(9999999n);
    expect(result.ledger).toBe(META.ledger);
    expect(result.txHash).toBe(META.txHash);
    expect(result.contractId).toBe(META.contractId);
  });

  it("throws SorobanEventDecodeError when value tuple is too short", () => {
    const badValue = b64(vec(u64(1n), addrAsset())); // only 2 elements
    expect(() =>
      decodeSorobanHtlcEvent(createdTopics(), badValue, META),
    ).toThrow(SorobanEventDecodeError);
  });

  it("throws SorobanEventDecodeError when topics array is too short", () => {
    const shortTopics = [b64(sym("created"))]; // missing sender/bene/hashlock
    expect(() =>
      decodeSorobanHtlcEvent(shortTopics, createdValue(), META),
    ).toThrow(SorobanEventDecodeError);
  });

  it("throws SorobanEventDecodeError when value is a scalar, not a vector", () => {
    const scalarValue = b64(u64(42n));
    expect(() =>
      decodeSorobanHtlcEvent(createdTopics(), scalarValue, META),
    ).toThrow(SorobanEventDecodeError);
  });
});

// ── "claimed" ────────────────────────────────────────────────────────────────
describe("decodeSorobanHtlcEvent — claimed", () => {
  it("decodes a well-formed claimed event into a typed object", () => {
    const result = decodeSorobanHtlcEvent(claimedTopics(), claimedValue(), META);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("claimed");
    if (result!.type !== "claimed") return;
    expect(result.orderId).toBe(1n);
    expect(result.beneficiary).toBe(BENE);
    expect(result.caller).toBe(SENDER);
    expect(result.preimage).toBe(PREIMAGE_HEX);
    expect(result.amount).toBe(1000n);
    expect(result.safetyDeposit).toBe(50n);
    expect(result.hashlock).toBe(HASHLOCK_HEX);
  });

  it("throws SorobanEventDecodeError when topics array is too short", () => {
    const shortTopics = [b64(sym("claimed"))];
    expect(() =>
      decodeSorobanHtlcEvent(shortTopics, claimedValue(), META),
    ).toThrow(SorobanEventDecodeError);
  });

  it("throws SorobanEventDecodeError when value tuple is too short", () => {
    const badValue = b64(vec(u64(1n), addrSender())); // only 2 elements
    expect(() =>
      decodeSorobanHtlcEvent(claimedTopics(), badValue, META),
    ).toThrow(SorobanEventDecodeError);
  });
});

// ── "refunded" ───────────────────────────────────────────────────────────────
describe("decodeSorobanHtlcEvent — refunded", () => {
  it("decodes a well-formed refunded event into a typed object", () => {
    const result = decodeSorobanHtlcEvent(refundedTopics(), refundedValue(), META);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("refunded");
    if (result!.type !== "refunded") return;
    expect(result.orderId).toBe(1n);
    expect(result.refundAddress).toBe(SENDER);
    expect(result.caller).toBe(BENE);
    expect(result.amount).toBe(1000n);
    expect(result.safetyDeposit).toBe(50n);
    expect(result.hashlock).toBe(HASHLOCK_HEX);
  });

  it("throws SorobanEventDecodeError when topics array is too short", () => {
    const shortTopics = [b64(sym("refunded"))];
    expect(() =>
      decodeSorobanHtlcEvent(shortTopics, refundedValue(), META),
    ).toThrow(SorobanEventDecodeError);
  });

  it("throws SorobanEventDecodeError when value tuple is too short", () => {
    const badValue = b64(vec(u64(1n)));
    expect(() =>
      decodeSorobanHtlcEvent(refundedTopics(), badValue, META),
    ).toThrow(SorobanEventDecodeError);
  });
});

// ── Unknown / non-HTLC events ─────────────────────────────────────────────────
describe("decodeSorobanHtlcEvent — unknown events", () => {
  it("returns null for an admin-transfer event (adm_xfer symbol)", () => {
    const topics = [
      sym("adm_xfer"), sym("proposed"), addrSender(), addrBene(),
    ].map(b64);
    const value = b64(vec(addrSender(), addrBene()));
    expect(decodeSorobanHtlcEvent(topics, value, META)).toBeNull();
  });

  it("returns null for a config event (cfg symbol)", () => {
    const topics = [b64(sym("cfg")), b64(sym("min_sd"))];
    const value  = b64(vec(i128(0n), i128(100n)));
    expect(decodeSorobanHtlcEvent(topics, value, META)).toBeNull();
  });

  it("returns null for a completely arbitrary symbol", () => {
    expect(
      decodeSorobanHtlcEvent([b64(sym("xyzzy"))], createdValue(), META),
    ).toBeNull();
  });

  it("returns null when the topics array is empty", () => {
    expect(decodeSorobanHtlcEvent([], createdValue(), META)).toBeNull();
  });

  it("returns null when the first topic is raw bytes (not a symbol)", () => {
    const bytesFirst = [b64(byts(Buffer.from("notasymbol")))];
    expect(decodeSorobanHtlcEvent(bytesFirst, createdValue(), META)).toBeNull();
  });
});

// ── SorobanEventDecodeError identity ─────────────────────────────────────────
describe("SorobanEventDecodeError", () => {
  it("carries eventName, reason, and correct .name on the thrown error", () => {
    const scalarValue = b64(u64(42n)); // scalar instead of vec
    let caught: SorobanEventDecodeError | undefined;
    try {
      decodeSorobanHtlcEvent(createdTopics(), scalarValue, META);
    } catch (e) {
      if (e instanceof SorobanEventDecodeError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.eventName).toBe("created");
    expect(caught!.reason).toMatch(/array/i);
    expect(caught!.name).toBe("SorobanEventDecodeError");
    expect(caught!.message).toContain("created");
  });

  it("is an instance of Error", () => {
    const scalarValue = b64(u64(42n));
    expect(() =>
      decodeSorobanHtlcEvent(createdTopics(), scalarValue, META),
    ).toThrow(Error);
  });
});
