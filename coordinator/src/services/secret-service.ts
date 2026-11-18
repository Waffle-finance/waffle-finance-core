import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { keccak256, toHex } from "viem";
import { OrderValidationError, type OrderService } from "./order-service.js";

export interface SecretStorageKeyConfig {
  current?: string;
  primary?: string;
  previous?: string | string[];
  fallback?: string | string[];
  additional?: string | string[];
}

export type SecretStorageKeyInput = string | SecretStorageKeyConfig;
import {
  deriveKey,
  encryptSecret,
  decryptSecret,
  isEncryptedBlob
} from "../crypto/secret-cipher.js";
import {
  UnknownOrderError,
  InvalidPreimageError,
  RevealConflictError,
  SecretStorageError
} from "./secret-errors.js";

function bufferFromHex(s: string): Buffer {
  return Buffer.from(s.startsWith("0x") ? s.slice(2) : s, "hex");
}

function sha256Hex(buf: Buffer): string {
  return "0x" + createHash("sha256").update(buf).digest("hex");
}

function keccak256Hex(buf: Buffer): string {
  return keccak256(toHex(buf)) as `0x${string}`;
}

/**
 * Coordinates secret reveal between the two chains.
 *
 * The coordinator never holds funds, so revealing a secret to it cannot
 * cause loss of user funds — at worst the coordinator could withhold
 * the secret, in which case the user can retrieve it themselves
 * directly from the on-chain `OrderClaimed` event on whichever side
 * settled first.
 *
 * ## Encryption at rest
 *
 * When `secretStorageKey` is provided in config, preimages are stored
 * encrypted using AES-256-GCM before being written to the database.
 * On retrieval the service decrypts transparently.
 *
 * Existing plaintext rows (written before encryption was enabled) are
 * handled via a graceful fallback: if the stored value looks like a raw
 * `0x…` hex string it is returned as-is.  If it looks like an encrypted
 * blob, decryption is attempted.
 *
 * If encryption is NOT configured the service behaves identically to the
 * original implementation — no behaviour change for operators who have
 * not set `SECRET_STORAGE_KEY`.
 */
export class SecretService {
  /** Ordered key ring used for decryption and writes. */
  private readonly encKeys: Buffer[];
  private readonly writeKey: Buffer | undefined;

  constructor(
    private readonly orders: OrderService,
    private readonly log: Logger,
    secretStorageKey?: SecretStorageKeyInput,
    /**
     * Runtime network mode, taken from the coordinator's existing
     * `network` config (`"testnet" | "mainnet"`). `"mainnet"` is treated
     * as production: plaintext preimage storage is not permitted there.
     * Defaults to `"testnet"` so existing local/dev callers and test
     * fixtures that omit this argument keep working unchanged.
     */
    private readonly network: "testnet" | "mainnet" = "testnet"
  ) {
    const configuredKeys = SecretService.normalizeKeys(secretStorageKey);

    if (configuredKeys.length > 0) {
      try {
        this.encKeys = configuredKeys.map((value) => deriveKey(value));
        this.writeKey = this.encKeys[0];
        this.log.info(
          { keyCount: this.encKeys.length, network: this.network },
          "SecretService: preimage encryption at rest ENABLED (AES-256-GCM)"
        );
      } catch (err) {
        // Fail fast at startup — a bad key config must never silently fall
        // back to plaintext; that would make it hard to detect misconfiguration.
        throw new Error(
          `SecretService: invalid SECRET_STORAGE_KEY — ${(err as Error).message}`
        );
      }
    } else {
      if (this.network === "mainnet") {
        // Production guard: a mainnet coordinator must never silently
        // persist preimages in plaintext. Fail startup loudly instead.
        // (No key material or preimages are included in this message.)
        throw new Error(
          "SecretService: SECRET_STORAGE_KEY is required when network=mainnet. " +
          "Refusing to start in plaintext mode in production. " +
          "Set SECRET_STORAGE_KEY (or use an explicit documented test config " +
          "with network=testnet for local/dev)."
        );
      }

      this.encKeys = [];
      this.writeKey = undefined;
      this.log.warn(
        { network: this.network },
        "SecretService: SECRET_STORAGE_KEY is not set. " +
        "Preimages will be stored as PLAINTEXT. " +
        "Set SECRET_STORAGE_KEY to enable encryption at rest."
      );
    }
  }

  private static normalizeKeys(secretStorageKey?: SecretStorageKeyInput): string[] {
    if (!secretStorageKey) {
      return [];
    }

    if (typeof secretStorageKey === "string") {
      return [secretStorageKey.trim()].filter(Boolean);
    }

    const values: string[] = [];
    const pushValue = (value: string | string[] | undefined) => {
      if (!value) {
        return;
      }
      if (Array.isArray(value)) {
        values.push(...value.map((item) => item.trim()).filter(Boolean));
      } else {
        const trimmed = value.trim();
        if (trimmed) {
          values.push(trimmed);
        }
      }
    };

    pushValue(secretStorageKey.current ?? secretStorageKey.primary);
    pushValue(secretStorageKey.previous);
    pushValue(secretStorageKey.fallback);
    pushValue(secretStorageKey.additional);

    return Array.from(new Set(values));
  }

