# Coordinator Database Restore Drill

Disaster recovery procedures must be validated regularly to ensure operators can restore service within acceptable recovery time objectives (RTO) and identify metadata that cannot be reconstructed from chain events alone.

This document describes the restore drill framework and execution procedure.

## Overview

The restore drill validates the complete backup-restore lifecycle documented in [backup-restore.md](../docs/backup-restore.md) using an automated script that:

1. Generates a sanitized fixture database with representative data
2. Executes backup and restore in an isolated environment
3. Verifies database integrity, schema, and data quality
4. Measures recovery time and identifies gaps in runbook documentation
5. Produces a timestamped report for audit and runbook improvement

## Drill Components

### 1. Fixture Generator

**Script**: `scripts/generate-drill-fixture.ts`

Generates a SQLite database with:
- **Active orders**: Orders in `src_locked` or `dst_locked` state
- **Terminal orders**: Orders in `completed`, `refunded`, `failed`, or `cancelled` state
- **Order events**: Complete event history for each order
- **Encrypted secrets**: Sanitized encrypted preimages (optional)
- **Audit log**: Operational log entries
- **Chain cursors**: Listener positions for each chain
- **Soroban checkpoints**: Historical checkpoint records

All data uses deterministic hashes and synthetic addresses to prevent leaking production secrets.

**Usage**:

```bash
pnpm --filter @wafflefinance/coordinator tsx scripts/generate-drill-fixture.ts \
  --out ./drill-fixtures/coordinator-fixture.db \
  --active-orders 50 \
  --terminal-orders 200 \
  --with-secrets
```

### 2. Restore Drill Executor

**Script**: `scripts/restore-drill.ts`

Executes the restore procedure and validates the result:

**Phase 1: Restore**
- Calls `db-restore.ts` with the fixture as the backup source
- Restores into an isolated database path
- Measures restore duration

**Phase 2: Verification**
- Runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`
- Validates migration history against expected registry
- Counts orders, events, audit entries, and other records
- Checks for data quality issues:
  - Duplicate `public_id` values
  - Orphan events (events without matching orders)
  - Invalid timestamps (`created_at > updated_at`)

**Phase 3: Service Validation** (optional)
- Confirms database can be opened and migrations are present
- Full validation requires starting the coordinator with `DATABASE_URL` pointing to the isolated database and checking `/healthz` and `/readyz` endpoints

**Usage**:

```bash
pnpm --filter @wafflefinance/coordinator tsx scripts/restore-drill.ts \
  --backup ./drill-fixtures/coordinator-fixture.db \
  --isolated ./drill-restore/coordinator.db \
  --report ./ops/drills/restore-$(date -u +%Y-%m-%dT%H-%M-%SZ).json
