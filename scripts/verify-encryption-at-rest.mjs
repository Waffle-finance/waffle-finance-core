/**
 * scripts/verify-encryption-at-rest.mjs
 *
 * Deployment verification hook for database/back-up encryption at rest (#1138).
 *
 * Usage:
 *   node scripts/verify-encryption-at-rest.mjs [--record path/to/deployment.json]
 *
 * Without --record, validates that the deployment documentation contains the
 * required checklist fields. With --record, validates the platform metadata
 * for every supported deployment mode. Exit code 1 means verification failed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Required evidence for each supported production deployment mode. */
export const SUPPORTED_AT_REST_MODES = {
  sqlite: ['encrypted-volume', 'luks', 'cloud-managed-disk'],
  postgres: ['provider-managed-tde', 'cloud-hsm-backed'],
  backup: ['provider-managed-encryption', 'kms-encrypted-object-store'],
};

export const REQUIRED_CHECKLIST_FIELDS = [
  'DB_ENCRYPTION_AT_REST_MODE',
  'DB_ENCRYPTION_AT_REST_CONTROL',
  'DB_ENCRYPTION_AT_REST_EVIDENCE',
  'DB_ENCRYPTION_AT_REST_VERIFIED_AT',
  'DB_ENCRYPTION_AT_REST_VERIFIED_BY',
];

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Verify one deployment mode entry.
 * A deployment marked verified must record the applicable control evidence —
 * no evidence means no verification.
 */
export function verifyMode(mode, entry) {
  const errors = [];
  const allowed = SUPPORTED_AT_REST_MODES[mode];
  if (!allowed) return [`unknown deployment mode: ${mode}`];
  if (!entry || typeof entry !== 'object') return [`missing verification metadata for ${mode}`];

  if (!allowed.includes(entry.mode)) {
    errors.push(`${mode}: control mode must be one of ${allowed.join(', ')}`);
  }
  if (entry.verified === true) {
    if (!entry.evidence || typeof entry.evidence !== 'object') {
      errors.push(`${mode}: verified deployment requires control evidence`);
    } else {
      if (!nonEmpty(entry.evidence.control)) errors.push(`${mode}: evidence.control is required`);
      if (!nonEmpty(entry.evidence.reference)) errors.push(`${mode}: evidence.reference is required`);
      if (!nonEmpty(entry.verifiedAt)) errors.push(`${mode}: verifiedAt is required`);
      if (!nonEmpty(entry.verifiedBy)) errors.push(`${mode}: verifiedBy is required`);
    }
  }
  return errors;
}

/** Verify a deployment record containing `encryptionAtRest` keyed by mode. */
export function verifyDeploymentRecord(record) {
  const atRest = record?.encryptionAtRest ?? record?.verification?.encryptionAtRest;
  if (!atRest || typeof atRest !== 'object') {
    return { ok: false, errors: ['deployment record has no encryptionAtRest verification block'] };
  }
  const errors = [];
  for (const [mode, entry] of Object.entries(atRest)) {
    errors.push(...verifyMode(mode, entry));
  }
  for (const mode of Object.keys(SUPPORTED_AT_REST_MODES)) {
    if (!atRest[mode]) errors.push(`${mode}: verification metadata is required`);
  }
  return { ok: errors.length === 0, errors };
}

/** Documentation fallback used by the no-argument CI validation hook. */
export function verifyDocumentation(docs) {
  const errors = [];
  for (const field of REQUIRED_CHECKLIST_FIELDS) {
    if (!docs.includes(field)) errors.push(`deployment documentation is missing checklist field ${field}`);
  }
  return { ok: errors.length === 0, errors };
}

function main() {
  const args = process.argv.slice(2);
  let result;
  if (args[0] === '--record') {
    const file = args[1];
    if (!file) {
      console.error('verify-encryption-at-rest: --record requires a JSON path');
      process.exit(1);
    }
    result = verifyDeploymentRecord(JSON.parse(readFileSync(file, 'utf8')));
  } else {
    const docs = [
      path.join(ROOT, 'docs', 'OPERATIONS.md'),
      path.join(ROOT, 'coordinator', 'src', 'sensitive', 'SENSITIVE_DATA_POLICY.md'),
    ].map((f) => readFileSync(f, 'utf8')).join('\n');
    result = verifyDocumentation(docs);
  }
  if (!result.ok) {
    for (const error of result.errors) console.error(`verify-encryption-at-rest: ${error}`);
    process.exit(1);
  }
  console.log('encryption-at-rest deployment verification: OK');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
