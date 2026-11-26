/**
 * Retention and archival boundary tests for order records.
 *
 * Every age-based policy uses a strict cutoff: a row is eligible only when
 * `created_at < now - window`. These tests place rows one second before, at,
 * and one second after each threshold, then check that both archival jobs
 * (ArchivalPolicy and StaleCleanupService) and the sensitive-data retention
 * rules agree. The clock is controlled with fake timers so the boundaries are
 * exact, and repeated runs must be idempotent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Database } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { ArchivalPolicy } from "../src/archival/archival-policy.js";
import { StaleCleanupService } from "../src/services/stale-cleanup.js";
import { OrderExportService } from "../src/services/order-export.js";
import { AuditRepository } from "../src/audit/audit-repo.js";
import { runRetentionCleanup, type RetentionDb } from "../src/retention/retention-policy.js";

// `kysely` and `@wormhole/config` are imported at load time by modules in this
// graph but are not declared in any package.json. See reconciler-checkpoints.test.ts.
vi.mock("kysely", () => ({
  Kysely: class Kysely {},
  PostgresDialect: class PostgresDialect {},
  SqliteDialect: class SqliteDialect {},
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

vi.mock("@wormhole/config", () => ({
  ConfigValidationError: class ConfigValidationError extends Error {},
  isSecretFieldName: () => false,
  redactSecretValue: (value: unknown) => String(value),
  validateAddressFormat: () => [],
  validateNetworkModeChainId: () => [],
}));

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/persistence/schema.sql");
const log = pino({ level: "silent" });

const DAY = 86_400;
const RETENTION_DAYS = 30;
const WINDOW = RETENTION_DAYS * DAY;
const NOW = 1_762_000_000; // fixed unix seconds (2025-11-01); kept below the real SQLite clock so `updated_at` stays valid
const CUTOFF = NOW - WINDOW;
const ETH_ADDR = "0x1111111111111111111111111111111111111111";
const STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

/** Raw handle plus the repository objects built on top of it. */
interface Harness {
  db: InstanceType<typeof DatabaseSync>;
  repo: OrdersRepository;
  orders: OrderService;
}

function openHarness(): Harness {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-retention-test-"));
  const db = new DatabaseSync(`${dir}/test.db`);
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  const repo = new OrdersRepository(db as unknown as Database);
  return { db, repo, orders: new OrderService(repo, log) };
}

let hashlockSeq = 0;

/** Announce an order and pin its created_at, status and src lock directly in SQL. */
async function makeOrder(
  h: Harness,
  opts: { createdAt: number; status?: string; srcOrderId?: string | null; preimage?: string | null },
): Promise<string> {
  hashlockSeq += 1;
  const hashlock = "0x" + hashlockSeq.toString(16).padStart(64, "0");
  const order = await h.orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar",
    dstAddress: STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "100000000",
  });
  h.db
    .prepare(
      "UPDATE orders SET created_at = ?, updated_at = ?, status = ?, src_order_id = ?, preimage = ? WHERE public_id = ?",
    )
    .run(
      opts.createdAt,
      opts.createdAt,
      opts.status ?? "announced",
      opts.srcOrderId ?? null,
      opts.preimage ?? null,
      order.publicId,
    );
  return order.publicId;
}

function archivedAt(h: Harness, publicId: string): number | null {
  const row = h.db.prepare("SELECT archived_at FROM orders WHERE public_id = ?").get(publicId) as
    | { archived_at: number | null }
    | undefined;
  return row?.archived_at ?? null;
}

