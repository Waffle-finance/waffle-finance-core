import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretReconciler } from "../src/reconciliation/secret-reconciler.js";
import { verifyRecoveryRecord } from "../src/reconciliation/recovery-authorization.js";

const PREIMAGE = "0x" + Buffer.alloc(32, 0xaa).toString("hex");
const HASHLOCK = "0x" + createHash("sha256").update(Buffer.alloc(32, 0xaa)).digest("hex");
const WRONG_PREIMAGE = "0x" + Buffer.alloc(32, 0xbb).toString("hex");
const TX = "0xtransaction";

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    recordId: `${TX}:7`,
    srcOrderId: "10",
    preimage: PREIMAGE,
    txHash: TX,
    source: "ethereum_log" as const,
    claimer: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

function makeOrderStub(preimage: string | null = null) {
  return {
    findBySrcOrderId: vi.fn(async () => ({
      publicId: "pub-1",
      srcOrderId: "10",
      hashlock: HASHLOCK,
      preimage,
      status: "dst_locked",
    })),
    recordSecret: vi.fn(async () => {}),
  };
}

function makeLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { log: pino({ level: "trace" }, sink), lines };
}

describe("secret recovery authorization and integrity (#1137)", () => {
  it("rejects a valid secret attached to the wrong order", async () => {
    const orders = makeOrderStub();
    const reconciler = new SecretReconciler({} as any, orders as any, pino({ level: "silent" }));
    const outcome = await reconciler._recoverOneOrder("10", PREIMAGE, TX, makeRecord({ srcOrderId: "999" }));
    expect(outcome).toBe("unauthorized_recovery");
    expect(orders.recordSecret).not.toHaveBeenCalled();
  });

  it("rejects a substituted preimage before persistence", async () => {
    const orders = makeOrderStub();
    const reconciler = new SecretReconciler({} as any, orders as any, pino({ level: "silent" }));
    const outcome = await reconciler._recoverOneOrder("10", WRONG_PREIMAGE, TX, makeRecord({ preimage: WRONG_PREIMAGE }));
    expect(outcome).toBe("invalid_preimage");
    expect(orders.recordSecret).not.toHaveBeenCalled();
  });

  it("rejects duplicate recovery record identities", async () => {
    const orders = makeOrderStub();
    const reconciler = new SecretReconciler({} as any, orders as any, pino({ level: "silent" }));
    expect(await reconciler._recoverOneOrder("10", PREIMAGE, TX, makeRecord())).toBe("recovered");
    expect(await reconciler._recoverOneOrder("10", PREIMAGE, TX, makeRecord())).toBe("unauthorized_recovery");
    expect(orders.recordSecret).toHaveBeenCalledTimes(1);
  });

  it("verifies hashlock with the canonical scheme and requires explicit identity", () => {
    const order = {
      publicId: "pub-1",
      srcOrderId: "10",
      hashlock: HASHLOCK,
      preimage: null,
      status: "dst_locked",
    };
    const validate = (p: string, h: string) =>
      ("0x" + createHash("sha256").update(Buffer.from(p.slice(2), "hex")).digest("hex")) === h ? "sha256" as const : null;
    expect(verifyRecoveryRecord(makeRecord(), order, validate)).toEqual({ ok: true, algorithm: "sha256" });
    expect(verifyRecoveryRecord(makeRecord({ recordId: "" }), order, validate)).toEqual({
      ok: false,
      reason: "missing_record_identity",
    });
    expect(verifyRecoveryRecord(makeRecord(), { ...order, srcOrderId: "11" }, validate)).toEqual({
      ok: false,
      reason: "wrong_order",
    });
  });

  it("persists a valid authorized recovery without leaking the preimage to logs", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wf-recovery-auth-"));
    const db = await openDatabase(`file:${dir}/test.db`);
    const orders = new OrderService(new OrdersRepository(db), pino({ level: "silent" }));
    const publicId = (await orders.announce({
      direction: "eth_to_xlm",
      hashlock: HASHLOCK,
      srcChain: "ethereum",
      srcAddress: "0x1111111111111111111111111111111111111111",
      srcAsset: "native",
      srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar",
      dstAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
      dstAsset: "native",
      dstAmount: "100000000",
    })).publicId;
    await orders.recordSrcLock({ publicId, orderId: "10", txHash: TX, blockNumber: 100, timelock: 9999 });

    const { log, lines } = makeLogger();
    const reconciler = new SecretReconciler({} as any, orders, log);
    expect(await reconciler._recoverOneOrder("10", PREIMAGE, TX, makeRecord())).toBe("recovered");
    expect((await orders.get(publicId))?.preimage).toBe(PREIMAGE);

    const output = lines.join("");
    expect(output).not.toContain(PREIMAGE);
    expect(output).not.toContain(PREIMAGE.slice(2));
    expect(output).toContain(TX);
    db.close();
  });
});
