/**
 * Test-only SQLite opener that applies the canonical schema directly.
 *
 * Avoids the production migration-registry validation, which is unrelated to
 * benchmark/recovery fixtures and must stay a deployment-level check.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import type { Database } from "../../src/persistence/db.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = resolve(
  new URL("../../src/persistence/schema.sql", import.meta.url).pathname,
);

export function openTestSqlite(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA, "utf8"));
  return db as unknown as Database;
}
