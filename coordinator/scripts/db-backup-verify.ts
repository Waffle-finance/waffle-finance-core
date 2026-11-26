import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export const REQUIRED_TABLES = [
  'orders',
  'order_events',
  'processed_events',
  'resolver_heartbeats',
  'schema_migrations',
  'audit_log',
  'chain_cursors',
  'soroban_checkpoints',
] as const;

export type RequiredTable = (typeof REQUIRED_TABLES)[number];
export type DatabaseBackend = 'sqlite' | 'postgres';

export interface BackupManifest {
  formatVersion: 1;
  backend: DatabaseBackend;
  createdAt: string;
  backupFile: string;
  backupSha256: string;
  schemaVersion: string | null;
  migrations: string[];
  tableCounts: Record<RequiredTable, number>;
}

export interface DatabaseInspection {
  backend: DatabaseBackend;
  integrityCheck: string;
  foreignKeyCheck: string;
  presentTables: string[];
  missingTables: string[];
  schemaVersion: string | null;
  migrations: string[];
  tableCounts: Record<string, number>;
}

export interface VerificationReport {
  backend: DatabaseBackend;
  schemaVersion: string | null;
  migrationsCount: number;
  integrityCheck: string;
  foreignKeyCheck: string;
  requiredTablesPresent: boolean;
  missingTables: string[];
  tableCounts: Record<string, number>;
  manifestChecked: boolean;
  manifestPath?: string;
  manifestMatches?: boolean;
  mismatches: string[];
  ok: boolean;
}

export function manifestPathForBackup(backupPath: string): string {
  return `${backupPath}.manifest.json`;
}

export function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

