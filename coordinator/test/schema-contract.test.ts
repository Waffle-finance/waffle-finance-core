import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  openDatabase,
  CURRENT_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
  POSTGRES_MIGRATION_FILES,
} from "../src/persistence/db.js";

// This suite guards the contract documented in coordinator/docs/schema-contract.md.
// It has two jobs:
//   1. Catch drift between the migrations directory and the hardcoded
//      SQLITE_MIGRATIONS / POSTGRES_MIGRATION_FILES registries in db.ts.
//   2. Catch drift between schema.sql (the fresh-SQLite snapshot) and the
//      table/column/index shape documented in schema-contract.md — the same
//      class of bug that previously left schema.sql missing the cursor
//      pagination indexes from 005_cursor_pagination.sql even though that
//      migration was recorded as applied.
//
// Whenever this suite needs a change, schema-contract.md needs the same change.

const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-contract-"));
  return openDatabase(`file:${dir}/test.db`);
}

describe("migration registry vs. migrations directory", () => {
  it("every .sql file on disk is registered in exactly one of SQLITE_MIGRATIONS / POSTGRES_MIGRATION_FILES", () => {
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const registered = new Set<string>([...SQLITE_MIGRATIONS, ...POSTGRES_MIGRATION_FILES]);

    for (const file of onDisk) {
      expect(registered.has(file)).toBe(true);
    }
  });

  it("every entry in SQLITE_MIGRATIONS and POSTGRES_MIGRATION_FILES exists on disk", () => {
    const onDisk = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")));

    for (const m of SQLITE_MIGRATIONS) {
      expect(onDisk.has(m)).toBe(true);
    }
    for (const m of POSTGRES_MIGRATION_FILES) {
      expect(onDisk.has(m)).toBe(true);
    }
  });

  it("the union of both registries covers the directory listing exactly (no orphan files, no phantom entries)", () => {
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const registered = [...new Set([...SQLITE_MIGRATIONS, ...POSTGRES_MIGRATION_FILES])].sort();
    expect(registered).toEqual(onDisk);
  });

  it("SQLITE_MIGRATIONS and POSTGRES_MIGRATION_FILES have the same length (one logical migration per slot)", () => {
    expect(SQLITE_MIGRATIONS.length).toBe(POSTGRES_MIGRATION_FILES.length);
  });

  it("CURRENT_SCHEMA_VERSION matches the last entry of SQLITE_MIGRATIONS", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(SQLITE_MIGRATIONS.at(-1));
  });

  it("the last entries of both registries share the same numeric prefix", () => {
    const sqliteLast = SQLITE_MIGRATIONS.at(-1)!;
    const postgresLast = POSTGRES_MIGRATION_FILES.at(-1)!;
    const prefix = (name: string) => name.split("_")[0];
    expect(prefix(sqliteLast)).toBe(prefix(postgresLast));
  });

  it("numeric prefixes are non-decreasing across both registries (no accidental reordering)", () => {
    const prefix = (name: string) => Number(name.split("_")[0]);
    for (const list of [SQLITE_MIGRATIONS, POSTGRES_MIGRATION_FILES]) {
      const prefixes = list.map(prefix);
      const sorted = [...prefixes].sort((a, b) => a - b);
      expect(prefixes).toEqual(sorted);
    }
  });
});

