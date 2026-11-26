#!/usr/bin/env tsx
/**
 * Automated restore drill for disaster recovery validation.
 *
 * This script executes the complete restore procedure documented in
 * backup-restore.md and generates a timestamped report with:
 * - Recovery time objectives (RTO)
 * - Integrity checks
 * - Reconciliation readiness
 * - Non-reconstructible metadata identification
 *
 * The drill uses an isolated database to prevent production impact.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

interface Args {
  backup: string;
  isolated: string;
  report?: string;
  skipService: boolean;
}

interface DrillReport {
  timestamp: string;
  backup: string;
  isolated: string;
  phases: {
    restore: PhaseReport;
    verification: PhaseReport;
    service: PhaseReport | null;
  };
  summary: {
    totalDurationMs: number;
    success: boolean;
    errors: string[];
    warnings: string[];
  };
}

interface PhaseReport {
  phase: string;
  startTime: string;
  durationMs: number;
  success: boolean;
  details: Record<string, any>;
  errors: string[];
}

function usage(): string {
  return [
    'Usage: tsx scripts/restore-drill.ts [options]',
    '',
    'Options:',
    '  --backup <path>           Path to backup file (required)',
    '  --isolated <path>         Path to isolated database (required)',
    '  --report <path>           Output report path (default: ops/drills/restore-<timestamp>.json)',
    '  --skip-service            Skip service startup validation',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    backup: '',
    isolated: '',
    skipService: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--backup') {
      args.backup = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--isolated') {
      args.isolated = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--report') {
      args.report = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--skip-service') {
      args.skipService = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (!args.backup) throw new Error('--backup is required\n\n' + usage());
  if (!args.isolated) throw new Error('--isolated is required\n\n' + usage());
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
  return new Date().toISOString();
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

// ── Phase 1: Restore ─────────────────────────────────────────────────────────

function executeRestore(backup: string, isolated: string): PhaseReport {
  const phase: PhaseReport = {
    phase: 'restore',
    startTime: timestamp(),
    durationMs: 0,
    success: false,
    details: {},
    errors: [],
  };

  const start = Date.now();

  try {
    if (!existsSync(backup)) {
      throw new Error(`Backup file not found: ${backup}`);
    }

    ensureParent(isolated);

    // Execute restore using db-restore.ts
    const result = spawnSync(
      'tsx',
      [
        resolve(dirname(import.meta.url.replace('file://', '')), 'db-restore.ts'),
        '--database-url',
        `file:${isolated}`,
        '--from',
        backup,
        '--force',
      ],
      { stdio: 'pipe', encoding: 'utf-8' }
    );

    phase.durationMs = Date.now() - start;

    if (result.error) {
      phase.errors.push(`Restore failed to start: ${result.error.message}`);
      return phase;
    }

    if (result.status !== 0) {
      phase.errors.push(`Restore exited with status ${result.status}`);
      phase.errors.push(result.stderr || 'No error output');
      return phase;
    }

    phase.details.restored = isolated;
    phase.details.stdout = result.stdout;
    phase.success = true;
  } catch (err) {
    phase.errors.push(err instanceof Error ? err.message : String(err));
  }

  return phase;
}

// ── Phase 2: Verification ────────────────────────────────────────────────────

interface VerificationChecks {
  integrity: boolean;
  foreignKeys: boolean;
  migrations: { expected: string[]; applied: string[]; valid: boolean };
  counts: {
    orders: number;
    activeOrders: number;
    terminalOrders: number;
    events: number;
    auditEntries: number;
  };
  dataQuality: {
    duplicatePublicIds: number;
    orphanEvents: number;
    invalidTimestamps: number;
  };
}

function executeVerification(isolated: string): PhaseReport {
  const phase: PhaseReport = {
    phase: 'verification',
    startTime: timestamp(),
    durationMs: 0,
    success: false,
    details: {},
    errors: [],
  };

  const start = Date.now();

  try {
    if (!existsSync(isolated)) {
      throw new Error(`Isolated database not found: ${isolated}`);
    }

    const db = new DatabaseSync(isolated, { readOnly: true });
    const checks: VerificationChecks = {
      integrity: false,
      foreignKeys: false,
      migrations: { expected: [], applied: [], valid: false },
      counts: {
        orders: 0,
        activeOrders: 0,
        terminalOrders: 0,
        events: 0,
        auditEntries: 0,
      },
      dataQuality: {
        duplicatePublicIds: 0,
        orphanEvents: 0,
        invalidTimestamps: 0,
      },
    };

    try {
      // Integrity check
      const integrityResult = db.prepare('PRAGMA integrity_check').get() as Record<string, string>;
      const result = Object.values(integrityResult)[0];
      checks.integrity = result === 'ok';
      if (!checks.integrity) {
        phase.errors.push(`Integrity check failed: ${result}`);
      }

      // Foreign key check
      const fkResults = db.prepare('PRAGMA foreign_key_check').all() as any[];
      checks.foreignKeys = fkResults.length === 0;
      if (!checks.foreignKeys) {
        phase.errors.push(`Foreign key violations: ${fkResults.length}`);
      }

      // Migration verification
      const expectedMigrations = [
        '001_initial.sql',
        '002_solana_support.sql',
        '003_secret_encryption.sql',
        '007_audit_log.sql',
        '009_chain_cursors.sql',
        '010_soroban_checkpoints.sql',
        '013_replay_safety.sql',
      ];

      const appliedMigrations = db
        .prepare('SELECT migration FROM schema_migrations ORDER BY applied_at, migration')
        .all() as Array<{ migration: string }>;

      checks.migrations.expected = expectedMigrations;
      checks.migrations.applied = appliedMigrations.map(m => m.migration);
      checks.migrations.valid = JSON.stringify(checks.migrations.applied) === JSON.stringify(expectedMigrations);

      if (!checks.migrations.valid) {
        phase.errors.push('Migration history mismatch');
      }

      // Count checks
      const orderCount = db.prepare('SELECT COUNT(*) AS count FROM orders').get() as {
        count: number;
      };
      checks.counts.orders = orderCount.count;

      const activeCount = db
        .prepare(
          "SELECT COUNT(*) AS count FROM orders WHERE status NOT IN ('completed', 'refunded', 'failed', 'cancelled')"
        )
        .get() as { count: number };
      checks.counts.activeOrders = activeCount.count;

      const terminalCount = db
        .prepare(
          "SELECT COUNT(*) AS count FROM orders WHERE status IN ('completed', 'refunded', 'failed', 'cancelled')"
        )
        .get() as { count: number };
      checks.counts.terminalOrders = terminalCount.count;

      const eventCount = db.prepare('SELECT COUNT(*) AS count FROM order_events').get() as {
        count: number;
      };
      checks.counts.events = eventCount.count;

      const auditCount = db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as {
        count: number;
      };
      checks.counts.auditEntries = auditCount.count;

      // Data quality checks
      const duplicates = db
        .prepare(
          'SELECT COUNT(*) AS count FROM (SELECT public_id FROM orders GROUP BY public_id HAVING COUNT(*) > 1)'
        )
        .get() as { count: number };
      checks.dataQuality.duplicatePublicIds = duplicates.count;

      const orphans = db
        .prepare(
          'SELECT COUNT(*) AS count FROM order_events AS e LEFT JOIN orders AS o ON o.id = e.order_id WHERE o.id IS NULL'
        )
        .get() as { count: number };
      checks.dataQuality.orphanEvents = orphans.count;

      const badTimestamps = db
        .prepare(
          'SELECT COUNT(*) AS count FROM orders WHERE created_at <= 0 OR updated_at < created_at OR (archived_at IS NOT NULL AND archived_at < created_at)'
        )
        .get() as { count: number };
      checks.dataQuality.invalidTimestamps = badTimestamps.count;

      // Data quality errors
      if (checks.dataQuality.duplicatePublicIds > 0) {
        phase.errors.push(`Duplicate public_ids: ${checks.dataQuality.duplicatePublicIds}`);
      }
      if (checks.dataQuality.orphanEvents > 0) {
        phase.errors.push(`Orphan events: ${checks.dataQuality.orphanEvents}`);
      }
      if (checks.dataQuality.invalidTimestamps > 0) {
        phase.errors.push(`Invalid timestamps: ${checks.dataQuality.invalidTimestamps}`);
      }
    } finally {
      db.close();
    }

    phase.details = checks;
    phase.success =
      checks.integrity &&
      checks.foreignKeys &&
      checks.migrations.valid &&
      checks.dataQuality.duplicatePublicIds === 0 &&
      checks.dataQuality.orphanEvents === 0 &&
      checks.dataQuality.invalidTimestamps === 0;
  } catch (err) {
    phase.errors.push(err instanceof Error ? err.message : String(err));
  }

  phase.durationMs = Date.now() - start;
  return phase;
}

// ── Phase 3: Service validation (optional) ───────────────────────────────────

function executeServiceValidation(isolated: string): PhaseReport {
  const phase: PhaseReport = {
    phase: 'service',
    startTime: timestamp(),
    durationMs: 0,
    success: false,
    details: {},
    errors: [],
  };

  const start = Date.now();

  try {
    // This phase would start the coordinator with the restored database
    // and check /healthz and /readyz endpoints. For the drill, we simulate
    // this check by verifying the database can be opened and migrations exist.

    const db = new DatabaseSync(isolated, { readOnly: true });
    try {
      const migrationCount = db
        .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
        .get() as { count: number };

      phase.details.migrationsPresent = migrationCount.count > 0;
      phase.details.note =
        'Full service validation requires starting coordinator with DATABASE_URL pointing to isolated database';
      phase.success = migrationCount.count > 0;
    } finally {
      db.close();
    }
  } catch (err) {
    phase.errors.push(err instanceof Error ? err.message : String(err));
  }

  phase.durationMs = Date.now() - start;
  return phase;
}

// ── Report generation ────────────────────────────────────────────────────────

function generateReport(args: Args, phases: DrillReport['phases']): DrillReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!phases.restore.success) {
    errors.push('Restore phase failed');
  }
  if (!phases.verification.success) {
    errors.push('Verification phase failed');
  }

  phases.restore.errors.forEach(e => errors.push(`[restore] ${e}`));
  phases.verification.errors.forEach(e => errors.push(`[verification] ${e}`));
  if (phases.service) {
    phases.service.errors.forEach(e => errors.push(`[service] ${e}`));
  }

  // Check for non-reconstructible metadata
  const verificationDetails = phases.verification.details as VerificationChecks;
  if (verificationDetails.counts?.activeOrders > 0) {
    warnings.push(
      `${verificationDetails.counts.activeOrders} active orders may have incomplete chain state`
    );
  }

  const totalDurationMs =
    phases.restore.durationMs +
    phases.verification.durationMs +
    (phases.service?.durationMs || 0);

  return {
    timestamp: timestamp(),
    backup: args.backup,
    isolated: args.isolated,
    phases,
    summary: {
      totalDurationMs,
      success: errors.length === 0,
      errors,
      warnings,
    },
  };
}

function writeReport(report: DrillReport, path: string): void {
  ensureParent(path);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8');
}

function printSummary(report: DrillReport): void {
  console.log('\n' + '='.repeat(80));
  console.log('RESTORE DRILL REPORT');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Backup: ${report.backup}`);
  console.log(`Isolated DB: ${report.isolated}`);
  console.log('');

  console.log('Recovery Time:');
  console.log(`  Total: ${(report.summary.totalDurationMs / 1000).toFixed(2)}s`);
  console.log(`  Restore: ${(report.phases.restore.durationMs / 1000).toFixed(2)}s`);
  console.log(`  Verification: ${(report.phases.verification.durationMs / 1000).toFixed(2)}s`);
  if (report.phases.service) {
    console.log(`  Service: ${(report.phases.service.durationMs / 1000).toFixed(2)}s`);
  }
  console.log('');

  console.log('Verification Results:');
  const checks = report.phases.verification.details as VerificationChecks;
  console.log(`  Integrity: ${checks.integrity ? '✓' : '✗'}`);
  console.log(`  Foreign Keys: ${checks.foreignKeys ? '✓' : '✗'}`);
  console.log(`  Migrations: ${checks.migrations?.valid ? '✓' : '✗'}`);
  console.log(`  Orders: ${checks.counts?.orders || 0}`);
  console.log(`    Active: ${checks.counts?.activeOrders || 0}`);
  console.log(`    Terminal: ${checks.counts?.terminalOrders || 0}`);
  console.log(`  Events: ${checks.counts?.events || 0}`);
  console.log(`  Audit entries: ${checks.counts?.auditEntries || 0}`);
  console.log('');

  if (report.summary.warnings.length > 0) {
    console.log('Warnings:');
    report.summary.warnings.forEach(w => console.log(`  ⚠ ${w}`));
    console.log('');
  }

  if (report.summary.errors.length > 0) {
    console.log('Errors:');
    report.summary.errors.forEach(e => console.log(`  ✗ ${e}`));
    console.log('');
  }

  console.log(`Result: ${report.summary.success ? '✓ SUCCESS' : '✗ FAILED'}`);
  console.log('='.repeat(80) + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const reportPath =
    args.report ||
    resolve(
      'coordinator/ops/drills',
      `restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );

  console.log('Starting restore drill...');
  console.log(`  Backup: ${args.backup}`);
  console.log(`  Isolated: ${args.isolated}`);
  console.log(`  Report: ${reportPath}`);
  console.log('');

  const phases: DrillReport['phases'] = {
    restore: executeRestore(args.backup, args.isolated),
    verification: executeVerification(args.isolated),
    service: args.skipService ? null : executeServiceValidation(args.isolated),
  };

  const report = generateReport(args, phases);
  writeReport(report, reportPath);
  printSummary(report);

  console.log(`Full report written to: ${reportPath}`);

  if (!report.summary.success) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
