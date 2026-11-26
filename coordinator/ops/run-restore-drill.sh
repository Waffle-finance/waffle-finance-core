#!/usr/bin/env bash
# Automated restore drill execution script
#
# This script runs the complete restore drill procedure:
# 1. Generates a fixture database
# 2. Executes restore into an isolated database
# 3. Validates integrity and data quality
# 4. Produces a timestamped report
#
# Usage: ./coordinator/ops/run-restore-drill.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORDINATOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$COORDINATOR_DIR/.." && pwd)"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
FIXTURE_DIR="$COORDINATOR_DIR/drill-fixtures"
RESTORE_DIR="$COORDINATOR_DIR/drill-restore"
REPORT_DIR="$COORDINATOR_DIR/ops/drills"

FIXTURE_PATH="$FIXTURE_DIR/fixture-$TIMESTAMP.db"
RESTORE_PATH="$RESTORE_DIR/restored-$TIMESTAMP.db"
REPORT_PATH="$REPORT_DIR/restore-$TIMESTAMP.json"

echo "================================================"
echo "Coordinator Database Restore Drill"
echo "================================================"
echo "Timestamp: $TIMESTAMP"
echo "Fixture: $FIXTURE_PATH"
echo "Restore: $RESTORE_PATH"
echo "Report: $REPORT_PATH"
echo ""

# Create directories
mkdir -p "$FIXTURE_DIR" "$RESTORE_DIR" "$REPORT_DIR"

# Step 1: Generate fixture
echo "Step 1: Generating fixture database..."
pnpm --filter @wafflefinance/coordinator tsx scripts/generate-drill-fixture.ts \
  --out "$FIXTURE_PATH" \
  --active-orders 50 \
  --terminal-orders 200 \
  --with-secrets

echo ""

# Step 2: Execute restore drill
echo "Step 2: Executing restore drill..."
pnpm --filter @wafflefinance/coordinator tsx scripts/restore-drill.ts \
  --backup "$FIXTURE_PATH" \
  --isolated "$RESTORE_PATH" \
  --report "$REPORT_PATH"

echo ""
echo "================================================"
echo "Drill complete!"
echo ""
echo "Review the report:"
echo "  cat $REPORT_PATH | jq '.summary'"
echo ""
echo "Start coordinator with restored database:"
echo "  DATABASE_URL=file:$RESTORE_PATH pnpm --filter @wafflefinance/coordinator dev"
echo "================================================"
