/**
 * @file test/audit-log.test.ts
 *
 * Tests for the coordinator audit log system.
 *
 * Coverage areas:
 *   1. AuditRepository — write, query, cursor pagination, forOrder, tail
 *   2. AuditExporter   — replay, NDJSON, validateOrderSequences
 *   3. Integration     — OrderService writes audit entries matching state machine
 *   4. Replay fidelity — replayed sequence exactly mirrors real repo transitions
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository, type AnnounceOrderInput } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { AuditRepository } from "../src/audit/audit-repo.js";
import { AuditExporter } from "../src/audit/audit-exporter.js";
import {
  buildOrderAuditEntry,
  buildSystemAuditEntry,
  parseAuditPayload,
  AUDIT_SCHEMA_VERSION,
  type AuditEntry,
} from "../src/audit/audit-log.js";
import pino from "pino";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const HASHLOCK = "0x" + "a".repeat(64);
const ETH_ADDR  = "0x1111111111111111111111111111111111111111";
const XLM_ADDR  = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const BASE_ORDER: AnnounceOrderInput = {
  direction:        "eth_to_xlm",
  hashlock:         HASHLOCK,
  srcChain:         "ethereum",
  srcAddress:       ETH_ADDR,
  srcAsset:         "native",
  srcAmount:        "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain:         "stellar",
  dstAddress:       XLM_ADDR,
  dstAsset:         "native",
  dstAmount:        "100000000",
};

const SRC_LOCK = {
  orderId:     "src-order-1",
  txHash:      "0xsrctx",
  blockNumber: 100,
  timelock:    9999999,
};

const DST_LOCK = {
  orderId:     "dst-order-1",
  txHash:      "0xdsttx",
  blockNumber: 200,
  timelock:    9998888,
  resolver:    ETH_ADDR,
};

const silentLog = pino({ level: "silent" });

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-audit-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

async function freshSetup() {
  const db       = await freshDb();
  const ordersRepo = new OrdersRepository(db);
  const auditRepo  = new AuditRepository(db);
  const exporter   = new AuditExporter(auditRepo);
  const orders     = new OrderService(ordersRepo, silentLog, { auditRepo });
  return { db, ordersRepo, auditRepo, exporter, orders };
}

// Helper: collect a Writable stream's output as a string
function collectWritable(): { stream: Writable; getOutput: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  return { stream, getOutput: () => Buffer.concat(chunks).toString("utf8") };
}


// ─── 1. AuditRepository ───────────────────────────────────────────────────────

describe("AuditRepository.append", () => {
  it("persists a single entry and returns a positive integer id", async () => {
    const { auditRepo } = await freshSetup();
    const id = await auditRepo.append(
      buildOrderAuditEntry("order.announced", {
        orderId: "wf_0xabc",
        hashlock: HASHLOCK,
        direction: "eth_to_xlm",
        fromStatus: null,
        toStatus: "announced",
        srcChain: "ethereum",
        dstChain: "stellar",
      }),
    );
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("assigns schemaVersion = AUDIT_SCHEMA_VERSION to every row", async () => {
    const { auditRepo } = await freshSetup();
    await auditRepo.append(
      buildSystemAuditEntry("system.startup", "test start"),
    );
    const page = await auditRepo.query({});
    expect(page.entries[0].schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
  });

  it("ids are strictly ascending", async () => {
    const { auditRepo } = await freshSetup();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await auditRepo.append(
        buildSystemAuditEntry("system.startup", `event ${i}`),
      ));
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
    }
  });
});

describe("AuditRepository.query", () => {
  it("returns all entries when no filters are applied", async () => {
    const { auditRepo } = await freshSetup();
    for (let i = 0; i < 3; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    const page = await auditRepo.query({});
    expect(page.entries).toHaveLength(3);
  });

  it("filters by orderId", async () => {
    const { auditRepo } = await freshSetup();
    await auditRepo.append(buildOrderAuditEntry("order.announced", {
      orderId: "wf_order1", hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: null, toStatus: "announced", srcChain: "ethereum", dstChain: "stellar",
    }));
    await auditRepo.append(buildOrderAuditEntry("order.announced", {
      orderId: "wf_order2", hashlock: "0x" + "b".repeat(64), direction: "eth_to_xlm",
      fromStatus: null, toStatus: "announced", srcChain: "ethereum", dstChain: "stellar",
    }));
    const page = await auditRepo.query({ orderId: "wf_order1" });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.orderId).toBe("wf_order1");
  });

  it("filters by eventTypes", async () => {
    const { auditRepo } = await freshSetup();
    await auditRepo.append(buildSystemAuditEntry("system.startup", "up"));
    await auditRepo.append(buildSystemAuditEntry("system.shutdown", "down"));
    const page = await auditRepo.query({ eventTypes: ["system.shutdown"] });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.eventType).toBe("system.shutdown");
  });

  it("returns totalCount when includeCount is true", async () => {
    const { auditRepo } = await freshSetup();
    for (let i = 0; i < 4; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    const page = await auditRepo.query({ includeCount: true });
    expect(page.totalCount).toBe(4);
  });

  it("paginates correctly and nextCursor is null on last page", async () => {
    const { auditRepo } = await freshSetup();
    for (let i = 0; i < 5; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    const page1 = await auditRepo.query({ limit: 3 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await auditRepo.query({ limit: 3, cursor: page1.nextCursor! });
    expect(page2.entries).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
  });

  it("cursor pages are non-overlapping and cover all entries", async () => {
    const { auditRepo } = await freshSetup();
    const total = 7;
    for (let i = 0; i < total; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    const collected: AuditEntry[] = [];
    let cursor = undefined as import("../src/audit/audit-repo.js").AuditCursor | undefined;
    while (true) {
      const page = await auditRepo.query({ limit: 3, cursor });
      collected.push(...page.entries);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected).toHaveLength(total);
    const ids = collected.map((e) => e.id);
    // No duplicates
    expect(new Set(ids).size).toBe(total);
    // Ascending order
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
    }
  });
});

describe("AuditRepository.forOrder", () => {
  it("returns entries for a specific order in ascending id order", async () => {
    const { auditRepo } = await freshSetup();
    const oid = "wf_0xtest";
    for (const event of ["order.announced", "order.src_locked", "order.dst_locked"] as const) {
      await auditRepo.append(buildOrderAuditEntry(event, {
        orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
        fromStatus: null, toStatus: event.replace("order.", ""),
        srcChain: "ethereum", dstChain: "stellar",
      }));
    }
    // Also insert noise for another order
    await auditRepo.append(buildSystemAuditEntry("system.startup", "noise"));

    const entries = await auditRepo.forOrder(oid);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.orderId === oid)).toBe(true);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.id).toBeGreaterThan(entries[i - 1]!.id);
    }
  });
});

describe("AuditRepository.tail", () => {
  it("returns the N most recent entries in ascending order", async () => {
    const { auditRepo } = await freshSetup();
    for (let i = 0; i < 10; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    const tail = await auditRepo.tail(4);
    expect(tail).toHaveLength(4);
    // ascending
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]!.id).toBeGreaterThan(tail[i - 1]!.id);
    }
    // The 4 most recent — the total is 10 so minimum id in the tail is id[6]
    const all = await auditRepo.query({});
    const expected = all.entries.slice(-4);
    expect(tail.map((e) => e.id)).toEqual(expected.map((e) => e.id));
  });
});


// ─── 2. AuditExporter ────────────────────────────────────────────────────────

describe("AuditExporter.replay", () => {
  it("calls handler once per entry in ascending id order", async () => {
    const { auditRepo, exporter } = await freshSetup();
    for (let i = 0; i < 6; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    const seen: number[] = [];
    const result = await exporter.replay((e) => { seen.push(e.id); });
    expect(result.entriesProcessed).toBe(6);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
    }
  });

  it("respects resumeCursor so incremental replays are non-overlapping", async () => {
    const { auditRepo, exporter } = await freshSetup();
    for (let i = 0; i < 10; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    // First run: consume first 5
    const seen1: number[] = [];
    await exporter.replay((e) => { seen1.push(e.id); }, { pageSize: 5 });
    const page1 = await auditRepo.query({ limit: 5 });
    const seen2: number[] = [];
    await exporter.replay((e) => { seen2.push(e.id); }, {
      resumeCursor: page1.nextCursor!,
    });
    // Second run should not overlap with first
    expect(seen1.length).toBe(10); // full replay
    for (const id of seen2) {
      expect(page1.entries.map((e) => e.id)).not.toContain(id);
    }
  });

  it("finalCursor points to the last entry processed", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`)));
    }
    const result = await exporter.replay(() => {});
    expect(result.finalCursor?.afterId).toBe(ids[ids.length - 1]);
  });

  it("returns entriesProcessed=0 and finalCursor=null for an empty log", async () => {
    const { exporter } = await freshSetup();
    const result = await exporter.replay(() => {});
    expect(result.entriesProcessed).toBe(0);
    expect(result.finalCursor).toBeNull();
  });
});

describe("AuditExporter.exportNdjson", () => {
  it("writes one valid JSON line per entry", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const oid = "wf_0xndjson";
    await auditRepo.append(buildOrderAuditEntry("order.announced", {
      orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: null, toStatus: "announced",
      srcChain: "ethereum", dstChain: "stellar",
    }));
    await auditRepo.append(buildOrderAuditEntry("order.src_locked", {
      orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: "announced", toStatus: "src_locked",
      srcChain: "ethereum", dstChain: "stellar",
      txHash: "0xabc",
    }));

    const { stream, getOutput } = collectWritable();
    const result = await exporter.exportNdjson(stream, {});
    expect(result.entriesProcessed).toBe(2);

    const lines = getOutput().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("eventType");
      expect(parsed).toHaveProperty("createdAt");
      expect(parsed).toHaveProperty("payload");
      // payload must be the parsed object, not a raw JSON string
      expect(typeof parsed.payload).toBe("object");
    }
  });

  it("filters by orderId in the export", async () => {
    const { auditRepo, exporter } = await freshSetup();
    await auditRepo.append(buildOrderAuditEntry("order.announced", {
      orderId: "wf_target", hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: null, toStatus: "announced",
      srcChain: "ethereum", dstChain: "stellar",
    }));
    await auditRepo.append(buildOrderAuditEntry("order.announced", {
      orderId: "wf_noise", hashlock: "0x" + "c".repeat(64), direction: "eth_to_xlm",
      fromStatus: null, toStatus: "announced",
      srcChain: "ethereum", dstChain: "stellar",
    }));

    const { stream, getOutput } = collectWritable();
    await exporter.exportNdjson(stream, { orderId: "wf_target" });
    const lines = getOutput().trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).orderId).toBe("wf_target");
  });
});

describe("AuditExporter.validateOrderSequences", () => {
  it("returns no discrepancies for a valid announced→src_locked→dst_locked→secret_revealed→completed sequence", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const oid = "wf_valid";
    const transitions = [
      { event: "order.announced"       as const, from: null,             to: "announced"       },
      { event: "order.src_locked"      as const, from: "announced",      to: "src_locked"      },
      { event: "order.dst_locked"      as const, from: "src_locked",     to: "dst_locked"      },
      { event: "order.secret_revealed" as const, from: "dst_locked",     to: "secret_revealed" },
      { event: "order.completed"       as const, from: "secret_revealed", to: "completed"       },
    ];
    for (const t of transitions) {
      await auditRepo.append(buildOrderAuditEntry(t.event, {
        orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
        fromStatus: t.from, toStatus: t.to,
        srcChain: "ethereum", dstChain: "stellar",
      }));
    }
    const issues = await exporter.validateOrderSequences([oid]);
    expect(issues).toHaveLength(0);
  });

  it("reports a discrepancy when first entry is not announced", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const oid = "wf_bad_start";
    await auditRepo.append(buildOrderAuditEntry("order.src_locked", {
      orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: null, toStatus: "src_locked",
      srcChain: "ethereum", dstChain: "stellar",
    }));
    const issues = await exporter.validateOrderSequences([oid]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.issue).toMatch(/announced/i);
  });

  it("reports a discrepancy when fromStatus does not match the previous toStatus", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const oid = "wf_gap";
    await auditRepo.append(buildOrderAuditEntry("order.announced", {
      orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: null, toStatus: "announced",
      srcChain: "ethereum", dstChain: "stellar",
    }));
    // Deliberate fromStatus mismatch: says "src_locked" but real prev is "announced"
    await auditRepo.append(buildOrderAuditEntry("order.dst_locked", {
      orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: "src_locked",   // wrong — skipped a step
      toStatus: "dst_locked",
      srcChain: "ethereum", dstChain: "stellar",
    }));
    const issues = await exporter.validateOrderSequences([oid]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.issue).toMatch(/fromStatus/i);
  });

  it("reports a discrepancy when entries appear after a terminal status", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const oid = "wf_post_terminal";
    for (const [from, to, event] of [
      [null, "announced", "order.announced"],
      ["announced", "completed", "order.completed"],
    ] as const) {
      await auditRepo.append(buildOrderAuditEntry(event as any, {
        orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
        fromStatus: from as string | null, toStatus: to as string,
        srcChain: "ethereum", dstChain: "stellar",
      }));
    }
    // This entry appears after completed — invalid
    await auditRepo.append(buildOrderAuditEntry("order.refunded", {
      orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
      fromStatus: "completed", toStatus: "refunded",
      srcChain: "ethereum", dstChain: "stellar",
    }));
    const issues = await exporter.validateOrderSequences([oid]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.issue).toMatch(/terminal/i);
  });

  it("returns an issue for an orderId with no audit entries", async () => {
    const { exporter } = await freshSetup();
    const issues = await exporter.validateOrderSequences(["wf_ghost"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toMatch(/no audit entries/i);
  });

  it("reports malformed entry when toStatus field is missing", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const oid = "wf_malformed_to";
    // Manually insert a raw entry with no toStatus
    await auditRepo.append({
      eventType: "order.announced",
      orderId: oid,
      requestId: null,
      payloadJson: JSON.stringify({ fromStatus: null }),  // toStatus missing
    });
    const issues = await exporter.validateOrderSequences([oid]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.issue).toMatch(/malformed/i);
  });

  it("validates a legitimate expired lifecycle without discrepancies", async () => {
    const { auditRepo, exporter } = await freshSetup();
    const oid = "wf_expired";
    const transitions = [
      { event: "order.announced" as const, from: null,        to: "announced" },
      { event: "order.src_locked" as const, from: "announced", to: "src_locked" },
      { event: "order.expired"    as const, from: "src_locked", to: "expired"   },
    ];
    for (const t of transitions) {
      await auditRepo.append(buildOrderAuditEntry(t.event as any, {
        orderId: oid, hashlock: HASHLOCK, direction: "eth_to_xlm",
        fromStatus: t.from, toStatus: t.to,
        srcChain: "ethereum", dstChain: "stellar",
      }));
    }
    const issues = await exporter.validateOrderSequences([oid]);
    expect(issues).toHaveLength(0);
  });
});


// ─── 3. OrderService integration ─────────────────────────────────────────────

describe("OrderService audit integration", () => {
  it("writes order.announced after announce()", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    // Give the fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.eventType).toBe("order.announced");

    const payload = parseAuditPayload(entries[0]!);
    expect(payload).not.toBeNull();
    expect((payload as any).toStatus).toBe("announced");
    expect((payload as any).fromStatus).toBeNull();
    expect((payload as any).hashlock).toBe(HASHLOCK);
  });

  it("writes order.src_locked after recordSrcLock()", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    const srcEntry = entries.find((e) => e.eventType === "order.src_locked");
    expect(srcEntry).toBeDefined();
    const payload = parseAuditPayload(srcEntry!);
    expect((payload as any).toStatus).toBe("src_locked");
    expect((payload as any).fromStatus).toBe("announced");
    expect((payload as any).txHash).toBe(SRC_LOCK.txHash);
    expect((payload as any).blockNumber).toBe(SRC_LOCK.blockNumber);
  });

  it("writes order.dst_locked after recordDstLock()", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    const dstEntry = entries.find((e) => e.eventType === "order.dst_locked");
    expect(dstEntry).toBeDefined();
    const payload = parseAuditPayload(dstEntry!);
    expect((payload as any).toStatus).toBe("dst_locked");
    expect((payload as any).fromStatus).toBe("src_locked");
    expect((payload as any).resolverAddress).toBe(ETH_ADDR);
  });

  it("writes order.secret_revealed after recordSecret()", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await orders.recordSecret(order.publicId, "0xpreimage", "0xsecrettx");
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    const secretEntry = entries.find((e) => e.eventType === "order.secret_revealed");
    expect(secretEntry).toBeDefined();
    const payload = parseAuditPayload(secretEntry!);
    expect((payload as any).toStatus).toBe("secret_revealed");
    expect((payload as any).txHash).toBe("0xsecrettx");
  });

  it("writes order.completed after markStatus('completed')", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await orders.recordSecret(order.publicId, "0xpreimage", "0xsecrettx");
    await orders.markStatus(order.publicId, "completed");
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    const completedEntry = entries.find((e) => e.eventType === "order.completed");
    expect(completedEntry).toBeDefined();
    const payload = parseAuditPayload(completedEntry!);
    expect((payload as any).toStatus).toBe("completed");
    expect((payload as any).fromStatus).toBe("secret_revealed");
  });

  it("writes order.refunded after markStatus('refunded')", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.markStatus(order.publicId, "refunded");
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    expect(entries.find((e) => e.eventType === "order.refunded")).toBeDefined();
  });

  it("writes order.expired after expireStaleOrders()", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    // Record a src lock with a past timelock so it's immediately expired
    await orders.recordSrcLock({
      publicId: order.publicId, ...SRC_LOCK, timelock: 1, // epoch 1 is always in the past
    });
    await orders.expireStaleOrders(Math.floor(Date.now() / 1000));
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    expect(entries.find((e) => e.eventType === "order.expired")).toBeDefined();
  });

  it("duplicate announces are rejected and produce exactly one audit entry", async () => {
    const { orders, auditRepo } = await freshSetup();
    const order = await orders.announce(BASE_ORDER);
    await expect(orders.announce(BASE_ORDER)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    const entries = await auditRepo.forOrder(order.publicId);
    const announced = entries.filter((e) => e.eventType === "order.announced");
    expect(announced).toHaveLength(1);
  });
});


// ─── 4. Replay fidelity ───────────────────────────────────────────────────────
//
// This section is the acceptance-criteria proof: the replayed audit stream
// must exactly reflect the real repository state machine transitions.

describe("Replay fidelity — audit stream matches actual repo transitions", () => {
  it("full happy-path replay sequence matches live repo state at each step", async () => {
    const { orders, ordersRepo, auditRepo, exporter } = await freshSetup();

    // Drive the full happy path through OrderService
    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await orders.recordSecret(order.publicId, "0xpreimage", "0xsecrettx");
    await orders.markStatus(order.publicId, "completed");
    await new Promise((r) => setTimeout(r, 20));

    // Replay the audit stream for this order
    const timeline = await exporter.orderTimeline(order.publicId);
    const orderEntries = timeline.filter((e) => e.eventType.startsWith("order."));

    // Build the expected toStatus sequence from the state machine
    const expectedStatuses = [
      "announced", "src_locked", "dst_locked", "secret_revealed", "completed",
    ];
    const replayedStatuses = orderEntries.map((e) => {
      const p = parseAuditPayload(e) as any;
      return p?.toStatus as string;
    });

    expect(replayedStatuses).toEqual(expectedStatuses);

    // Confirm the live repo ended in the same final state as the audit log
    const liveOrder = await ordersRepo.findByPublicId(order.publicId);
    expect(liveOrder!.status).toBe(replayedStatuses[replayedStatuses.length - 1]);
  });

  it("refund path replay is consistent: src_locked → refunded", async () => {
    const { orders, ordersRepo, auditRepo, exporter } = await freshSetup();

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.markStatus(order.publicId, "refunded");
    await new Promise((r) => setTimeout(r, 20));

    const timeline = await exporter.orderTimeline(order.publicId);
    const statuses = timeline
      .filter((e) => e.eventType.startsWith("order."))
      .map((e) => (parseAuditPayload(e) as any)?.toStatus as string);

    expect(statuses).toEqual(["announced", "src_locked", "refunded"]);

    const live = await ordersRepo.findByPublicId(order.publicId);
    expect(live!.status).toBe("refunded");
  });

  it("validateOrderSequences finds no discrepancies for a real OrderService-driven order", async () => {
    const { orders, auditRepo, exporter } = await freshSetup();

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await orders.recordSecret(order.publicId, "0xpreimage2", "0xsecrettx2");
    await orders.markStatus(order.publicId, "completed");
    await new Promise((r) => setTimeout(r, 20));

    const issues = await exporter.validateOrderSequences([order.publicId]);
    expect(issues).toHaveLength(0);
  });

  it("NDJSON export of a full order timeline is self-contained and parseable without a DB", async () => {
    const { orders, exporter } = await freshSetup();

    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await orders.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await orders.markStatus(order.publicId, "refunded");
    await new Promise((r) => setTimeout(r, 20));

    const { stream, getOutput } = collectWritable();
    const result = await exporter.exportNdjson(stream, { orderId: order.publicId });

    // Every output line must be parseable JSON with a non-null payload
    const lines = getOutput().trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(result.entriesProcessed);

    for (const line of lines) {
      let parsed: any;
      expect(() => { parsed = JSON.parse(line); }).not.toThrow();
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("eventType");
      expect(parsed).toHaveProperty("payload");
      expect(typeof parsed.payload).toBe("object");
    }

    // The reconstructed toStatus sequence from the NDJSON equals the live statuses
    const statuses = lines
      .map((l) => JSON.parse(l))
      .map((r: any) => r.payload?.toStatus)
      .filter(Boolean);
    expect(statuses).toEqual(["announced", "src_locked", "dst_locked", "refunded"]);
  });

  it("incremental replay via resumeCursor delivers exactly the new entries", async () => {
    const { orders, auditRepo, exporter } = await freshSetup();

    // First batch
    const order = await orders.announce(BASE_ORDER);
    await orders.recordSrcLock({ publicId: order.publicId, ...SRC_LOCK });
    await new Promise((r) => setTimeout(r, 20));

    const run1: number[] = [];
    const r1 = await exporter.replay((e) => { run1.push(e.id); });

    // Second batch — new transitions happen after the first replay
    await orders.recordDstLock({ publicId: order.publicId, ...DST_LOCK });
    await orders.recordSecret(order.publicId, "0xpreimage", "0xsecrettx");
    await orders.markStatus(order.publicId, "completed");
    await new Promise((r) => setTimeout(r, 20));

    const run2: number[] = [];
    await exporter.replay((e) => { run2.push(e.id); }, {
      resumeCursor: r1.finalCursor!,
    });

    // No id in run2 should appear in run1
    const run1Set = new Set(run1);
    for (const id of run2) {
      expect(run1Set.has(id)).toBe(false);
    }

    // run2 must contain the dst_locked and completed events
    const all = await auditRepo.query({});
    const newIds = all.entries.filter((e) => e.id > r1.finalCursor!.afterId).map((e) => e.id);
    expect(run2.sort()).toEqual(newIds.sort());
  });
});


// ─── Boundary / validation tests added for bug fixes ─────────────────────────

// ── (b) + (c): zero and negative limit in AuditRepository.query ──────────────

describe("AuditRepository.query — limit boundary validation", () => {
  it("throws RangeError for a zero limit", async () => {
    const { auditRepo } = await freshSetup();
    await expect(auditRepo.query({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(auditRepo.query({ limit: 0 })).rejects.toThrow(/limit must be a positive integer/i);
  });

  it("throws RangeError for a negative limit", async () => {
    const { auditRepo } = await freshSetup();
    await expect(auditRepo.query({ limit: -1 })).rejects.toThrow(RangeError);
    await expect(auditRepo.query({ limit: -1 })).rejects.toThrow(/limit must be a positive integer/i);
  });

  it("accepts a positive limit without throwing", async () => {
    const { auditRepo } = await freshSetup();
    for (let i = 0; i < 3; i++) {
      await auditRepo.append(buildSystemAuditEntry("system.startup", `e${i}`));
    }
    // Should resolve normally and return at most 2 entries
    const page = await auditRepo.query({ limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});

// ── (d): malformed JSON payload in AuditRepository.append ────────────────────

describe("AuditRepository.append — payload JSON validation", () => {
  it("throws SyntaxError for malformed JSON and does not insert a row", async () => {
    const { auditRepo } = await freshSetup();

    const badEntry = {
      eventType: "system.startup" as const,
      orderId: null,
      requestId: null,
      payloadJson: "{not valid json",
    };

    await expect(auditRepo.append(badEntry)).rejects.toThrow(SyntaxError);
    await expect(auditRepo.append(badEntry)).rejects.toThrow(/payloadJson is not valid JSON/i);

    // Confirm nothing was written to the table
    const page = await auditRepo.query({});
    expect(page.entries).toHaveLength(0);
  });

  it("accepts a valid JSON payload and inserts the row", async () => {
    const { auditRepo } = await freshSetup();
    const id = await auditRepo.append(
      buildSystemAuditEntry("system.startup", "valid entry"),
    );
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);

    const page = await auditRepo.query({});
    expect(page.entries).toHaveLength(1);
  });
});
