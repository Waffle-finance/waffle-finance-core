import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The coordinator uses Node's built-in SQLite driver (node:sqlite).
const require = createRequire(import.meta.url);
const { DatabaseSync: Database } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("../src/retention/retention-policy.js").RetentionDb & {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): any;
  };
};
import {
  RETENTION_POLICY,
  runRetentionCleanup,
  type RetentionDb,
} from "../src/retention/retention-policy.js";
import { redactSensitiveFields } from "../src/sensitive/sensitive-fields.js";

const NOW = 1_800_000_000;

type TestDb = InstanceType<typeof Database>;

function freshDb(): TestDb {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-retention-"));
  const db = new Database(join(dir, "test.db"));
  db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      public_id TEXT,
      status TEXT,
      preimage TEXT,
      preimage_enc_version INTEGER,
      archived_at INTEGER,
      created_at INTEGER
    );
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT, created_at INTEGER);
    CREATE TABLE order_events (id INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT, created_at INTEGER);
    CREATE TABLE processed_events (event_key TEXT PRIMARY KEY, created_at INTEGER);
  `);
  return db;
}

function seed(db: TestDb): void {
  const insert = db.prepare(
    "INSERT INTO orders (id, public_id, status, preimage, preimage_enc_version, archived_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Expired + archived: eligible for ciphertext clearing.
  insert.run(1, "expired-1", "expired", "0xdeadbeef", 1, NOW - 40 * 86400, NOW - 40 * 86400);
  // Active settlement: never touched even though old.
  insert.run(2, "active-1", "dst_locked", "0xabcdef", 1, null, NOW - 100 * 86400);
  // Terminal but not archived: still needed for recovery.
  insert.run(3, "recent-1", "refunded", "0xfeedface", 1, null, NOW - 100 * 86400);

  db.prepare("INSERT INTO audit_log (id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(1, "order.secret_revealed", '{"publicId":"expired-1"}', NOW - 500 * 86400);
  db.prepare("INSERT INTO order_events (id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)")
    .run(1, "secret_revealed.transitioned", '{"publicId":"expired-1"}', NOW - 500 * 86400);
  db.prepare("INSERT INTO processed_events (event_key, created_at) VALUES (?, ?)")
    .run("eth:OrderClaimed:old:1", NOW - 30 * 86400);
  db.prepare("INSERT INTO processed_events (event_key, created_at) VALUES (?, ?)")
    .run("eth:OrderCreated:new:1", NOW - 1 * 86400);
}

function row(db: TestDb, sql: string, ...params: unknown[]): any {
  return db.prepare(sql).get(...params);
}

describe("sensitive-data retention policy (#1134)", () => {
  it("classifies every sensitive category with a documented duration and rule", () => {
    expect(RETENTION_POLICY.map((r) => r.retentionClass)).toEqual([
      "active_settlement",
      "legal_audit",
      "secret_ciphertext",
      "order_history",
      "request_metadata",
    ]);
    expect(RETENTION_POLICY.every((r) => r.reason.length > 0 && r.retentionDays >= 0)).toBe(true);
  });

  it("clears expired ciphertext, preserves active recovery data, and deletes expired metadata", () => {
    const db = freshDb();
    seed(db);
    const report = runRetentionCleanup(db as unknown as RetentionDb, NOW);

    const ciphertext = report.entries.find((e) => e.retentionClass === "secret_ciphertext")!;
    const metadata = report.entries.find((e) => e.retentionClass === "request_metadata")!;
    expect(ciphertext.removed).toBe(1);
    expect(metadata.removed).toBe(1);

    // Archived terminal secret is gone from the row.
    expect(row(db, "SELECT preimage, preimage_enc_version FROM orders WHERE id = 1")).toEqual({
      preimage: null,
      preimage_enc_version: null,
    });
    // Active and non-archived order secrets remain available for recovery.
    expect(row(db, "SELECT preimage FROM orders WHERE id = 2").preimage).toBe("0xabcdef");
    expect(row(db, "SELECT preimage FROM orders WHERE id = 3").preimage).toBe("0xfeedface");
    // Only expired request metadata removed.
    expect(row(db, "SELECT event_key FROM processed_events WHERE event_key = 'eth:OrderClaimed:old:1'")).toBeUndefined();
    expect(row(db, "SELECT event_key FROM processed_events WHERE event_key = 'eth:OrderCreated:new:1'").event_key)
      .toBe("eth:OrderCreated:new:1");
    db.close();
  });

  it("keeps audit records and order history under legal hold", () => {
    const db = freshDb();
    seed(db);
    const report = runRetentionCleanup(db as unknown as RetentionDb, NOW);
    for (const klass of ["legal_audit", "order_history", "active_settlement"] as const) {
      const entry = report.entries.find((e) => e.retentionClass === klass)!;
      expect(entry.mode).toBe("retain");
      expect(entry.removed).toBe(0);
    }
    expect(row(db, "SELECT COUNT(*) AS n FROM audit_log").n).toBe(1);
    expect(row(db, "SELECT COUNT(*) AS n FROM order_events").n).toBe(1);
    expect(row(db, "SELECT COUNT(*) AS n FROM orders").n).toBe(3);
    db.close();
  });

  it("produces an auditable report and removed values never appear in exports or logs", () => {
    const db = freshDb();
    seed(db);
    const report = runRetentionCleanup(db as unknown as RetentionDb, NOW);
    expect(report.executedAt).toBe(NOW);
    expect(report.entries.every((e) => e.cutoff <= NOW && e.inspected >= 0 && e.retained >= 0)).toBe(true);

    const remaining = db.prepare("SELECT public_id AS publicId, preimage FROM orders").all();
    const exportJson = JSON.stringify(redactSensitiveFields(remaining));
    expect(exportJson).not.toContain("deadbeef");
    expect(JSON.stringify(report)).not.toContain("deadbeef");
    db.close();
  });

  it("is idempotent: a second run removes nothing", () => {
    const db = freshDb();
    seed(db);
    runRetentionCleanup(db as unknown as RetentionDb, NOW);
    const second = runRetentionCleanup(db as unknown as RetentionDb, NOW);
    expect(second.entries.every((e) => e.removed === 0)).toBe(true);
    expect(createHash("sha256").update("retention").digest("hex")).toHaveLength(64);
    db.close();
  });
});
