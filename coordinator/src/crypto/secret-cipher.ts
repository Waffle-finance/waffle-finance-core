/**
 * AES-256-GCM authenticated encryption for HTLC preimage storage.
 *
 * Format of an encrypted blob (all base64url-encoded as a single string):
 *
 *   <version:1 byte> <iv:12 bytes> <authTag:16 bytes> <ciphertext:N bytes>
 *
 * The version byte allows future cipher-suite rotation without a
 * coordinated migration.  Currently only version 0x01 (AES-256-GCM) is
 * defined.
 *
 * The plaintext stored is the raw hex preimage string exactly as the
 * coordinator received it (e.g. "0xabcd…"). No padding is added.
 *
 * Security properties:
 *  - AES-256-GCM provides authenticated encryption — tampering with the
 *    ciphertext or auth-tag causes decryption to throw rather than return
 *    corrupt plaintext.
 *  - A fresh 96-bit IV is generated for every encryption call, making each
 *    encrypted blob unique even for identical preimages.
 *  - The master key is 32 bytes, derived from the hex string provided in
 *    the environment variable SECRET_STORAGE_KEY.
 *
 * Key management notes:
 *  - Store the key in a secrets manager (AWS Secrets Manager, Vault, etc.)
 *    and inject it as SECRET_STORAGE_KEY at runtime. Never hardcode it.
 *  - For key rotation: the version byte allows a new cipher suite.
 *    Existing rows can be decrypted with the old key; you can re-encrypt
 *    them in a one-off migration job.
 *  - Back up the key alongside a database backup — without the key the
 *    preimages are unrecoverable.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Only version in use today: AES-256-GCM. */
const VERSION_AES256GCM = 0x01;
/** AES-256-GCM blob carrying an explicit key identifier (key rotation). */
const VERSION_AES256GCM_KEY_ID = 0x02;
const MAX_KEY_ID_BYTES = 64;

const IV_BYTES = 12;        // 96-bit IV — GCM standard
const TAG_BYTES = 16;       // 128-bit auth tag — GCM maximum
const KEY_BYTES = 32;       // 256-bit AES key

/**
 * Derive a 32-byte key Buffer from a hex or base64 string supplied by the
 * operator. Accepts:
 *  - 64-character hex string (32 bytes)
 *  - 44-character base64 string (32 bytes)
 *
 * Throws a descriptive error if the input is unusable so the coordinator
 * fails at startup rather than silently using a weak key.
 */
export function deriveKey(rawKey: string): Buffer {
  const stripped = rawKey.trim();

  // 64 hex chars → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    return Buffer.from(stripped, "hex");
  }

  // 44 base64 chars → 32 bytes (standard or URL-safe)
  const b64 = stripped.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(b64, "base64");
  if (decoded.length === KEY_BYTES) {
    return decoded;
  }

  throw new Error(
    `SECRET_STORAGE_KEY must be a 64-character hex string or 44-character base64 string ` +
    `encoding exactly 32 bytes. Got ${stripped.length} characters.`
  );
}

/**
 * Encrypt a preimage string with AES-256-GCM.
 *
 * @param plaintext  The raw preimage hex string (e.g. "0xabc123…").
 * @param key        32-byte key buffer produced by {@link deriveKey}.
 * @param keyId      Optional versioned key identifier (e.g. `"k-2026-01"`).
 *                   When supplied the blob uses format 0x02 so operators can
 *                   verify which storage key encrypted each record.
 * @returns          Base64url-encoded encrypted blob. Store this in place
 *                   of the plaintext `preimage` column.
 */
export function encryptSecret(plaintext: string, key: Buffer, keyId?: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Key must be exactly ${KEY_BYTES} bytes`);
  }

  const keyIdBytes = keyId ? Buffer.from(keyId, "utf8") : Buffer.alloc(0);
  if (keyIdBytes.length > MAX_KEY_ID_BYTES) {
    throw new Error(`Key identifier must be at most ${MAX_KEY_ID_BYTES} bytes`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  // Legacy layout:  [version(1)] [iv(12)] [authTag(16)] [ciphertext(N)]
  // Versioned layout: [version(2)] [keyIdLen(1)] [keyId] [iv] [tag] [ciphertext]
  const blob = keyIdBytes.length
    ? Buffer.concat([
        Buffer.from([VERSION_AES256GCM_KEY_ID, keyIdBytes.length]),
        keyIdBytes,
        iv,
        authTag,
        encrypted
      ])
    : Buffer.concat([Buffer.from([VERSION_AES256GCM]), iv, authTag, encrypted]);

  return blob.toString("base64url");
}

/**
 * Decrypt an encrypted blob produced by {@link encryptSecret}.
 *
 * @param blob  Base64url-encoded encrypted blob.
 * @param key   32-byte key buffer produced by {@link deriveKey}.
 * @returns     The original plaintext preimage string.
 * @throws      If the version is unknown, the auth tag fails, or the blob
 *              is malformed.
 */
export function decryptSecret(blob: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Key must be exactly ${KEY_BYTES} bytes`);
  }

  const buf = Buffer.from(blob, "base64url");

  // Minimum: 1 (version) + 12 (iv) + 16 (tag) + 1 (at least one ciphertext byte)
  const MIN_LENGTH = 1 + IV_BYTES + TAG_BYTES + 1;
  if (buf.length < MIN_LENGTH) {
    throw new Error("Encrypted blob is too short to be valid");
  }

  const version = buf[0] as number;
  let offset = 1;
  if (version === VERSION_AES256GCM_KEY_ID) {
    const keyIdLength = buf[1] as number;
    if (keyIdLength === 0 || keyIdLength > MAX_KEY_ID_BYTES || buf.length < 2 + keyIdLength + IV_BYTES + TAG_BYTES + 1) {
      throw new Error("Encrypted blob has a malformed key identifier");
    }
    offset = 2 + keyIdLength;
  } else if (version !== VERSION_AES256GCM) {
    throw new Error(
      `Unknown encryption version 0x${version.toString(16).padStart(2, "0")}. ` +
      `Only AES-256-GCM (version 0x01/0x02) is supported.`
    );
  }

  const iv = buf.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const authTag = buf.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ciphertext = buf.subarray(offset);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    // Wrap the Node crypto error with a more descriptive message to avoid
    // leaking internal details in logs while still being actionable.
    throw new Error(
      "Decryption failed: authentication tag mismatch. The key may be wrong, " +
      "or the stored blob has been tampered with."
    );
  }
}

/**
 * Return the key identifier recorded in a versioned ciphertext blob, or
 * `undefined` for legacy (0x01) blobs. Used by the rotation tool to verify
 * which records still need re-encryption before an old key is retired.
 * Never returns plaintext or key material.
 */
export function readKeyId(blob: string): string | undefined {
  const buf = Buffer.from(blob, "base64url");
  if (buf[0] !== VERSION_AES256GCM_KEY_ID) return undefined;
  const length = buf[1] as number;
  if (length === 0 || length > MAX_KEY_ID_BYTES || buf.length < 2 + length) {
    throw new Error("Encrypted blob has a malformed key identifier");
  }
  return buf.subarray(2, 2 + length).toString("utf8");
}

/**
 * Return true if the given string looks like an encrypted blob produced
 * by {@link encryptSecret} rather than a raw plaintext preimage.
 *
 * Heuristic: plaintext preimages are always 0x-prefixed hex strings.
 * Encrypted blobs are base64url without a 0x prefix.
 */
export function isEncryptedBlob(value: string): boolean {
  return !value.startsWith("0x") && /^[A-Za-z0-9_-]+$/.test(value);
}