function statusOf(h: Harness, publicId: string): string | undefined {
  const row = h.db.prepare("SELECT status FROM orders WHERE public_id = ?").get(publicId) as
    | { status: string }
    | undefined;
  return row?.status;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Archival threshold ──────────────────────────────────────────────────────

describe("retention boundary — 30-day archival threshold", () => {
  it("selects an order created one second before the cutoff, and no others", async () => {
    const h = openHarness();
    const before = await makeOrder(h, { createdAt: CUTOFF - 1 });
    const atCutoff = await makeOrder(h, { createdAt: CUTOFF });
    const afterCutoff = await makeOrder(h, { createdAt: CUTOFF + 1 });

    const stale = await h.repo.findStaleAnnounced(WINDOW);
    expect(stale.map((o) => o.publicId)).toEqual([before]);
    expect(stale.map((o) => o.publicId)).not.toContain(atCutoff);
    expect(stale.map((o) => o.publicId)).not.toContain(afterCutoff);
  });

  it("gives the same answer from the ArchivalPolicy decision function as from the repository", async () => {
    const h = openHarness();
    const policy = new ArchivalPolicy(h.repo, log, RETENTION_DAYS);
    await makeOrder(h, { createdAt: CUTOFF - 1 });
    await makeOrder(h, { createdAt: CUTOFF });
    await makeOrder(h, { createdAt: CUTOFF + 1 });

    const rows = await h.repo.findStaleAnnounced(WINDOW);
    const staleIds = new Set(rows.map((o) => o.publicId));
    const allRows = h.db
      .prepare("SELECT public_id, status, src_order_id, archived_at, created_at FROM orders ORDER BY created_at")
      .all() as Array<{ public_id: string; status: string; src_order_id: string | null; archived_at: number | null; created_at: number }>;

    for (const row of allRows) {
      const worthy = policy.isArchivalWorthy({
        status: row.status,
        srcOrderId: row.src_order_id,
        archivedAt: row.archived_at,
        createdAt: row.created_at,
      });
      expect(worthy).toBe(staleIds.has(row.public_id));
    }
  });

  it.each([
    ["ArchivalPolicy", async (h: Harness) => (await new ArchivalPolicy(h.repo, log, RETENTION_DAYS).runArchival()).archivedCount],
    ["StaleCleanupService", async (h: Harness) => (await new StaleCleanupService(h.repo, log, RETENTION_DAYS).run()).archivedCount],
  ])("%s archives only the order one second past the cutoff", async (_name, runJob) => {
    const h = openHarness();
    const before = await makeOrder(h, { createdAt: CUTOFF - 1 });
    const atCutoff = await makeOrder(h, { createdAt: CUTOFF });
    const afterCutoff = await makeOrder(h, { createdAt: CUTOFF + 1 });

    expect(await runJob(h)).toBe(1);
    expect(archivedAt(h, before)).not.toBeNull();
    expect(archivedAt(h, atCutoff)).toBeNull();
    expect(archivedAt(h, afterCutoff)).toBeNull();
  });

  it("moves the threshold with the clock: the boundary order becomes eligible one second later", async () => {
    const h = openHarness();
    const atCutoff = await makeOrder(h, { createdAt: CUTOFF });
    expect((await h.repo.findStaleAnnounced(WINDOW)).map((o) => o.publicId)).not.toContain(atCutoff);

    vi.setSystemTime((NOW + 1) * 1000);
    expect((await h.repo.findStaleAnnounced(WINDOW)).map((o) => o.publicId)).toContain(atCutoff);
  });
});

// ── Active, terminal and linked records ─────────────────────────────────────

describe("retention — records that must never be archived by age", () => {
  it.each([
    ["src_locked", { status: "src_locked", srcOrderId: "42" }],
    ["dst_locked", { status: "dst_locked", srcOrderId: "42" }],
    ["secret_revealed", { status: "secret_revealed", srcOrderId: "42" }],
    ["completed", { status: "completed", srcOrderId: "42" }],
    ["refunded", { status: "refunded", srcOrderId: "42" }],
    ["expired", { status: "expired", srcOrderId: null }],
    ["failed", { status: "failed", srcOrderId: null }],
    ["announced with a source lock", { status: "announced", srcOrderId: "42" }],
  ])("never archives an old %s order", async (_label, shape) => {
    const h = openHarness();
    const old = await makeOrder(h, { createdAt: CUTOFF - 10 * DAY, ...shape });

    expect(await new ArchivalPolicy(h.repo, log, RETENTION_DAYS).runArchival()).toEqual({
      archivedCount: 0,
      reason: "no_lock_within_retention_window",
    });
    expect((await new StaleCleanupService(h.repo, log, RETENTION_DAYS).run()).archivedCount).toBe(0);
    expect(archivedAt(h, old)).toBeNull();
    expect(statusOf(h, old)).toBe(shape.status);
  });

  it("never clears the ciphertext of a non-terminal order, even one archived by mistake", async () => {
    const h = openHarness();
    const live = await makeOrder(h, {
      createdAt: CUTOFF - 60 * DAY,
      status: "secret_revealed",
      srcOrderId: "7",
      preimage: "0x" + "ab".repeat(32),
    });
    h.db.prepare("UPDATE orders SET archived_at = ? WHERE public_id = ?").run(NOW, live);

    const report = runRetentionCleanup(h.db as unknown as RetentionDb, NOW);
    expect(report.entries.find((e) => e.category === "secret ciphertext")?.removed).toBe(0);
    const row = h.db.prepare("SELECT preimage FROM orders WHERE public_id = ?").get(live) as { preimage: string | null };
    expect(row.preimage).toBe("0x" + "ab".repeat(32));
  });
});

// ── Repeated execution and batch boundaries ─────────────────────────────────

describe("retention — repeated cleanup is idempotent", () => {
  it("ArchivalPolicy works through a batch-capped backlog and then does nothing", async () => {
    const h = openHarness();
    for (let i = 0; i < 3; i++) await makeOrder(h, { createdAt: CUTOFF - DAY - i });
    const policy = new ArchivalPolicy(h.repo, log, RETENTION_DAYS, 2);

    expect((await policy.runArchival()).archivedCount).toBe(2);
    expect((await policy.runArchival()).archivedCount).toBe(1);
    expect((await policy.runArchival()).archivedCount).toBe(0);
    expect((await policy.runArchival()).archivedCount).toBe(0);
  });

  it("StaleCleanupService works through a batch-capped backlog and then does nothing", async () => {
    const h = openHarness();
    for (let i = 0; i < 3; i++) await makeOrder(h, { createdAt: CUTOFF - DAY - i });
    const service = new StaleCleanupService(h.repo, log, RETENTION_DAYS, 2);

    expect((await service.run()).archivedCount).toBe(2);
    expect((await service.run()).archivedCount).toBe(1);
    expect((await service.run()).archivedCount).toBe(0);
  });

  it("does not archive an order a second time when both jobs run over the same row", async () => {
    const h = openHarness();
    const id = await makeOrder(h, { createdAt: CUTOFF - DAY });

    expect((await new ArchivalPolicy(h.repo, log, RETENTION_DAYS).runArchival()).archivedCount).toBe(1);
    const firstStamp = archivedAt(h, id);
    expect((await new StaleCleanupService(h.repo, log, RETENTION_DAYS).run()).archivedCount).toBe(0);
    expect(archivedAt(h, id)).toBe(firstStamp);
  });
});

// ── Archived rows stay reachable ────────────────────────────────────────────

describe("retention — archived rows stay available to lookup, export and audit", () => {
  it("keeps an archived announced order readable and visible to includeArchived exports only", async () => {
    const h = openHarness();
    const id = await makeOrder(h, { createdAt: CUTOFF - DAY });
    await new ArchivalPolicy(h.repo, log, RETENTION_DAYS).runArchival();

    const lookup = await h.repo.findByPublicId(id);
    expect(lookup?.status).toBe("announced");
    expect(lookup?.archivedAt).not.toBeNull();

    const exporter = new OrderExportService(h.repo, new AuditRepository(h.db as unknown as Database), log);
    expect((await exporter.exportOrder(id))?.orderId).toBe(id);
    const defaults = await exporter.exportOrders({ status: "announced" });
    expect(defaults.orders.map((o) => o.orderId)).not.toContain(id);
    const withArchived = await exporter.exportOrders({ status: "announced", includeArchived: true });
    expect(withArchived.orders.map((o) => o.orderId)).toContain(id);
  });

  it("keeps an abandoned order readable with its transition event recorded", async () => {
    const h = openHarness();
    const id = await makeOrder(h, { createdAt: CUTOFF - DAY });
    const eventsBefore = (h.db.prepare("SELECT COUNT(*) AS n FROM order_events").get() as { n: number }).n;

    await new StaleCleanupService(h.repo, log, RETENTION_DAYS).run();

    const lookup = await h.repo.findByPublicId(id);
    expect(lookup?.status).toBe("abandoned");
    expect(lookup?.archivedAt).not.toBeNull();
    const eventsAfter = (h.db.prepare("SELECT COUNT(*) AS n FROM order_events").get() as { n: number }).n;
    expect(eventsAfter).toBe(eventsBefore + 1);
    const rows = h.db.prepare("SELECT * FROM order_events").all();
    expect(JSON.stringify(rows)).toContain("abandon.transitioned");
  });
});

// ── Reactivation keeps the boundary consistent ──────────────────────────────

describe("retention — reactivation", () => {
  it("returns a reactivated order to the eligible set, and a second reactivation is a no-op", async () => {
    const h = openHarness();
    const policy = new ArchivalPolicy(h.repo, log, RETENTION_DAYS);
    const id = await makeOrder(h, { createdAt: CUTOFF - DAY });
    await policy.runArchival();

    expect(await policy.reactivateOrder(id)).toEqual({ reactivated: true, reason: "on_chain_lock_discovered" });
    expect(archivedAt(h, id)).toBeNull();
    expect((await h.repo.findStaleAnnounced(WINDOW)).map((o) => o.publicId)).toContain(id);
    expect(await policy.reactivateOrder(id)).toEqual({ reactivated: false });
  });

  it("does not reactivate an order that was never archived", async () => {
    const h = openHarness();
    const id = await makeOrder(h, { createdAt: CUTOFF + DAY });
    expect(await new ArchivalPolicy(h.repo, log, RETENTION_DAYS).reactivateOrder(id)).toEqual({ reactivated: false });
  });

  it("does not reverse a stale-cleanup abandon through reactivation", async () => {
    const h = openHarness();
    const id = await makeOrder(h, { createdAt: CUTOFF - DAY });
    await new StaleCleanupService(h.repo, log, RETENTION_DAYS).run();

    expect(await new ArchivalPolicy(h.repo, log, RETENTION_DAYS).reactivateOrder(id)).toEqual({ reactivated: false });
    expect(statusOf(h, id)).toBe("abandoned");
  });
});

// ── Sensitive-data retention rules ──────────────────────────────────────────

describe("retention rules — request metadata boundary (7 days)", () => {
  const REQUEST_WINDOW = 7 * DAY;
  const REQUEST_CUTOFF = NOW - REQUEST_WINDOW;

  function insertProcessedEvent(db: InstanceType<typeof DatabaseSync>, key: string, createdAt: number) {
    db.prepare(
      "INSERT INTO processed_events (event_key, chain, event_type, created_at) VALUES (?, 'ethereum', 'OrderCreated', ?)",
    ).run(key, createdAt);
  }

  it("removes processed-event rows one second before the cutoff and keeps rows at and after it", () => {
    const h = openHarness();
    insertProcessedEvent(h.db, "before", REQUEST_CUTOFF - 1);
    insertProcessedEvent(h.db, "at", REQUEST_CUTOFF);
    insertProcessedEvent(h.db, "after", REQUEST_CUTOFF + 1);

    const report = runRetentionCleanup(h.db as unknown as RetentionDb, NOW);
    const entry = report.entries.find((e) => e.category === "request metadata");
    expect(entry?.removed).toBe(1);
    expect(entry?.cutoff).toBe(REQUEST_CUTOFF);
    const keys = (h.db.prepare("SELECT event_key FROM processed_events ORDER BY event_key").all() as Array<{ event_key: string }>)
      .map((r) => r.event_key);
    expect(keys).toEqual(["after", "at"]);
  });

  it("is idempotent: a second run at the same instant removes nothing", () => {
    const h = openHarness();
    insertProcessedEvent(h.db, "old", REQUEST_CUTOFF - DAY);

    runRetentionCleanup(h.db as unknown as RetentionDb, NOW);
    const second = runRetentionCleanup(h.db as unknown as RetentionDb, NOW);
    expect(second.entries.find((e) => e.category === "request metadata")?.removed).toBe(0);
  });
});

describe("retention rules — secret ciphertext and audit boundaries (30 days)", () => {
  it("clears ciphertext on archived terminal orders one second past the cutoff only", async () => {
    const h = openHarness();
    const preimage = "0x" + "cd".repeat(32);
    const beforeId = await makeOrder(h, { createdAt: CUTOFF - 1, status: "expired", preimage });
    const atId = await makeOrder(h, { createdAt: CUTOFF, status: "expired", preimage });
    for (const id of [beforeId, atId]) {
      h.db.prepare("UPDATE orders SET archived_at = ? WHERE public_id = ?").run(NOW, id);
    }

    const report = runRetentionCleanup(h.db as unknown as RetentionDb, NOW);
    expect(report.entries.find((e) => e.category === "secret ciphertext")?.removed).toBe(1);
    const preimageOf = (id: string) =>
      (h.db.prepare("SELECT preimage FROM orders WHERE public_id = ?").get(id) as { preimage: string | null }).preimage;
    expect(preimageOf(beforeId)).toBeNull();
    expect(preimageOf(atId)).toBe(preimage);
  });

  it("never removes audit rows or order rows, regardless of age", () => {
    const h = openHarness();
    h.db
      .prepare("INSERT INTO audit_log (event_type, payload_json, created_at) VALUES ('test', '{}', ?)")
      .run(NOW - 10 * 365 * DAY);
    const auditBefore = (h.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    const report = runRetentionCleanup(h.db as unknown as RetentionDb, NOW);

    const audit = report.entries.find((e) => e.category === "audit records");
    expect(audit?.removed).toBe(0);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(auditBefore);
  });
});
