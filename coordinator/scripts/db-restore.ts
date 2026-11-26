#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatVerificationReport,
  resolveManifestForBackup,
  verifyBackupArchiveChecksum,
  verifyPostgresDatabase,
  verifySqliteDatabase,
  type VerificationReport,
} from './db-backup-verify.js';

interface Args {
  databaseUrl: string;
  from?: string;
  manifest?: string;
  force: boolean;
  verify: boolean;
}

function usage(): string {
  return [
    'Usage: pnpm --filter @wafflefinance/coordinator db:restore -- --from <backup> [--manifest <path>] [--database-url <url>] --force [--no-verify]',
    '',
    'Safety:',
    '  --force is required because restore can replace or clean database state.',
    '  SQLite restores move the existing DB aside before copying the backup.',
    '  Postgres restores use pg_restore --clean --if-exists.',
    '  Post-restore verification checks integrity, required tables, schema version, and row counts.',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    databaseUrl: process.env.DATABASE_URL ?? 'file:./wafflefinance.db',
    force: false,
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
    if (arg === '--from') {
      args.from = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--manifest') {
      args.manifest = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--force') {
      args.force = true;
      continue;
    }
    if (arg === '--no-verify') {
      args.verify = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (!args.from) throw new Error(`--from is required\n\n${usage()}`);
  if (!args.force) throw new Error(`--force is required for restore\n\n${usage()}`);
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
    throw new Error('Refusing to restore into an in-memory SQLite database');
  }
  return resolve(url.startsWith('file:') ? url.slice('file:'.length) : url);
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export interface RestoreResult {
  restored: string;
  verification?: VerificationReport;
}

export function restoreSqlite(
  databaseUrl: string,
  backupPath: string,
  verify = true,
  explicitManifestPath?: string
): RestoreResult {
  const source = resolve(backupPath);
  if (!existsSync(source)) throw new Error(`Backup does not exist: ${source}`);

  const resolvedManifest = resolveManifestForBackup(
    source,
    explicitManifestPath ? resolve(explicitManifestPath) : undefined
  );

  if (verify) {
    if (resolvedManifest) {
      verifyBackupArchiveChecksum(source, resolvedManifest.manifest);
    }
    const preReport = verifySqliteDatabase(
      source,
      resolvedManifest?.manifest,
      resolvedManifest?.manifestPath
    );
    if (!preReport.ok) {
      console.error(formatVerificationReport(preReport));
      throw new Error(`Pre-restore verification failed:\n${preReport.mismatches.join('\n')}`);
    }
  }

  const target = sqlitePathFromUrl(databaseUrl);
  ensureParent(target);

  if (existsSync(target)) {
    const safetyCopy = `${target}.pre-restore-${timestamp()}.bak`;
    renameSync(target, safetyCopy);
    console.log(`Existing database moved to: ${safetyCopy}`);
  }

  copyFileSync(source, target);

  let verification: VerificationReport | undefined;
  if (verify) {
    verification = verifySqliteDatabase(
      target,
      resolvedManifest?.manifest,
      resolvedManifest?.manifestPath
    );
    console.log(formatVerificationReport(verification));
    if (!verification.ok) {
      throw new Error(`Post-restore verification failed:\n${verification.mismatches.join('\n')}`);
    }
  }

  return { restored: target, verification };
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

export async function restorePostgres(
  databaseUrl: string,
  backupPath: string,
  verify = true,
  explicitManifestPath?: string
): Promise<RestoreResult> {
  const source = resolve(backupPath);
  if (!existsSync(source)) throw new Error(`Backup does not exist: ${source}`);

  const resolvedManifest = resolveManifestForBackup(
    source,
    explicitManifestPath ? resolve(explicitManifestPath) : undefined
  );

  const env = postgresEnvFromUrl(databaseUrl);
  if (verify) {
    if (resolvedManifest) {
      verifyBackupArchiveChecksum(source, resolvedManifest.manifest);
    }
    run('pg_restore', ['--list', source], env);
  }
  run(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      env.PGDATABASE ?? '',
      source,
    ],
    env
  );

  let verification: VerificationReport | undefined;
  if (verify) {
    verification = await verifyPostgresDatabase(
      databaseUrl,
      resolvedManifest?.manifest,
      resolvedManifest?.manifestPath
    );
    console.log(formatVerificationReport(verification));
    if (!verification.ok) {
      throw new Error(`Post-restore verification failed:\n${verification.mismatches.join('\n')}`);
    }
  }

  return {
    restored: env.PGDATABASE ?? '(unknown database)',
    verification,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = isPostgresUrl(args.databaseUrl)
    ? await restorePostgres(args.databaseUrl, args.from!, args.verify, args.manifest)
    : restoreSqlite(args.databaseUrl, args.from!, args.verify, args.manifest);

  console.log(`Restore completed: ${result.restored}`);
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
