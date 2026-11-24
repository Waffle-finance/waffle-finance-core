# Sensitive-Data Handling Policy

This document is the authoritative reference for how the coordinator
handles sensitive bridge data. The automated tests in
`coordinator/test/sensitive-data.test.ts` enforce every rule listed
here.

---

## Field Classification

| Field | Classification | Stored as | Logged as |
|-------|---------------|-----------|-----------|
| `preimage` | **SECRET** | AES-256-GCM encrypted blob (when `SECRET_STORAGE_KEY` is set); plaintext in dev/legacy | `[REDACTED]` always |
| `secret`, `secretKey`, `encKey` | **SECRET** | never persisted | `[REDACTED]` always |
| `privateKey`, `mnemonic`, `seed` | **SECRET** | never persisted | `[REDACTED]` always |
| `hashlock` | INTERNAL | plaintext | OK — hash of secret, not secret itself |
| `srcAddress`, `dstAddress` | PII-LITE | plaintext | OK |
| `resolverAddress` | INTERNAL | plaintext | OK |
| `publicId`, `status`, amounts | PUBLIC | plaintext | OK |

---

## Allowed Handling Paths for Preimage Material

Secret preimages may only flow through these approved paths:

### Write path
1. `SecretService.reveal(publicId, preimage, txHash)` — the only
   entry point for writing a preimage. It:
   - Validates `sha256(preimage) == hashlock OR keccak256(preimage) == hashlock`
   - Encrypts with AES-256-GCM if `SECRET_STORAGE_KEY` is set
   - Writes via `OrderService.recordSecret()` → `OrdersRepository.recordSecretRevealed()`

2. `Reconciler.replayEthClaimed / replaySorobanEvent / replaySolanaLogs`
   — all call `validatePreimage()` before writing, then delegate to path (1).

3. `SecretReconciler.recoverFromEthereumLogs()` — same validation gate.

### Read path
4. `SecretService.get(publicId)` — the only entry point for reading a
   preimage. It decrypts if necessary and returns the raw preimage to
   the HTTP route layer.

**No other code path may read or write a raw preimage to the database
or include it in any log output.**

---

## Logger Guard

`redactSensitiveFields(obj)` in
`coordinator/src/sensitive/sensitive-fields.ts` is a recursive
serializer that replaces any key in `SENSITIVE_FIELD_NAMES` with
`"[REDACTED]"` before the object reaches a log sink.

Apply it at every call site that might carry order data:

```ts
// Good — preimage is redacted automatically
log.warn(redactSensitiveFields({ preimage, publicId, err }), "reveal failed");

// Also good — use the serializer on the order key
log.info({ order: redactSensitiveFields(order) }, "order updated");
```

The `sensitiveSerializers()` helper returns a Pino `serializers` map
that applies redaction to the `order`, `err`, `req`, and `res` log
keys automatically when registered with the logger.

---

## Encryption at Rest

When `SECRET_STORAGE_KEY` is set in the coordinator environment:
- Format: `AES-256-GCM`, version byte `0x01`
- Key derivation: 64-char hex or 44-char base64 string → 32-byte buffer
- IV: 96-bit, freshly generated per encryption call
- Auth tag: 128-bit (GCM maximum) — tampering causes decryption to throw
- Stored column: `orders.preimage` holds the base64url-encoded blob
- Stored column: `orders.preimage_enc_version = 1` signals encrypted storage

The encryption layer lives in `coordinator/src/crypto/secret-cipher.ts`.
Key management:
- Store the key in AWS Secrets Manager, Vault, or equivalent.
- Never hardcode it; inject at runtime via the environment.
- Back up the key alongside database backups — without it, preimages
  are unrecoverable.
- For key rotation, use the version byte to add a new cipher suite
  without breaking existing rows.

---

## Database and Backup Encryption at Rest (#1138)

Application encryption protects preimages in `orders.preimage`; it does **not**
protect other metadata stored in the SQLite file, a Postgres cluster, or
backup copies. Every production deployment must record infrastructure evidence
for each applicable mode:

| Mode | Required control | Evidence |
|------|------------------|----------|
| SQLite volume | `encrypted-volume`, `luks`, or `cloud-managed-disk` | volume/provider encryption setting |
| Postgres | `provider-managed-tde` or `cloud-hsm-backed` | cluster encryption setting / KMS key |
| Backup storage | `provider-managed-encryption` or `kms-encrypted-object-store` | bucket/vault encryption policy |

The deployment metadata fields and validation hook are documented in
`docs/OPERATIONS.md`; `scripts/verify-encryption-at-rest.mjs` refuses to mark a
deployment verified without applicable control evidence.

**Residual risk:** infrastructure encryption does not protect data while
decrypted in memory, application logs, operator exports, or lost credentials.
Treat `SECRET_STORAGE_KEY` and volume/KMS keys as separate controls; rotating
one does not rotate the other. Backups remain encrypted only while their
provider policy and KMS key are intact.

**Incident procedure:** if at-rest evidence is missing or a volume/backup is
exposed, mark the deployment unverified, stop new reveals, rotate
`SECRET_STORAGE_KEY` and the affected storage key, re-encrypt/restore from a
known-good encrypted backup, and record the findings in the audit log. Never
log raw preimages or raw client addresses during the response.

---

## Retention Classes and Cleanup Verification (#1134)

`coordinator/src/retention/retention-policy.ts` is the authoritative mapping
between a sensitive-data category and its documented retention setting.
Cleanup is executed by `runRetentionCleanup(db, nowSeconds)` and returns an
auditable report (`inspected`, `removed`, `retained`, `cutoff`, `reason`) for
every category. Tests live in `coordinator/test/retention-policy.test.ts`.

| Category | Retention class | Retention | Cleanup action |
|----------|-----------------|-----------|----------------|
| Active settlement orders | `active_settlement` | until terminal + archived | never deleted or cleared |
| Audit records | `legal_audit` | 7 years (legal hold) | append-only; never updated or deleted |
| Secret ciphertext (`orders.preimage`) | `secret_ciphertext` | 30 days after terminal + archived | clear ciphertext columns in place, keep order/audit rows |
| Order history (`order_events`) | `order_history` | 10 years | retained for dispute resolution and exports |
| Request/replay metadata (`processed_events`) | `request_metadata` | 7 days | physical delete when expired |

The cleanup honors two hard constraints: an order that is still active (or
terminal but not archived) keeps its secret for recovery, and audit/order
history rows are never deleted. Removed values are excluded from subsequent
exports and must not appear in logs.

---

## Adding a New Sensitive Field

1. Add the field name to `SENSITIVE_FIELD_NAMES` in
   `coordinator/src/sensitive/sensitive-fields.ts`.
2. Add it to the Field Classification table above.
3. Add a test in `coordinator/test/sensitive-data.test.ts` proving
   the field is redacted.
4. Update this document.

---

## What Tests Enforce

`coordinator/test/sensitive-data.test.ts` verifies:

- `redactSensitiveFields` strips every name in `SENSITIVE_FIELD_NAMES`
- Redaction is recursive (nested objects, arrays)
- Non-sensitive fields are preserved
- Circular references do not cause infinite loops
- SecretService does NOT log the raw preimage on reveal
- SecretService does NOT log the raw preimage on failed reveal
- Invalid-preimage error messages do NOT contain the rejected preimage
- The repository's `findByPublicId` returns `preimage` only through
  approved read paths (SecretService.get)
- Log output captured during a reveal contains `[REDACTED]` not the
  plaintext preimage
