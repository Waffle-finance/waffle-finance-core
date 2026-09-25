/**
 * Regression test: the reveal failure path in SecretService must never
 * include the raw preimage (secret material) in logged output.
 *
 * Strategy
 * --------
 *   1. Build a real Pino logger that captures every JSON line written to it
 *      into a string array.
 *   2. Trigger three controlled failure modes (persistence error, unknown
 *      order racing, and invalid preimage) using a sentinel secret value.
 *   3. Assert that the sentinel value does NOT appear anywhere in the
 *      captured log output while diagnostic identifiers (publicId, error
 *      code) DO appear.
 *   4. Also exercise the happy path: a successful reveal must not log the
 *      preimage either.
 *
 * The test never weakens error handling or alters successful reveals.
 */

import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import pino, { type Logger } from "pino";
import { Writable } from "node:stream";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService, OrderValidationError } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import {
  SecretStorageError,
  UnknownOrderError,
  RevealConflictError,
} from "../src/services/secret-errors.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Pino logger that captures every emitted line into a shared array.
 * Using level:"trace" ensures even debug lines are captured.
 */
function makeCapturingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = pino({ level: "trace" }, dest);
  return { log, lines };
}

/** Combine all captured lines into a single string for pattern matching. */
function allOutput(lines: string[]): string {
  return lines.join("\n");
}

/** Generate a random preimage + sha256 hashlock pair. */
function makePreimage(): { preimage: string; hashlock: string } {
  const buf = randomBytes(32);
  return {
    preimage: "0x" + buf.toString("hex"),
    hashlock: "0x" + createHash("sha256").update(buf).digest("hex"),
  };
}

/** Open a fresh isolated SQLite database. */
async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-revlog-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

