/**
 * Tests for scripts/verify-encryption-at-rest.mjs (#1138).
 * Run with: node --test scripts/test/encryption-at-rest.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  SUPPORTED_AT_REST_MODES,
  verifyMode,
  verifyDeploymentRecord,
  verifyDocumentation,
} from '../verify-encryption-at-rest.mjs';

const evidence = {
  control: 'provider-managed-tde',
  reference: 'console://postgres/cluster/encryption',
};

function verifiedRecord() {
  return {
    encryptionAtRest: {
      sqlite: {
        mode: 'encrypted-volume',
        verified: true,
        evidence: { control: 'encrypted-volume', reference: 'volume://db' },
        verifiedAt: '2026-11-23T00:00:00Z',
        verifiedBy: 'ops@example.com',
      },
      postgres: {
        mode: 'provider-managed-tde',
        verified: true,
        evidence,
        verifiedAt: '2026-11-23T00:00:00Z',
        verifiedBy: 'ops@example.com',
      },
      backup: {
        mode: 'kms-encrypted-object-store',
        verified: true,
        evidence: { control: 'kms-encrypted-object-store', reference: 'kms://backup-key' },
        verifiedAt: '2026-11-23T00:00:00Z',
        verifiedBy: 'ops@example.com',
      },
    },
  };
}

describe('database encryption-at-rest deployment verification', () => {
  it('inventory covers SQLite, Postgres and backup storage', () => {
    assert.deepEqual(Object.keys(SUPPORTED_AT_REST_MODES), ['sqlite', 'postgres', 'backup']);
  });

  it('accepts a verified deployment with control evidence for every mode', () => {
    assert.deepEqual(verifyDeploymentRecord(verifiedRecord()), { ok: true, errors: [] });
  });

  it('rejects a verified deployment without evidence', () => {
    const record = verifiedRecord();
    record.encryptionAtRest.postgres.evidence = undefined;
    const result = verifyDeploymentRecord(record);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('postgres: verified deployment requires control evidence')));
  });

  it('rejects unsupported controls and missing verifier metadata', () => {
    const errors = verifyMode('sqlite', {
      mode: 'plaintext',
      verified: true,
      evidence,
    });
    assert.ok(errors.some((e) => e.includes('control mode must be one of')));
    assert.ok(errors.some((e) => e.includes('verifiedAt is required')));
    assert.ok(errors.some((e) => e.includes('verifiedBy is required')));
  });

  it('rejects a deployment missing a supported mode entirely', () => {
    const record = verifiedRecord();
    delete record.encryptionAtRest.backup;
    assert.equal(verifyDeploymentRecord(record).ok, false);
  });

  it('requires the checklist fields in deployment documentation', () => {
    assert.equal(verifyDocumentation('DB_ENCRYPTION_AT_REST_MODE DB_ENCRYPTION_AT_REST_CONTROL').ok, false);
    assert.equal(
      verifyDocumentation(
        'DB_ENCRYPTION_AT_REST_MODE DB_ENCRYPTION_AT_REST_CONTROL DB_ENCRYPTION_AT_REST_EVIDENCE DB_ENCRYPTION_AT_REST_VERIFIED_AT DB_ENCRYPTION_AT_REST_VERIFIED_BY',
      ).ok,
      true,
    );
  });
});