export function writeBackupManifest(
  backupPath: string,
  inspection: DatabaseInspection
): string {
  const manifestPath = manifestPathForBackup(backupPath);
  const tableCounts = {} as Record<RequiredTable, number>;
  for (const table of REQUIRED_TABLES) {
    tableCounts[table] = inspection.tableCounts[table] ?? 0;
  }

  const manifest: BackupManifest = {
    formatVersion: 1,
    backend: inspection.backend,
    createdAt: new Date().toISOString(),
    backupFile: basename(backupPath),
    backupSha256: sha256File(backupPath),
    schemaVersion: inspection.schemaVersion,
    migrations: [...inspection.migrations],
    tableCounts,
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

export function readBackupManifest(manifestPath: string): BackupManifest {
  const raw = readFileSync(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid backup manifest JSON at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid backup manifest at ${manifestPath}: expected JSON object`);
  }

  const obj = parsed as Partial<BackupManifest>;
  if (
    obj.formatVersion !== 1 ||
    (obj.backend !== 'sqlite' && obj.backend !== 'postgres') ||
    typeof obj.backupSha256 !== 'string' ||
    !Array.isArray(obj.migrations) ||
    !obj.tableCounts ||
    typeof obj.tableCounts !== 'object'
  ) {
    throw new Error(`Invalid backup manifest structure at ${manifestPath}`);
  }

  return obj as BackupManifest;
}

export function verifyBackupArchiveChecksum(
  backupPath: string,
  manifest: BackupManifest
): void {
  const actual = sha256File(backupPath);
  if (actual !== manifest.backupSha256) {
    throw new Error(
      `Backup archive checksum mismatch: expected ${manifest.backupSha256}, got ${actual}`
    );
  }
}

export function inspectSqliteDatabase(dbPath: string): DatabaseInspection {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(
      `Failed to open SQLite database (${basename(dbPath)}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, string>>;
    const integrityMessages = integrityRows
      .map(row => Object.values(row)[0])
      .filter((val): val is string => typeof val === 'string');
    const integrityCheck =
      integrityMessages.length === 1 && integrityMessages[0] === 'ok'
        ? 'ok'
        : integrityMessages.join('; ') || 'failed';

    let foreignKeyCheck = 'ok';
    try {
      const fkRows = db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
      if (fkRows.length > 0) {
        foreignKeyCheck = `failed (${fkRows.length} violation(s))`;
      }
    } catch (err) {
      foreignKeyCheck = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const presentSet = new Set(tableRows.map(r => r.name));
    const presentTables = REQUIRED_TABLES.filter(t => presentSet.has(t));
    const missingTables = REQUIRED_TABLES.filter(t => !presentSet.has(t));

    let migrations: string[] = [];
    let schemaVersion: string | null = null;
    if (presentSet.has('schema_migrations')) {
      const migRows = db
        .prepare('SELECT migration FROM schema_migrations ORDER BY applied_at ASC, migration ASC')
        .all() as Array<{ migration: string }>;
      migrations = migRows.map(r => r.migration);
      schemaVersion = migrations.length > 0 ? migrations[migrations.length - 1]! : null;
    }

    const tableCounts: Record<string, number> = {};
    for (const table of presentTables) {
      const countRow = db
        .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
        .get() as { count: number } | undefined;
      tableCounts[table] = Number(countRow?.count ?? 0);
    }

    return {
      backend: 'sqlite',
      integrityCheck,
      foreignKeyCheck,
      presentTables,
      missingTables,
      schemaVersion,
      migrations,
      tableCounts,
    };
  } catch (err) {
    throw new Error(
      `SQLite verification failed (${basename(dbPath)}): ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    db.close();
  }
}

export async function inspectPostgresDatabase(databaseUrl: string): Promise<DatabaseInspection> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const invalidIndexRes = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM pg_index WHERE NOT indisvalid'
    );
    const invalidIndexes = Number(invalidIndexRes.rows[0]?.count ?? 0);
    const integrityCheck =
      invalidIndexes === 0 ? 'ok' : `failed (${invalidIndexes} invalid index(es))`;

    const tableRes = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const presentSet = new Set(tableRes.rows.map(r => r.tablename));
    const presentTables = REQUIRED_TABLES.filter(t => presentSet.has(t));
    const missingTables = REQUIRED_TABLES.filter(t => !presentSet.has(t));

    let migrations: string[] = [];
    let schemaVersion: string | null = null;
    if (presentSet.has('schema_migrations')) {
      const migRes = await client.query<{ migration: string }>(
        'SELECT migration FROM schema_migrations ORDER BY applied_at ASC, migration ASC'
      );
      migrations = migRes.rows.map(r => r.migration);
      schemaVersion = migrations.length > 0 ? migrations[migrations.length - 1]! : null;
    }

    const tableCounts: Record<string, number> = {};
    for (const table of presentTables) {
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${table}"`
      );
      tableCounts[table] = Number(countRes.rows[0]?.count ?? 0);
    }

    return {
      backend: 'postgres',
      integrityCheck,
      foreignKeyCheck: 'enforced',
      presentTables,
      missingTables,
      schemaVersion,
      migrations,
      tableCounts,
    };
  } finally {
    await client.end();
  }
}

export function evaluateVerification(
  inspection: DatabaseInspection,
  manifest?: BackupManifest,
  manifestPath?: string
): VerificationReport {
  const mismatches: string[] = [];

  if (inspection.integrityCheck !== 'ok') {
    mismatches.push(`Integrity check failed: ${inspection.integrityCheck}`);
  }

  if (inspection.foreignKeyCheck !== 'ok' && inspection.foreignKeyCheck !== 'enforced') {
    mismatches.push(`Foreign key check failed: ${inspection.foreignKeyCheck}`);
  }

  if (inspection.missingTables.length > 0) {
    mismatches.push(`Missing required tables: ${inspection.missingTables.join(', ')}`);
  }

  if (!inspection.schemaVersion) {
    mismatches.push('Schema version could not be determined (schema_migrations is empty or missing)');
  }

  let manifestChecked = false;
  let manifestMatches: boolean | undefined;

  if (manifest) {
    manifestChecked = true;
    const manifestMismatches: string[] = [];

    if (manifest.backend !== inspection.backend) {
      manifestMismatches.push(
        `Backend mismatch: manifest=${manifest.backend}, restored=${inspection.backend}`
      );
    }

    if (manifest.schemaVersion !== inspection.schemaVersion) {
      manifestMismatches.push(
        `Schema version mismatch: manifest=${manifest.schemaVersion ?? 'none'}, restored=${inspection.schemaVersion ?? 'none'}`
      );
    }

    if (
      manifest.migrations.length !== inspection.migrations.length ||
      manifest.migrations.some((m, idx) => m !== inspection.migrations[idx])
    ) {
      manifestMismatches.push(
        `Migration history mismatch: manifest has ${manifest.migrations.length} migration(s), restored has ${inspection.migrations.length}`
      );
    }

    for (const table of REQUIRED_TABLES) {
      const expectedCount = manifest.tableCounts[table];
      const actualCount = inspection.tableCounts[table];
      if (typeof expectedCount === 'number' && actualCount !== expectedCount) {
        manifestMismatches.push(
          `Row count mismatch for ${table}: manifest=${expectedCount}, restored=${actualCount ?? 'missing'}`
        );
      }
    }

    manifestMatches = manifestMismatches.length === 0;
    mismatches.push(...manifestMismatches);
  }

  return {
    backend: inspection.backend,
    schemaVersion: inspection.schemaVersion,
    migrationsCount: inspection.migrations.length,
    integrityCheck: inspection.integrityCheck,
    foreignKeyCheck: inspection.foreignKeyCheck,
    requiredTablesPresent: inspection.missingTables.length === 0,
    missingTables: inspection.missingTables,
    tableCounts: inspection.tableCounts,
    manifestChecked,
    manifestPath,
    manifestMatches,
    mismatches,
    ok: mismatches.length === 0,
  };
}

export function verifySqliteDatabase(
  dbPath: string,
  manifest?: BackupManifest,
  manifestPath?: string
): VerificationReport {
  const inspection = inspectSqliteDatabase(dbPath);
  return evaluateVerification(inspection, manifest, manifestPath);
}

export async function verifyPostgresDatabase(
  databaseUrl: string,
  manifest?: BackupManifest,
  manifestPath?: string
): Promise<VerificationReport> {
  const inspection = await inspectPostgresDatabase(databaseUrl);
  return evaluateVerification(inspection, manifest, manifestPath);
}

export function resolveManifestForBackup(
  backupPath: string,
  explicitManifestPath?: string
): { manifest: BackupManifest; manifestPath: string } | undefined {
  if (explicitManifestPath) {
    if (!existsSync(explicitManifestPath)) {
      throw new Error(`Backup manifest does not exist: ${explicitManifestPath}`);
    }
    return {
      manifest: readBackupManifest(explicitManifestPath),
      manifestPath: explicitManifestPath,
    };
  }

  const defaultPath = manifestPathForBackup(backupPath);
  if (!existsSync(defaultPath)) {
    return undefined;
  }

  return {
    manifest: readBackupManifest(defaultPath),
    manifestPath: defaultPath,
  };
}

export function formatVerificationReport(report: VerificationReport): string {
  const lines: string[] = [
    `Verification results (${report.backend}):`,
    `  Schema version: ${report.schemaVersion ?? 'unknown'} (${report.migrationsCount} migrations)`,
    `  Integrity check: ${report.integrityCheck}`,
    `  Foreign key check: ${report.foreignKeyCheck}`,
    `  Required tables: ${REQUIRED_TABLES.length - report.missingTables.length}/${REQUIRED_TABLES.length} present`,
  ];

  if (report.missingTables.length > 0) {
    lines.push(`  Missing tables: ${report.missingTables.join(', ')}`);
  }

  lines.push('  Row counts:');
  for (const table of REQUIRED_TABLES) {
    const count = report.tableCounts[table];
    lines.push(`    ${table}: ${count === undefined ? 'missing' : count}`);
  }

  if (report.manifestChecked) {
    const label = report.manifestPath ? basename(report.manifestPath) : 'manifest';
    lines.push(
      `  Manifest comparison: ${report.manifestMatches ? 'matched' : 'FAILED'} (${label})`
    );
  } else {
    lines.push('  Manifest comparison: skipped (no manifest found)');
  }

  if (report.mismatches.length > 0) {
    lines.push('  Failures:');
    for (const mismatch of report.mismatches) {
      lines.push(`    - ${mismatch}`);
    }
  }

  return lines.join('\n');
}