describe("schema.sql shape vs. schema-contract.md — orders", () => {
  it("has every documented column", async () => {
    const db = await freshDb();
    const cols = (db as any)
      .prepare("PRAGMA table_info(orders)")
      .all()
      .map((c: any) => c.name);

    const expected = [
      "id", "public_id", "direction", "status", "hashlock",
      "src_chain", "src_address", "src_asset", "src_amount", "src_safety_deposit",
      "src_order_id", "src_lock_tx", "src_lock_block", "src_timelock",
      "dst_chain", "dst_address", "dst_asset", "dst_amount",
      "dst_order_id", "dst_lock_tx", "dst_lock_block", "dst_timelock",
      "preimage", "preimage_enc_version", "secret_revealed_tx", "resolver_address",
      "created_at", "updated_at", "archived_at",
    ];
    for (const col of expected) {
      expect(cols).toContain(col);
    }
  });

  it("has every documented index, including the cursor-pagination set", async () => {
    const db = await freshDb();
    const names = (db as any)
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'")
      .all()
      .map((r: any) => r.name);

    const expected = [
      "idx_orders_hashlock",
      "idx_orders_src_address",
      "idx_orders_dst_address",
      "idx_orders_status",
      "idx_orders_src_order_id",
      "idx_orders_dst_order_id",
      "idx_orders_public_id",
      "idx_orders_created_at",
      "idx_orders_src_address_created_at",
      "idx_orders_dst_address_created_at",
      "idx_orders_cursor_pagination",
      "idx_orders_src_cursor",
      "idx_orders_dst_cursor",
    ];
    for (const idx of expected) {
      expect(names).toContain(idx);
    }
  });
});

describe("schema.sql shape vs. schema-contract.md — order_events, resolver_heartbeats, schema_migrations, audit_log", () => {
  it("order_events has the documented columns and index", async () => {
    const db = await freshDb();
    const cols = (db as any).prepare("PRAGMA table_info(order_events)").all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["id", "order_id", "event_type", "payload_json", "created_at"]));

    const indexes = (db as any)
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='order_events'")
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("idx_order_events_order");
  });

  it("resolver_heartbeats has the documented columns", async () => {
    const db = await freshDb();
    const cols = (db as any).prepare("PRAGMA table_info(resolver_heartbeats)").all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["address", "chain", "last_seen"]));
  });

  it("schema_migrations has the documented columns", async () => {
    const db = await freshDb();
    const cols = (db as any).prepare("PRAGMA table_info(schema_migrations)").all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["migration", "applied_at", "duration_ms"]));
  });

  it("audit_log has the documented columns and all four indexes", async () => {
    const db = await freshDb();
    const cols = (db as any).prepare("PRAGMA table_info(audit_log)").all().map((c: any) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id", "schema_version", "event_type", "order_id", "request_id", "payload_json", "created_at",
      ])
    );

    const indexes = (db as any)
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'")
      .all()
      .map((r: any) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_audit_log_order_id",
        "idx_audit_log_id_asc",
        "idx_audit_log_event_type",
        "idx_audit_log_created_at",
      ])
    );
  });

  it("audit_log.order_id is a plain correlation column, not a foreign key (no FK list entry)", async () => {
    const db = await freshDb();
    const fks = (db as any).prepare("PRAGMA foreign_key_list(audit_log)").all();
    expect(fks).toHaveLength(0);
  });

  it("order_events.order_id IS a foreign key to orders", async () => {
    const db = await freshDb();
    const fks = (db as any).prepare("PRAGMA foreign_key_list(order_events)").all();
    expect(fks.length).toBeGreaterThanOrEqual(1);
    expect(fks[0].table).toBe("orders");
  });
});

describe("schema.sql shape vs. schema-contract.md — soroban_checkpoints", () => {
  it("has the documented columns", async () => {
    const db = await freshDb();
    const cols = (db as any)
      .prepare("PRAGMA table_info(soroban_checkpoints)")
      .all()
      .map((c: any) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "contract_id",
        "last_safe_ledger",
        "effective_cursor",
        "recovery_marker",
        "updated_at",
      ])
    );
  });

  it("uses contract_id as the primary key", async () => {
    const db = await freshDb();
    const pk = (db as any)
      .prepare("PRAGMA table_info(soroban_checkpoints)")
      .all()
      .filter((c: any) => c.pk > 0)
      .map((c: any) => c.name);
    expect(pk).toEqual(["contract_id"]);
  });

  it("rejects a recovery_marker outside the documented CHECK set", async () => {
    const db = await freshDb();
    expect(() =>
      (db as any)
        .prepare(
          "INSERT INTO soroban_checkpoints (contract_id, last_safe_ledger, recovery_marker) VALUES ('C', 1, 'bogus')"
        )
        .run()
    ).toThrow();
  });
});
