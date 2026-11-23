#!/usr/bin/env -S npx tsx
/**
 * Offline verifier for audit export manifests (issue #1135).
 *
 * Usage:
 *   pnpm --filter @wafflefinance/coordinator exec tsx \
 *     scripts/verify-audit-export.ts <export.ndjson> <manifest.json>
 *
 * Exits 0 when the export is complete and unchanged, 1 otherwise. No
 * database connection or database access is required.
 */
import { readFileSync } from 'node:fs';
import {
  verifyExportManifest,
  type ExportManifest,
} from '../src/audit/audit-exporter.js';

const [exportPath, manifestPath] = process.argv.slice(2);
if (!exportPath || !manifestPath) {
  console.error('usage: verify-audit-export.ts <export.ndjson> <manifest.json>');
  process.exit(2);
}

try {
  const ndjson = readFileSync(exportPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
  const result = verifyExportManifest(ndjson, manifest);
  if (!result.ok) {
    console.error(`INVALID: ${result.reason} (${result.records} records)`);
    process.exit(1);
  }
  console.log(
    `OK: ${result.records} records in range ${manifest.recordRange.firstId ?? 'empty'}` +
    `..${manifest.recordRange.lastId ?? 'empty'} (sha256 ${manifest.digest.value})`,
  );
} catch (err) {
  console.error(`INVALID: unreadable export or manifest: ${(err as Error).message}`);
  process.exit(1);
}
