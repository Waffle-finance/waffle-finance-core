import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Pool, PoolClient } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load `node:sqlite` via createRequire so Vite/Vitest do not try to
// transform the import. This module is built into Node 22.5+/24.x and
// is the recommended zero-install SQLite driver.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export type Database = InstanceType<typeof DatabaseSync> | PostgresDatabase;

export function isPostgresDatabase(db: Database): db is PostgresDatabase {
  return (db as any).getPool !== undefined;
}

/**
 * PostgreSQL wrapper to provide a SQLite-like interface.
 */
export class PostgresDatabase {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  prepare(sql: string): PostgresStatement {
    return new PostgresStatement(this.pool, sql);
  }

  async exec(sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  getPool(): Pool {
    return this.pool;
  }
}

/**
 * PostgreSQL statement wrapper to provide a SQLite-like interface.
 */
export class PostgresStatement {
  constructor(private pool: Pool, private sql: string) {}

  private convertSqliteToPostgres(sql: string, params: any[]): { sql: string; params: any[] } {
    // Convert strftime expressions first
    let converted = sql.replace(
      /CAST\(strftime\('%s','now'\) AS INTEGER\)/g,
      "CAST(EXTRACT(EPOCH FROM NOW()) AS INTEGER)"
    );

    // Handle named parameters
    const namedParams = Array.from(converted.matchAll(/:(\w+)/g));
    
    if (namedParams.length > 0) {
      // Build parameter map from first parameter object
      const paramMap: { [key: string]: any } = {};
      if (params.length > 0 && typeof params[0] === 'object' && params[0] !== null && !(params[0] instanceof Array)) {
        Object.assign(paramMap, params[0]);
      }

      // Track parameter order and build positional array
      const positionalParams: any[] = [];
      const paramIndexMap: { [key: string]: number } = {};
      
      // Replace named parameters in order of appearance
      converted = converted.replace(/:(\w+)/g, (match, paramName) => {
        // If we've seen this parameter before, reuse its index
        if (paramIndexMap.hasOwnProperty(paramName)) {
          return `$${paramIndexMap[paramName]}`;
        }
        
        // New parameter - add to positional array
        const index = positionalParams.length + 1;
        paramIndexMap[paramName] = index;
        positionalParams.push(paramMap[paramName]);
        return `$${index}`;
      });

      return { sql: converted, params: positionalParams };
    }

    // Handle positional ? parameters
    const questionMarks = Array.from(converted.matchAll(/\?/g));
    if (questionMarks.length > 0) {
      let index = 1;
      converted = converted.replace(/\?/g, () => `$${index++}`);
      return { sql: converted, params };
    }

    return { sql: converted, params };
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number } {
    throw new Error(
      "PostgresStatement.run() should not be called synchronously. Use runAsync() instead."
    );
  }

  get(...params: any[]): any {
    throw new Error(
      "PostgresStatement.get() should not be called synchronously. Use getAsync() instead."
    );
  }

  all(...params: any[]): any[] {
    throw new Error(
      "PostgresStatement.all() should not be called synchronously. Use allAsync() instead."
    );
  }

  /**
   * Async versions for Postgres.
   */
  async runAsync(...params: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return { changes: result.rowCount || 0, lastInsertRowid: 0 };
  }

  async getAsync(...params: any[]): Promise<any> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return result.rows[0] || null;
  }

  async allAsync(...params: any[]): Promise<any[]> {
    const { sql, params: convertedParams } = this.convertSqliteToPostgres(this.sql, params);
    const result = await this.pool.query(sql, convertedParams);
    return result.rows;
  }
}

/**
 * Open (or create) the coordinator's database and apply the
 * schema. The schema is idempotent so calling this on an existing DB
 * is safe.
 *
 * Supports both SQLite (file: URLs) and Postgres (postgres:// URLs).
 *
 * The DB is treated as a CACHE of on-chain state. If it is lost or
 * corrupted, the coordinator can rebuild it by re-reading events from
 * both chains.
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return openPostgresDatabase(url);
  } else {
    return openSqliteDatabase(url);
  }
}

function openSqliteDatabase(url: string): Database {
  const filename = url.startsWith("file:") ? url.slice("file:".length) : url;
  const db = new DatabaseSync(filename);
  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}

async function openPostgresDatabase(url: string): Promise<PostgresDatabase> {
  const { Pool } = (await import("pg")) as typeof import("pg");
  const pool = new Pool({ connectionString: url });

  // Apply migrations
  const migrationsDir = resolve(__dirname, "..", "..", "migrations");
  const migrationFiles = [
    // Add migrations in order.
    "001_initial.sql",
    // Use PostgreSQL-specific Solana migration if available, otherwise fallback
    "002_solana_support_postgres.sql",
    // Adds preimage_enc_version column for AES-256-GCM encryption at rest.
    "003_secret_encryption.sql",
    // Adds optimized indexes for history lookups.
    "004_query_optimizations.sql"
  ];

  for (const file of migrationFiles) {
    const migrationPath = resolve(migrationsDir, file);
    let migration: string;
    
    try {
      migration = readFileSync(migrationPath, "utf8");
    } catch (error) {
      // Fallback to SQLite version if PostgreSQL-specific version doesn't exist
      if (file === "002_solana_support_postgres.sql") {
        const fallbackPath = resolve(migrationsDir, "002_solana_support.sql");
        migration = readFileSync(fallbackPath, "utf8");
      } else {
        throw error;
      }
    }
    
    const client = await pool.connect();
    try {
      await client.query(migration);
    } catch (error: any) {
      // Ignore "already exists" errors from CREATE TABLE IF NOT EXISTS
      if (!error.message?.includes("already exists")) {
        throw error;
      }
    } finally {
      client.release();
    }
  }

  return new PostgresDatabase(pool);
}