  /**
   * Record a preimage revealed by a resolver or by the user. The
   * coordinator verifies the preimage hashes to the order's hashlock
   * before storing it, so a malicious caller cannot poison the cache.
   *
   * When encryption is enabled the preimage is encrypted with AES-256-GCM
   * before it reaches the database.
   *
   * Failures are classified into typed {@link SecretRevealError} subclasses
   * so callers can distinguish an unknown order, an invalid preimage, a
   * stale/replayed reveal, and a transient storage failure. See
   * {@link ./secret-errors.ts} for the full failure model.
   */
  async reveal(publicId: string, preimage: string, txHash: string): Promise<{ ok: true }> {
    const order = await this.orders.get(publicId);
    if (!order) {
      throw new UnknownOrderError(`unknown order ${publicId}`);
    }

    const buf = bufferFromHex(preimage);
    const shaHash = sha256Hex(buf);
    const kekHash = keccak256Hex(buf);

    if (shaHash !== order.hashlock && kekHash !== order.hashlock) {
      // NOTE: log the hashes (not secret) for debugging, but never include
      // them in the thrown error message returned to the client.
      this.log.warn(
        { publicId, expected: order.hashlock, sha: shaHash, kek: kekHash },
        "rejected preimage with mismatching hash"
      );
      throw new InvalidPreimageError("preimage does not match order hashlock");
    }

    // Encrypt before persistence if a key is configured.
    const valueToStore = this.writeKey
      ? encryptSecret(preimage, this.writeKey)
      : preimage;

    // encVersion=1 means AES-256-GCM; null means plaintext.
    const encVersion = this.writeKey ? 1 : null;

    try {
      await this.orders.recordSecret(publicId, valueToStore, txHash, encVersion);
    } catch (err) {
      throw this.classifyStorageFailure(publicId, err);
    }

    this.log.debug(
      { publicId, encrypted: !!this.writeKey },
      "secret stored"
    );
    return { ok: true };
  }

  /**
   * Map a `recordSecret` failure onto a typed {@link SecretRevealError}.
   *
   * `OrderService.recordSecret` raises `OrderValidationError` for two
   * distinct situations:
   *   - the order disappeared between our lookup and the write (a race) →
   *     {@link UnknownOrderError};
   *   - the order can no longer transition into `secret_revealed` because it
   *     has advanced to a terminal state (a stale or replayed reveal) →
   *     {@link RevealConflictError}.
   *
   * Anything else is an unexpected persistence error and is reported as a
   * retryable {@link SecretStorageError}. The underlying error is logged but
   * never echoed to the client, so DB internals are not exposed.
   */
  private classifyStorageFailure(publicId: string, err: unknown): Error {
    if (err instanceof OrderValidationError) {
      if (/unknown order/i.test(err.message)) {
        return new UnknownOrderError(`unknown order ${publicId}`);
      }
      return new RevealConflictError(
        "order is no longer in a state that can accept a secret reveal"
      );
    }

    this.log.error({ publicId, err }, "failed to persist revealed secret");
    return new SecretStorageError("failed to persist revealed secret");
  }

  /**
   * Look up a previously revealed preimage. Returns null if not
   * revealed yet.
   *
   * Handles three cases transparently:
   *  1. No stored value → returns null.
   *  2. Plaintext `0x…` value (legacy or encryption disabled) → returned as-is.
   *  3. Encrypted blob → decrypted and returned.
   *
   * If decryption fails (wrong key, corrupted blob) the error is logged
   * and re-thrown so callers receive a clear signal rather than corrupt data.
   */
  async get(publicId: string): Promise<string | null> {
    const order = await this.orders.get(publicId);
    if (!order?.preimage) {
      return null;
    }

    const stored = order.preimage;

    // Fast path: plaintext (legacy rows or encryption disabled).
    if (!isEncryptedBlob(stored)) {
      return stored;
    }

    // Encrypted blob path.
    if (this.encKeys.length === 0) {
      // Blob present but no key — coordinator cannot decrypt.  This
      // happens if SECRET_STORAGE_KEY is removed after data was written.
      // Log a loud error so operators notice, and surface it via the API
      // as a 500 rather than silently returning null.
      this.log.error(
        { publicId },
        "SecretService: stored preimage appears encrypted but SECRET_STORAGE_KEY is not set. " +
        "Cannot decrypt — set SECRET_STORAGE_KEY to restore access."
      );
      throw new Error(
        "stored preimage is encrypted but no decryption key is configured; " +
        "set SECRET_STORAGE_KEY in the coordinator environment"
      );
    }

    let lastError: Error | undefined;
    for (const key of this.encKeys) {
      try {
        const plaintext = decryptSecret(stored, key);
        if (this.writeKey && key !== this.writeKey) {
          await this.reencryptStoredSecret(publicId, plaintext, order, stored);
        }
        return plaintext;
      } catch (err) {
        lastError = err as Error;
      }
    }

    this.log.error(
      { publicId, err: lastError },
      "SecretService: failed to decrypt stored preimage"
    );
    throw new Error(
      `failed to decrypt preimage for order ${publicId}: ${(lastError as Error).message}`
    );
  }

  private async reencryptStoredSecret(
    publicId: string,
    plaintext: string,
    order: { secretRevealedTx?: string | null },
    stored: string
  ): Promise<void> {
    if (!this.writeKey || !stored || !isEncryptedBlob(stored)) {
      return;
    }

    try {
      const reencrypted = encryptSecret(plaintext, this.writeKey);
      await this.orders.recordSecret(
        publicId,
        reencrypted,
        order.secretRevealedTx ?? "0xrekey",
        1
      );
    } catch (err) {
      this.log.warn(
        { publicId, err },
        "SecretService: opportunistic key rotation re-encryption skipped"
      );
    }
  }
}
