import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { CURRENT_SCHEMA_VERSION, SQLITE_MIGRATIONS } from '../src/persistence/db.js';
import { backupSqlite } from '../scripts/db-backup.js';
import { restoreSqlite } from '../scripts/db-restore.js';
import {
  REQUIRED_TABLES,
  evaluateVerification,
  formatVerificationReport,
  inspectSqliteDatabase,
  readBackupManifest,
  verifySqliteDatabase,
} from '../scripts/db-backup-verify.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

const SCHEMA_SQL_PATH = resolve(process.cwd(), 'src/persistence/schema.sql');
const SECRET_PREIMAGE = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const FAKE_ENCRYPTION_KEY = 'super-secret-encryption-key-do-not-print';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'waffle-backup-verify-'));
  tempDirs.push(dir);
  return dir;
}

function createPopulatedSqliteDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const schemaSql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
    db.exec(schemaSql);

    const now = Math.floor(Date.now() / 1000);
    const insertMigration = db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (migration, applied_at, duration_ms) VALUES (?, ?, 0)'
    );
    for (let i = 0; i < SQLITE_MIGRATIONS.length; i += 1) {
      insertMigration.run(SQLITE_MIGRATIONS[i], now + i);
    }

    db.prepare(
      `INSERT INTO orders (
        public_id, direction, status, hashlock,
        src_chain, src_address, src_asset, src_amount, src_safety_deposit,
        dst_chain, dst_address, dst_asset, dst_amount,
        preimage, preimage_enc_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'wf_0x1111111111111111111111111111111111111111111111111111111111111111',
      'eth_to_xlm',
      'secret_revealed',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
      'ethereum',
      '0xabc',
      'native',
      '1000',
      '10',
      'stellar',
      'GABC',
      'native',
      '1000',
      SECRET_PREIMAGE,
      null,
      now,
      now
    );

    db.prepare(
      `INSERT INTO order_events (order_id, event_type, payload_json, created_at)
       VALUES (1, 'secret_revealed.transitioned', '{"note":"ok"}', ?)`
    ).run(now);

    db.prepare(
      `INSERT INTO audit_log (schema_version, event_type, order_id, payload_json, created_at)
       VALUES (1, 'order.secret_revealed', 'wf_0x1111', '{"ok":true}', ?)`
    ).run(now);
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('backup and restore verification', () => {
  it('valid restore succeeds, reports schema version and row counts, and never prints secrets', () => {
    const dir = createTempDir();
    const sourceDb = join(dir, 'source.db');
    const backupFile = join(dir, 'backup.db');
    const restoredDb = join(dir, 'restored.db');

    createPopulatedSqliteDb(sourceDb);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });

    const prevKey = process.env.SECRET_STORAGE_KEY;
    process.env.SECRET_STORAGE_KEY = FAKE_ENCRYPTION_KEY;
    try {
      const backup = backupSqlite(`file:${sourceDb}`, backupFile, true);
      expect(backup.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

      const manifestRaw = readFileSync(backup.manifestPath, 'utf8');
      expect(manifestRaw).not.toContain(SECRET_PREIMAGE);
      expect(manifestRaw).not.toContain(FAKE_ENCRYPTION_KEY);

      const manifest = readBackupManifest(backup.manifestPath);
      expect(manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(manifest.tableCounts.orders).toBe(1);
      expect(manifest.tableCounts.order_events).toBe(1);
      expect(manifest.tableCounts.audit_log).toBe(1);
      expect(manifest.tableCounts.schema_migrations).toBe(SQLITE_MIGRATIONS.length);

      const result = restoreSqlite(`file:${restoredDb}`, backup.backupPath, true);
      expect(result.restored).toBe(restoredDb);
      expect(result.verification).toBeDefined();
      expect(result.verification!.ok).toBe(true);
      expect(result.verification!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.verification!.requiredTablesPresent).toBe(true);
      expect(result.verification!.manifestChecked).toBe(true);
      expect(result.verification!.manifestMatches).toBe(true);
      expect(result.verification!.tableCounts.orders).toBe(1);
      expect(result.verification!.tableCounts.order_events).toBe(1);
      expect(result.verification!.tableCounts.audit_log).toBe(1);

      const formatted = formatVerificationReport(result.verification!);
      expect(formatted).toContain(`Schema version: ${CURRENT_SCHEMA_VERSION}`);
      expect(formatted).toContain(`Required tables: ${REQUIRED_TABLES.length}/${REQUIRED_TABLES.length} present`);
      expect(formatted).toContain('Manifest comparison: matched');
      expect(formatted).not.toContain(SECRET_PREIMAGE);
      expect(formatted).not.toContain(FAKE_ENCRYPTION_KEY);

      const allOutput = logs.join('\n');
      expect(allOutput).toContain(CURRENT_SCHEMA_VERSION);
      expect(allOutput).not.toContain(SECRET_PREIMAGE);
      expect(allOutput).not.toContain(FAKE_ENCRYPTION_KEY);
    } finally {
      if (prevKey === undefined) {
        delete process.env.SECRET_STORAGE_KEY;
      } else {
        process.env.SECRET_STORAGE_KEY = prevKey;
      }
    }
  });

  it('rejects a corrupt backup archive', () => {
    const dir = createTempDir();
    const sourceDb = join(dir, 'source.db');
    const backupFile = join(dir, 'backup.db');
    const restoredDb = join(dir, 'restored.db');

    createPopulatedSqliteDb(sourceDb);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const backup = backupSqlite(`file:${sourceDb}`, backupFile, true);

    // Corrupt the backup file after manifest creation -> checksum mismatch
    writeFileSync(backup.backupPath, Buffer.from('not-a-valid-sqlite-database-archive'));
    expect(() => restoreSqlite(`file:${restoredDb}`, backup.backupPath, true)).toThrow(
      /checksum mismatch/i
    );

    // Also verify corrupt archive without a manifest fails SQLite verification
    const corruptNoManifest = join(dir, 'corrupt-no-manifest.db');
    writeFileSync(corruptNoManifest, Buffer.from('corrupt-bytes-without-manifest'));
    expect(() => restoreSqlite(`file:${restoredDb}`, corruptNoManifest, true)).toThrow(
      /SQLite verification failed|Failed to open SQLite database/i
    );
  });

  it('rejects a backup with a missing required table', () => {
    const dir = createTempDir();
    const brokenDb = join(dir, 'missing-table.db');
    const restoredDb = join(dir, 'restored.db');

    createPopulatedSqliteDb(brokenDb);
    const db = new DatabaseSync(brokenDb);
    try {
      db.exec('DROP TABLE audit_log;');
    } finally {
      db.close();
    }

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = verifySqliteDatabase(brokenDb);
    expect(report.ok).toBe(false);
    expect(report.requiredTablesPresent).toBe(false);
    expect(report.missingTables).toContain('audit_log');

    expect(() => restoreSqlite(`file:${restoredDb}`, brokenDb, true)).toThrow(
      /Missing required tables: audit_log/
    );
  });

  it('detects row count and schema version mismatches against the sanitized manifest', () => {
    const dir = createTempDir();
    const sourceDb = join(dir, 'source.db');
    const backupFile = join(dir, 'backup.db');

    createPopulatedSqliteDb(sourceDb);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const backup = backupSqlite(`file:${sourceDb}`, backupFile, true);
    const manifest = readBackupManifest(backup.manifestPath);
    const inspection = inspectSqliteDatabase(backup.backupPath);

    const tamperedManifest = {
      ...manifest,
      schemaVersion: '001_initial.sql',
      tableCounts: {
        ...manifest.tableCounts,
        orders: 99,
      },
    };

    const report = evaluateVerification(inspection, tamperedManifest, backup.manifestPath);
    expect(report.ok).toBe(false);
    expect(report.manifestChecked).toBe(true);
    expect(report.manifestMatches).toBe(false);
    expect(report.mismatches.some(m => m.includes('Schema version mismatch'))).toBe(true);
    expect(report.mismatches.some(m => m.includes('Row count mismatch for orders'))).toBe(true);
  });
});