/** Announce an order and advance it to src_locked so a reveal is accepted. */
async function seedLockedOrder(orders: OrderService, hashlock: string): Promise<string> {
  const order = await orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "100000000",
  });
  await orders.recordSrcLock({
    publicId: order.publicId,
    orderId: "1",
    txHash: "0xsrclock",
    blockNumber: 1,
    timelock: Math.floor(Date.now() / 1000) + 3600,
  });
  return order.publicId;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SecretService reveal — log safety regression tests", () => {
  // ── Persistence failure ───────────────────────────────────────────────────

  it("persistence failure: logs contain publicId but NOT the sentinel secret", async () => {
    const { log, lines } = makeCapturingLogger();

    // Sentinel: a distinctive hex string we can search for precisely.
    const sentinelBuf = Buffer.alloc(32, 0xaa);
    const sentinelPreimage = "0x" + sentinelBuf.toString("hex");
    const hashlock =
      "0x" + createHash("sha256").update(sentinelBuf).digest("hex");

    // Stub OrderService so recordSecret throws an unexpected DB error.
    const publicId = "wf_persistence_failure_sentinel";
    const stubOrders = {
      get: async () => ({ hashlock }),
      recordSecret: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    } as unknown as OrderService;

    const secrets = new SecretService(stubOrders, log);
    const err = await secrets
      .reveal(publicId, sentinelPreimage, "0xtx")
      .catch((e) => e);

    // Verify the failure is classified correctly.
    expect(err).toBeInstanceOf(SecretStorageError);
    expect(err.code).toBe("storage_failure");

    const output = allOutput(lines);

    // The sentinel MUST NOT appear anywhere in the log output.
    expect(output).not.toContain(sentinelPreimage);
    expect(output).not.toContain("aa".repeat(32)); // bare hex without 0x prefix

    // A diagnostic identifier (publicId) MUST still be present so failures
    // remain useful for operators.
    expect(output).toContain(publicId);
  });

  // ── Unknown order racing ──────────────────────────────────────────────────

  it("racing unknown-order failure: does not log the sentinel secret", async () => {
    const { log, lines } = makeCapturingLogger();

    const sentinelBuf = Buffer.alloc(32, 0xbb);
    const sentinelPreimage = "0x" + sentinelBuf.toString("hex");
    const hashlock =
      "0x" + createHash("sha256").update(sentinelBuf).digest("hex");

    const publicId = "wf_race_unknown_sentinel";
    const stubOrders = {
      get: async () => ({ hashlock }),
      recordSecret: async () => {
        throw new OrderValidationError("unknown order wf_race_unknown_sentinel");
      },
    } as unknown as OrderService;

    const secrets = new SecretService(stubOrders, log);
    const err = await secrets
      .reveal(publicId, sentinelPreimage, "0xtx")
      .catch((e) => e);

    expect(err).toBeInstanceOf(UnknownOrderError);

    const output = allOutput(lines);
    expect(output).not.toContain(sentinelPreimage);
    expect(output).not.toContain("bb".repeat(32));
  });

  // ── Reveal conflict ───────────────────────────────────────────────────────

  it("reveal conflict: does not log the sentinel secret", async () => {
    const { log, lines } = makeCapturingLogger();

    const sentinelBuf = Buffer.alloc(32, 0xcc);
    const sentinelPreimage = "0x" + sentinelBuf.toString("hex");
    const hashlock =
      "0x" + createHash("sha256").update(sentinelBuf).digest("hex");

    const publicId = "wf_conflict_sentinel";
    const stubOrders = {
      get: async () => ({ hashlock }),
      recordSecret: async () => {
        throw new OrderValidationError("cannot record secret from status refunded");
      },
    } as unknown as OrderService;

    const secrets = new SecretService(stubOrders, log);
    const err = await secrets
      .reveal(publicId, sentinelPreimage, "0xtx")
      .catch((e) => e);

    expect(err).toBeInstanceOf(RevealConflictError);

    const output = allOutput(lines);
    expect(output).not.toContain(sentinelPreimage);
    expect(output).not.toContain("cc".repeat(32));
  });

  // ── Successful reveal ─────────────────────────────────────────────────────

  it("successful reveal: the stored preimage never appears in log output (plaintext mode)", async () => {
    const { log, lines } = makeCapturingLogger();
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log); // plaintext mode

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedLockedOrder(orders, hashlock);
    await secrets.reveal(publicId, preimage, "0xtxhash");

    const output = allOutput(lines);
    expect(output).not.toContain(preimage);
    expect(output).not.toContain(preimage.slice(2)); // bare hex without 0x
  });

  it("successful reveal: the preimage never appears in log output (encryption enabled)", async () => {
    const { log, lines } = makeCapturingLogger();
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log, "a".repeat(64));

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedLockedOrder(orders, hashlock);
    await secrets.reveal(publicId, preimage, "0xtxhash");

    const output = allOutput(lines);
    expect(output).not.toContain(preimage);
    expect(output).not.toContain(preimage.slice(2));
  });

  // ── Error message sanity ──────────────────────────────────────────────────

  it("SecretStorageError message does not include DB internals or the secret", async () => {
    const { log } = makeCapturingLogger();

    const sentinelBuf = Buffer.alloc(32, 0xdd);
    const sentinelPreimage = "0x" + sentinelBuf.toString("hex");
    const hashlock =
      "0x" + createHash("sha256").update(sentinelBuf).digest("hex");

    const stubOrders = {
      get: async () => ({ hashlock }),
      recordSecret: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    } as unknown as OrderService;

    const secrets = new SecretService(stubOrders, log);
    const err = await secrets
      .reveal("wf_msg_check", sentinelPreimage, "0xtx")
      .catch((e) => e);

    expect(err).toBeInstanceOf(SecretStorageError);

    // Client-facing message must not leak DB internals or the secret.
    expect(err.message).not.toContain("SQLITE_BUSY");
    expect(err.message).not.toContain(sentinelPreimage);
    expect(err.message).not.toContain("dd".repeat(32));

    // The message must still be useful for diagnostics.
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(500);
  });
});