```

### 3. Drill Report

The script generates a JSON report with:

```json
{
  "timestamp": "2026-07-15T10:30:00.000Z",
  "backup": "./drill-fixtures/coordinator-fixture.db",
  "isolated": "./drill-restore/coordinator.db",
  "phases": {
    "restore": {
      "phase": "restore",
      "startTime": "2026-07-15T10:30:00.000Z",
      "durationMs": 1234,
      "success": true,
      "details": {},
      "errors": []
    },
    "verification": {
      "phase": "verification",
      "startTime": "2026-07-15T10:30:01.234Z",
      "durationMs": 567,
      "success": true,
      "details": {
        "integrity": true,
        "foreignKeys": true,
        "migrations": {
          "expected": ["001_initial.sql", "..."],
          "applied": ["001_initial.sql", "..."],
          "valid": true
        },
        "counts": {
          "orders": 250,
          "activeOrders": 50,
          "terminalOrders": 200,
          "events": 850,
          "auditEntries": 250
        },
        "dataQuality": {
          "duplicatePublicIds": 0,
          "orphanEvents": 0,
          "invalidTimestamps": 0
        }
      },
      "errors": []
    },
    "service": {
      "phase": "service",
      "startTime": "2026-07-15T10:30:01.801Z",
      "durationMs": 123,
      "success": true,
      "details": {
        "migrationsPresent": true,
        "note": "Full service validation requires starting coordinator"
      },
      "errors": []
    }
  },
  "summary": {
    "totalDurationMs": 1924,
    "success": true,
    "errors": [],
    "warnings": [
      "50 active orders may have incomplete chain state"
    ]
  }
}
```

## Execution Procedure

### Prerequisites

- Coordinator repository checked out
- Dependencies installed (`pnpm install`)
- Node.js 22.5+ or 24.x (for `node:sqlite` support)
- Write access to `drill-fixtures/` and `drill-restore/` directories

### Step-by-Step

1. **Generate fixture database**:

   ```bash
   mkdir -p coordinator/drill-fixtures coordinator/drill-restore coordinator/ops/drills
   
   pnpm --filter @wafflefinance/coordinator tsx scripts/generate-drill-fixture.ts \
     --out coordinator/drill-fixtures/coordinator-fixture-$(date -u +%Y%m%d).db \
     --active-orders 50 \
     --terminal-orders 200 \
     --with-secrets
   ```

   Expected output: Summary of orders, events, and audit entries created.

2. **Execute restore drill**:

   ```bash
   pnpm --filter @wafflefinance/coordinator tsx scripts/restore-drill.ts \
     --backup coordinator/drill-fixtures/coordinator-fixture-$(date -u +%Y%m%d).db \
     --isolated coordinator/drill-restore/restored-$(date -u +%Y%m%d).db \
     --report coordinator/ops/drills/restore-$(date -u +%Y-%m-%dT%H-%M-%SZ).json
   ```

   Expected output: Timestamped report with restore, verification, and service phases.

3. **Review drill report**:

   ```bash
   cat coordinator/ops/drills/restore-*.json | jq '.summary'
   ```

   - `success: true` indicates all checks passed
   - `errors` array lists any failures
   - `warnings` array lists potential issues (e.g., active orders with incomplete state)
   - `totalDurationMs` is the recovery time objective (RTO) baseline

4. **Optional: Start coordinator against restored database**:

   ```bash
   DATABASE_URL=file:coordinator/drill-restore/restored-$(date -u +%Y%m%d).db \
   pnpm --filter @wafflefinance/coordinator dev
   ```

   In a separate terminal:

   ```bash
   curl http://localhost:3001/healthz
   curl http://localhost:3001/readyz
   curl http://localhost:3001/metrics | grep coordinator_
   ```

   Expected:
   - `/healthz` returns `{"ok":true}`
   - `/readyz` returns HTTP 200 with `status: "ok"` and passing `database` check
   - `/metrics` exports `coordinator_*` metrics

5. **Document findings**:

   - If any step failed, record the error in a ticket and update [backup-restore.md](../docs/backup-restore.md)
   - If verification found data quality issues, investigate root cause
   - If RTO exceeds acceptable threshold, consider optimizations (e.g., incremental backups, parallel restore)
   - Update the runbook with any missing steps or clarifications

### Expected RTO Baselines

| Database Size | Active Orders | Terminal Orders | Expected Restore Time |
|---------------|---------------|-----------------|----------------------|
| Small (< 10 MB) | < 100 | < 1,000 | < 5 seconds |
| Medium (10-100 MB) | 100-1,000 | 1,000-10,000 | < 30 seconds |
| Large (> 100 MB) | > 1,000 | > 10,000 | < 2 minutes |

PostgreSQL restore times depend on network latency, `pg_restore` parallelization, and target database size. For production, expect 2-5× longer than SQLite due to `--clean` DDL execution.

## Non-Reconstructible Metadata

The coordinator database is designed as a cache of on-chain state, but certain metadata **cannot** be reconstructed from chain events alone:

### 1. Active Order Secrets

**Table**: `order_secrets`

**Issue**: Encrypted preimages are stored locally and never published on-chain until the recipient claims. If the database is lost before the secret is revealed on-chain, active orders in `src_locked` or `dst_locked` state cannot be completed.

**Mitigation**:
- Backup frequency must be < average order completion time
- Consider external secret storage (HSM, key vault) with references in the database
- Implement secret recovery from coordinator-to-coordinator handoff protocol

### 2. Audit Log

**Table**: `audit_log`

**Issue**: Operational log entries are not stored on-chain. Loss of audit log reduces forensic capability but does not affect order processing.

**Mitigation**:
- Export audit log to external logging system (e.g., CloudWatch, Datadog)
- Retain audit log backups separately from database backups

### 3. Chain Cursor Positions

**Table**: `chain_cursors`

**Issue**: Listener cursor positions are not on-chain. After restore, the coordinator must rescan from a safe checkpoint or the genesis block to avoid missing events.

**Mitigation**:
- Store cursor positions in backups (already done)
- Implement checkpoint recovery from Soroban checkpoint table
- Accept short rescan window (< 1 hour) as acceptable RTO tradeoff

### 4. Order Event Timestamps

**Table**: `order_events`

**Issue**: The `recorded_at` timestamp reflects when the coordinator observed the event, not the block timestamp. This may differ due to listener lag or downtime.

**Mitigation**:
- Prefer `block_timestamp` for event ordering
- Document that `recorded_at` is informational only

## Drill Frequency

| Environment | Frequency | Trigger |
|-------------|-----------|---------|
| Development | Weekly | Automated CI job |
| Staging | Monthly | Manual execution by ops team |
| Production | Quarterly | Scheduled maintenance window |

After any database schema change (new migration), execute a drill to validate backward compatibility.

## Troubleshooting

### Restore Phase Fails

**Symptom**: `restore.success: false` in report

**Diagnosis**:
- Check `restore.errors` for specific error message
- Verify backup file exists and is readable
- Confirm isolated database path is writable
- Check `db-restore.ts` output for detailed error

**Resolution**:
- Fix backup file path or permissions
- Re-run drill with correct arguments

### Verification Phase Fails

**Symptom**: `verification.success: false` in report

**Diagnosis**:
- Check `verification.errors` for specific failure:
  - `Integrity check failed` → Corrupted backup file
  - `Foreign key violations` → Data inconsistency in backup
  - `Migration history mismatch` → Backup from different coordinator version
  - `Duplicate public_ids` → Database bug (file a critical ticket)
  - `Orphan events` → Data inconsistency (investigate)
  - `Invalid timestamps` → Data quality issue (investigate)

**Resolution**:
- If backup is corrupted, regenerate fixture
- If migration mismatch, use matching coordinator release
- If data quality issue, fix root cause in production database before next backup

### Service Phase Fails

**Symptom**: `service.success: false` in report

**Diagnosis**:
- Coordinator fails to start with `DATABASE_URL` pointing to restored database
- Check `/readyz` for `database` detail status

**Resolution**:
- If `missing_migrations`, apply missing migrations to restored database
- If `schema_mismatch`, verify restored database matches coordinator release

## References

- [Backup and Restore Documentation](../docs/backup-restore.md)
- [Production Runbook](./RUNBOOK.md)
- [Migration Strategy](../docs/migration-strategy.md)
