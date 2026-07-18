/**
 * Real XDR-based ScVal fixtures for the Soroban listener unit tests.
 *
 * GENERATED — do not edit by hand.
 * Source: scripts/dump-fixtures.cjs + scripts/write-fixture-ts.cjs
 *
 * These base64 strings are the exact binary XDR that the Soroban RPC node
 * returns when the deployed HTLC contract emits its events.  They were
 * produced by @stellar/stellar-sdk v13's nativeToScVal / xdr builders using
 * the same type annotations the contract source uses:
 *
 *   created  topics: (symbol("created"), Address, Address, BytesN<32>)
 *            data:   Vec<(u64, Address, i128, i128, u64)>
 *
 *   claimed  topics: (symbol("claimed"), Address, BytesN<32>)
 *            data:   Vec<(u64, Address, Bytes, i128, i128)>
 *
 *   refunded topics: (symbol("refunded"), Address, BytesN<32>)
 *            data:   Vec<(u64, Address, i128, i128)>
 */

import { xdr, scValToNative } from "@stellar/stellar-sdk";

// ─── Test Stellar addresses ──────────────────────────────────────────────────
export const SENDER_ADDR      = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
export const BENEFICIARY_ADDR = "GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA";
export const REFUND_ADDR      = "GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC";
export const ASSET_ADDR       = "GACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAJJHP";
export const CALLER_ADDR      = "GACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKG7N";

// ─── Test scalar values ───────────────────────────────────────────────────────
/** 0x-prefixed 32-byte hashlock (all 0xaa bytes). */
export const HASHLOCK = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** 0x-prefixed 32-byte preimage (all 0xbb bytes). */
export const PREIMAGE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** Soroban order id used in fixtures (u64 = 42). */
export const ORDER_ID = "42";
/** Absolute unix-second timelock used in fixtures. */
export const TIMELOCK = 9_999_999;

// ─── Pre-baked base64 XDR ────────────────────────────────────────────────────

const CREATED_TOPICS_B64 = [
  "AAAADwAAAAdjcmVhdGVkAA==",
  "AAAAEgAAAAAAAAAAAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  "AAAAEgAAAAAAAAAAAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  "AAAADQAAACCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==",
];
const CREATED_DATA_B64 = "AAAAEAAAAAEAAAAFAAAABQAAAAAAAAAqAAAAEgAAAAAAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQAAAAKAAAAAAAAAAAN4Lazp2QAAAAAAAoAAAAAAAAAAAADjX6kxoAAAAAABQAAAAAAmJZ/";

const CLAIMED_TOPICS_B64 = [
  "AAAADwAAAAdjbGFpbWVkAA==",
  "AAAAEgAAAAAAAAAAAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  "AAAADQAAACCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==",
];
const CLAIMED_DATA_B64 = "AAAAEAAAAAEAAAAFAAAABQAAAAAAAAAqAAAAEgAAAAAAAAAABQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUAAAANAAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7AAAACgAAAAAAAAAADeC2s6dkAAAAAAAKAAAAAAAAAAAAA41+pMaAAA==";

const REFUNDED_TOPICS_B64 = [
  "AAAADwAAAAhyZWZ1bmRlZA==",
  "AAAAEgAAAAAAAAAAAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
  "AAAADQAAACCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==",
];
const REFUNDED_DATA_B64 = "AAAAEAAAAAEAAAAEAAAABQAAAAAAAAAqAAAAEgAAAAAAAAAABQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUAAAAKAAAAAAAAAAAN4Lazp2QAAAAAAAoAAAAAAAAAAAADjX6kxoAA";

/** Malformed: "created" topics but data ScVal is a symbol, not a Vec. */
const MALFORMED_DATA_B64 = "AAAADwAAAAlub3RfYV92ZWMAAAA=";

/** Unknown topic symbol — not one of created/claimed/refunded. */
const UNKNOWN_TOPIC_B64 = "AAAADwAAAA11bmtub3duX2V2ZW50AAAA";

// ─── Deserialisation helper ───────────────────────────────────────────────────

function fromB64(b64: string): xdr.ScVal {
  return xdr.ScVal.fromXDR(b64, "base64");
}

// ─── Exported fixture builders ────────────────────────────────────────────────

/**
 * Build a fake Soroban RPC event shaped exactly like
 * rpc.Server.getEvents() response items.
 * topic: xdr.ScVal[]   value: xdr.ScVal
 */
export function makeCreatedEvent(ledger = 10050, txHash = "0xstellar_created_tx") {
  return {
    ledger,
    txHash,
    topic: CREATED_TOPICS_B64.map(fromB64),
    value: fromB64(CREATED_DATA_B64),
  };
}

export function makeClaimedEvent(ledger = 10051, txHash = "0xstellar_claimed_tx") {
  return {
    ledger,
    txHash,
    topic: CLAIMED_TOPICS_B64.map(fromB64),
    value: fromB64(CLAIMED_DATA_B64),
  };
}

export function makeRefundedEvent(ledger = 10052, txHash = "0xstellar_refunded_tx") {
  return {
    ledger,
    txHash,
    topic: REFUNDED_TOPICS_B64.map(fromB64),
    value: fromB64(REFUNDED_DATA_B64),
  };
}

/** Created topics + non-Vec data — decodeHtlcEvent must return null. */
export function makeMalformedDataEvent(ledger = 10053, txHash = "0xstellar_malformed_tx") {
  return {
    ledger,
    txHash,
    topic: CREATED_TOPICS_B64.map(fromB64),
    value: fromB64(MALFORMED_DATA_B64),
  };
}

/** Single unknown-symbol topic — decodeHtlcEvent must return null. */
export function makeUnknownTopicEvent(ledger = 10054, txHash = "0xstellar_unknown_tx") {
  return {
    ledger,
    txHash,
    topic: [fromB64(UNKNOWN_TOPIC_B64)],
    value: fromB64(CREATED_DATA_B64),
  };
}

// ─── Import-time sanity assertions ────────────────────────────────────────────
// Throw during test collection if any XDR blob is malformed.

(function assertFixtures() {
  const t0 = scValToNative(fromB64(CREATED_TOPICS_B64[0]));
  if (t0 !== "created")
    throw new Error(`Fixture sanity: created topic[0] = ${t0 as string}`);

  const cd = scValToNative(fromB64(CREATED_DATA_B64)) as unknown[];
  if (!Array.isArray(cd) || cd.length < 5)
    throw new Error("Fixture sanity: created data is not a 5-element vec");
  if ((cd[0] as bigint) !== 42n)
    throw new Error(`Fixture sanity: created orderId = ${cd[0] as string}, expected 42n`);

  const t0c = scValToNative(fromB64(CLAIMED_TOPICS_B64[0]));
  if (t0c !== "claimed")
    throw new Error(`Fixture sanity: claimed topic[0] = ${t0c as string}`);

  const t0r = scValToNative(fromB64(REFUNDED_TOPICS_B64[0]));
  if (t0r !== "refunded")
    throw new Error(`Fixture sanity: refunded topic[0] = ${t0r as string}`);
})();
