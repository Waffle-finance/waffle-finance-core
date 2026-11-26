#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  evaluateVerification,
  formatVerificationReport,
  inspectPostgresDatabase,
  inspectSqliteDatabase,
  writeBackupManifest,
} from './db-backup-verify.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

interface Args {
  databaseUrl: string;
  out?: string;
  verify: boolean;
}

function usage(): string {
  return [
    'Usage: pnpm --filter @wafflefinance/coordinator db:backup -- [--database-url <url>] [--out <path>] [--no-verify]',
    '',
    'Defaults:',
    '  --database-url uses DATABASE_URL or file:./wafflefinance.db',
    '  --out creates backups/coordinator-<backend>-<timestamp>.<db|dump>',
    '',
    'Supported backends:',
    '  SQLite: file:./wafflefinance.db or ./wafflefinance.db',
    '  Postgres: postgres://... or postgresql://... using pg_dump',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    databaseUrl: process.env.DATABASE_URL ?? 'file:./wafflefinance.db',
    verify: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--database-url') {
      args.databaseUrl = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--out') {
      args.out = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--no-verify') {
      args.verify = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

function sqlitePathFromUrl(url: string): string {
  if (url === ':memory:' || url === 'file::memory:') {
    throw new Error('Refusing to back up an in-memory SQLite database');
  }
  return resolve(url.startsWith('file:') ? url.slice('file:'.length) : url);
}

function defaultOutPath(out: string | undefined, backend: 'sqlite' | 'postgres'): string {
  const suffix = backend === 'sqlite' ? 'db' : 'dump';
  const fallback = resolve('backups', `coordinator-${backend}-${timestamp()}.${suffix}`);
  if (!out) return fallback;

  const resolved = resolve(out);
  if (extname(resolved)) return resolved;
  return resolve(resolved, `coordinator-${backend}-${timestamp()}.${suffix}`);
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function sqliteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface BackupResult {
  backupPath: string;
  manifestPath: string;
  schemaVersion: string | null;
}

export function backupSqlite(databaseUrl: string, out?: string, verify = true): BackupResult {
  const source = sqlitePathFromUrl(databaseUrl);
  if (!existsSync(source)) {
    throw new Error(`SQLite database does not exist: ${source}`);
  }

  const target = defaultOutPath(out, 'sqlite');
  if (existsSync(target)) {
    throw new Error(`Refusing to overwrite existing backup: ${target}`);
  }
  ensureParent(target);

  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqliteLiteral(target)}`);
  } finally {
    db.close();
  }

  const inspection = inspectSqliteDatabase(target);
  if (verify) {
    const report = evaluateVerification(inspection);
    console.log(formatVerificationReport(report));
    if (!report.ok) {
      throw new Error(`Backup verification failed:\n${report.mismatches.join('\n')}`);
    }
  }

  const manifestPath = writeBackupManifest(target, inspection);
  return {
    backupPath: target,
    manifestPath,
    schemaVersion: inspection.schemaVersion,
  };
}

function postgresEnvFromUrl(url: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PGHOST = parsed.hostname;
  if (parsed.port) env.PGPORT = parsed.port;
  env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  env.PGDATABASE = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

export async function backupPostgres(
  databaseUrl: string,
  out?: string,
  verify = true
): Promise<BackupResult> {
  const target = defaultOutPath(out, 'postgres');
  if (existsSync(target)) {
    throw new Error(`Refusing to overwrite existing backup: ${target}`);
  }
  ensureParent(target);

  const env = postgresEnvFromUrl(databaseUrl);
  run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', target], env);
  if (verify) run('pg_restore', ['--list', target], env);

  const inspection = await inspectPostgresDatabase(databaseUrl);
  if (verify) {
    const report = evaluateVerification(inspection);
    console.log(formatVerificationReport(report));
    if (!report.ok) {
      throw new Error(`Backup verification failed:\n${report.mismatches.join('\n')}`);
    }
  }

  const manifestPath = writeBackupManifest(target, inspection);
  return {
    backupPath: target,
    manifestPath,
    schemaVersion: inspection.schemaVersion,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = isPostgresUrl(args.databaseUrl)
    ? await backupPostgres(args.databaseUrl, args.out, args.verify)
    : backupSqlite(args.databaseUrl, args.out, args.verify);

  console.log(`Backup created: ${result.backupPath}`);
  console.log(`Manifest created: ${result.manifestPath}`);
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
