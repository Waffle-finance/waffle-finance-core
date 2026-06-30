/**
 * Tests for SecretService — encryption at rest, decryption, and fallback behaviour.
 *
 * Each `describe` block isolates its own database so tests never share state.
 *
 * Coverage:
 *  - Encryption disabled (plaintext legacy behaviour)
 *  - Encryption enabled: reveal stores encrypted blob, get decrypts it
 *  - Plaintext fallback: existing plaintext rows decrypted transparently
 *    when encryption is later enabled
 *  - Invalid key format rejected at construction time
 *  - Encrypted blob present but no key configured → descriptive error
 *  - Wrong key → decryption failure error
 *  - Preimage hash mismatch still rejected regardless of encryption mode
 *  - Unknown order still rejected
 *  - AES-256-GCM primitives unit-tested in isolation
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import pino from "pino";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService, OrderValidationError } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import {
  SecretRevealError,
  UnknownOrderError,
  InvalidPreimageError,
  RevealConflictError,
  SecretStorageError
} from "../src/services/secret-errors.js";
import {
  deriveKey,
  encryptSecret,
  decryptSecret,
  isEncryptedBlob
} from "../src/crypto/secret-cipher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = pino({ level: "silent" });

/** A valid 64-hex-char key (32 bytes). */
const VALID_KEY_HEX = "a".repeat(64);

/** A second valid key — used for wrong-key tests. */
const WRONG_KEY_HEX = "b".repeat(64);

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

/** Build a real sha256 hashlock from a raw 32-byte preimage buffer. */
function makeHashlock(preimageBytes: Buffer): string {
  return "0x" + createHash("sha256").update(preimageBytes).digest("hex");
}

/** Build a random 32-byte preimage and return both hex and hashlock. */
function makePreimage(): { preimage: string; hashlock: string } {
  const buf = randomBytes(32);
  return {
    preimage: "0x" + buf.toString("hex"),
    hashlock: makeHashlock(buf)
  };
}

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

/** Announce an order and advance it to src_locked so secrets can be recorded. */
async function seedOrder(
  orders: OrderService,
  hashlock: string
): Promise<string> {
  const order = await orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "100000000"
  });

  // Advance to src_locked (required by state machine before secret can be recorded).
  await orders.recordSrcLock({
    publicId: order.publicId,
    orderId: "1",
    txHash: "0xsrclock",
    blockNumber: 1,
    timelock: Math.floor(Date.now() / 1000) + 3600
  });

  return order.publicId;
}

// ---------------------------------------------------------------------------
// Unit tests for secret-cipher primitives
// ---------------------------------------------------------------------------

describe("secret-cipher: deriveKey", () => {
  it("accepts a 64-char hex string", () => {
    const key = deriveKey(VALID_KEY_HEX);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("accepts a 44-char base64 string", () => {
    const b64 = randomBytes(32).toString("base64");
    const key = deriveKey(b64);
    expect(key.length).toBe(32);
  });

  it("accepts a 44-char base64url string", () => {
    // Force base64url characters by using a known byte sequence
    const raw = Buffer.alloc(32, 0xfb); // produces base64url chars
    const b64url = raw.toString("base64url");
    const key = deriveKey(b64url);
    expect(key.length).toBe(32);
  });

  it("rejects a key that is too short", () => {
    expect(() => deriveKey("deadbeef")).toThrow(/32 bytes/);
  });

  it("rejects a key with invalid characters", () => {
    expect(() => deriveKey("z".repeat(64))).toThrow(/32 bytes/);
  });

  it("trims surrounding whitespace", () => {
    const key = deriveKey(`  ${VALID_KEY_HEX}  `);
    expect(key.length).toBe(32);
  });
});

describe("secret-cipher: encrypt / decrypt round-trip", () => {
  const key = deriveKey(VALID_KEY_HEX);

  it("round-trips a hex preimage", () => {
    const { preimage } = makePreimage();
    const blob = encryptSecret(preimage, key);
    expect(decryptSecret(blob, key)).toBe(preimage);
  });

  it("produces different blobs for the same plaintext (random IV)", () => {
    const { preimage } = makePreimage();
    const blob1 = encryptSecret(preimage, key);
    const blob2 = encryptSecret(preimage, key);
    expect(blob1).not.toBe(blob2); // different IV each time
  });

  it("throws on wrong key (auth tag mismatch)", () => {
    const { preimage } = makePreimage();
    const blob = encryptSecret(preimage, key);
    const wrongKey = deriveKey(WRONG_KEY_HEX);
    expect(() => decryptSecret(blob, wrongKey)).toThrow(/Decryption failed/);
  });

  it("throws on a truncated blob", () => {
    const { preimage } = makePreimage();
    const blob = encryptSecret(preimage, key);
    // Chop the blob roughly in half
    const truncated = blob.slice(0, Math.floor(blob.length / 2));
    expect(() => decryptSecret(truncated, key)).toThrow();
  });

  it("throws on tampered ciphertext", () => {
    const { preimage } = makePreimage();
    const blobBuf = Buffer.from(encryptSecret(preimage, key), "base64url");
    // Flip a byte in the ciphertext region (past version+IV+tag = 29 bytes)
    blobBuf[30] ^= 0xff;
    expect(() => decryptSecret(blobBuf.toString("base64url"), key)).toThrow(/Decryption failed/);
  });

  it("rejects a blob with unknown version byte", () => {
    const { preimage } = makePreimage();
    const blobBuf = Buffer.from(encryptSecret(preimage, key), "base64url");
    blobBuf[0] = 0xff; // unknown version
    expect(() => decryptSecret(blobBuf.toString("base64url"), key)).toThrow(
      /Unknown encryption version/
    );
  });
});

describe("secret-cipher: isEncryptedBlob", () => {
  it("returns false for 0x-prefixed hex (plaintext preimage)", () => {
    expect(isEncryptedBlob("0x" + "a".repeat(64))).toBe(false);
  });

  it("returns true for a base64url blob without 0x prefix", () => {
    const key = deriveKey(VALID_KEY_HEX);
    const blob = encryptSecret("0x" + "a".repeat(64), key);
    expect(isEncryptedBlob(blob)).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isEncryptedBlob("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SecretService integration tests (with real SQLite DB)
// ---------------------------------------------------------------------------

describe("SecretService: encryption DISABLED (plaintext mode)", () => {
  it("rejects construction with an invalid key", () => {
    expect(() => new SecretService({} as any, log, "tooshort")).toThrow(
      /invalid SECRET_STORAGE_KEY/
    );
  });

  it("stores and retrieves a preimage as plaintext", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log); // no key

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);

    await secrets.reveal(publicId, preimage, "0xtxhash");
    const result = await secrets.get(publicId);
    expect(result).toBe(preimage);
  });

  it("returns null for an order with no revealed preimage", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log);

    const { hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);
    expect(await secrets.get(publicId)).toBeNull();
  });

  it("rejects a preimage that does not match the hashlock", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log);

    const { hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);

    const wrongPreimage = "0x" + "c".repeat(64);
    await expect(secrets.reveal(publicId, wrongPreimage, "0xtxhash")).rejects.toThrow(
      /preimage does not match/
    );
  });

  it("rejects reveal for an unknown order", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log);

    await expect(secrets.reveal("nonexistent", "0x" + "a".repeat(64), "0xtx")).rejects.toThrow(
      /unknown order/
    );
  });
});

describe("SecretService: encryption ENABLED", () => {
  it("does NOT store plaintext in the database when a key is configured", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);
    const secrets = new SecretService(orders, log, VALID_KEY_HEX);

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);

    await secrets.reveal(publicId, preimage, "0xtxhash");

    // Read the raw DB row and check that the stored value is NOT the plaintext.
    const row = await repo.findByPublicId(publicId);
    expect(row).not.toBeNull();
    expect(row!.preimage).not.toBe(preimage);
    expect(row!.preimage).not.toMatch(/^0x/); // encrypted blob has no 0x prefix
    expect(row!.preimageEncVersion).toBe(1);
  });

  it("decrypts on get() and returns the original preimage", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log, VALID_KEY_HEX);

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);

    await secrets.reveal(publicId, preimage, "0xtxhash");
    const result = await secrets.get(publicId);
    expect(result).toBe(preimage);
  });

  it("accepts a base64 key format", async () => {
    const keyBuf = Buffer.from(VALID_KEY_HEX, "hex");
    const keyBase64 = keyBuf.toString("base64");

    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log, keyBase64);

    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);

    await secrets.reveal(publicId, preimage, "0xtxhash");
    expect(await secrets.get(publicId)).toBe(preimage);
  });

  it("still rejects a preimage that does not match the hashlock", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log, VALID_KEY_HEX);

    const { hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);
    const wrongPreimage = "0x" + "d".repeat(64);

    await expect(secrets.reveal(publicId, wrongPreimage, "0xtxhash")).rejects.toThrow(
      /preimage does not match/
    );
  });

  it("returns null for an order with no revealed preimage", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log, VALID_KEY_HEX);

    const { hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);
    expect(await secrets.get(publicId)).toBeNull();
  });
});

describe("SecretService: plaintext fallback (encryption enabled, legacy row)", () => {
  it("returns a plaintext row transparently when a key is configured", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log);

    // Write a plaintext row using a SecretService WITHOUT encryption.
    const plainSecrets = new SecretService(orders, log);
    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);
    await plainSecrets.reveal(publicId, preimage, "0xtxhash");

    // Now read back using a SecretService WITH encryption enabled.
    const encSecrets = new SecretService(orders, log, VALID_KEY_HEX);
    const result = await encSecrets.get(publicId);
    expect(result).toBe(preimage);
  });
});

describe("SecretService: missing key with encrypted blob", () => {
  it("throws a descriptive error when an encrypted blob exists but no key is set", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    // Write an encrypted row.
    const encSecrets = new SecretService(orders, log, VALID_KEY_HEX);
    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);
    await encSecrets.reveal(publicId, preimage, "0xtxhash");

    // Now try to read it without a key.
    const plainSecrets = new SecretService(orders, log);
    await expect(plainSecrets.get(publicId)).rejects.toThrow(/SECRET_STORAGE_KEY/);
  });
});

describe("SecretService: wrong decryption key", () => {
  it("throws when a different key is used for decryption", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    // Write with correct key.
    const encSecrets = new SecretService(orders, log, VALID_KEY_HEX);
    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);
    await encSecrets.reveal(publicId, preimage, "0xtxhash");

    // Read with a different key.
    const wrongSecrets = new SecretService(orders, log, WRONG_KEY_HEX);
    await expect(wrongSecrets.get(publicId)).rejects.toThrow(/decrypt/i);
  });
});

describe("SecretService: restart persistence (simulated coordinator restart)", () => {
  it("survives a coordinator restart — preimage is re-decrypted from DB", async () => {
    const db = await freshDb();
    const repo = new OrdersRepository(db);

    // First coordinator instance: reveal the secret.
    const orders1 = new OrderService(repo, log);
    const secrets1 = new SecretService(orders1, log, VALID_KEY_HEX);
    const { preimage, hashlock } = makePreimage();
    const publicId = await seedOrder(orders1, hashlock);
    await secrets1.reveal(publicId, preimage, "0xtxhash");

    // Simulated restart: new service instances share the same DB.
    const orders2 = new OrderService(repo, log);
    const secrets2 = new SecretService(orders2, log, VALID_KEY_HEX);
    const result = await secrets2.get(publicId);
    expect(result).toBe(preimage);
  });
});

describe("SecretService: keccak256 hashlock compatibility", () => {
  it("accepts a preimage whose keccak256 matches the hashlock", async () => {
    const { keccak256, toHex } = await import("viem");

    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log, VALID_KEY_HEX);

    const preimageBytes = randomBytes(32);
    const preimage = "0x" + preimageBytes.toString("hex");
    const hashlock = keccak256(toHex(preimageBytes)) as `0x${string}`;

    const publicId = await seedOrder(orders, hashlock);
    await expect(secrets.reveal(publicId, preimage, "0xtxhash")).resolves.toEqual({ ok: true });
    expect(await secrets.get(publicId)).toBe(preimage);
  });
});

// ---------------------------------------------------------------------------
// Failure classification — each reveal failure maps to a distinct typed error
// ---------------------------------------------------------------------------

describe("SecretService: reveal failure classification", () => {
  it("throws UnknownOrderError for an order that does not exist", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log);

    const err = await secrets
      .reveal("nonexistent", "0x" + "a".repeat(64), "0xtx")
      .catch((e) => e);

    expect(err).toBeInstanceOf(UnknownOrderError);
    expect(err).toBeInstanceOf(SecretRevealError);
    expect(err.code).toBe("unknown_order");
    expect(err.httpStatus).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it("throws InvalidPreimageError when the preimage does not match the hashlock", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);
    const secrets = new SecretService(orders, log);

    const { hashlock } = makePreimage();
    const publicId = await seedOrder(orders, hashlock);
    const wrongPreimage = "0x" + "c".repeat(64);

    const err = await secrets.reveal(publicId, wrongPreimage, "0xtx").catch((e) => e);

    expect(err).toBeInstanceOf(InvalidPreimageError);
    expect(err.code).toBe("invalid_preimage");
    expect(err.httpStatus).toBe(400);
    expect(err.retryable).toBe(false);
    // SECURITY: the rejected preimage must never appear in the error message.
    expect(err.message).not.toContain(wrongPreimage);
    expect(err.message).not.toContain("c".repeat(64));
  });

  it("throws RevealConflictError when the order cannot accept a reveal (stale/replayed)", async () => {
    // Stub OrderService so recordSecret rejects with a state-transition error,
    // mirroring a reveal that arrives after the order moved to a terminal state.
    const { preimage, hashlock } = makePreimage();
    const stubOrders = {
      get: async () => ({ hashlock }),
      recordSecret: async () => {
        throw new OrderValidationError("cannot record secret from status refunded");
      }
    } as unknown as OrderService;
    const secrets = new SecretService(stubOrders, log);

    const err = await secrets.reveal("order-1", preimage, "0xtx").catch((e) => e);

    expect(err).toBeInstanceOf(RevealConflictError);
    expect(err.code).toBe("reveal_conflict");
    expect(err.httpStatus).toBe(409);
    expect(err.retryable).toBe(false);
  });

  it("throws UnknownOrderError when recordSecret races and reports an unknown order", async () => {
    const { preimage, hashlock } = makePreimage();
    const stubOrders = {
      get: async () => ({ hashlock }),
      recordSecret: async () => {
        throw new OrderValidationError("unknown order order-1");
      }
    } as unknown as OrderService;
    const secrets = new SecretService(stubOrders, log);

    const err = await secrets.reveal("order-1", preimage, "0xtx").catch((e) => e);

    expect(err).toBeInstanceOf(UnknownOrderError);
    expect(err.code).toBe("unknown_order");
  });

  it("throws a retryable SecretStorageError on an unexpected persistence failure", async () => {
    const { preimage, hashlock } = makePreimage();
    const stubOrders = {
      get: async () => ({ hashlock }),
      recordSecret: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      }
    } as unknown as OrderService;
    const secrets = new SecretService(stubOrders, log);

    const err = await secrets.reveal("order-1", preimage, "0xtx").catch((e) => e);

    expect(err).toBeInstanceOf(SecretStorageError);
    expect(err.code).toBe("storage_failure");
    expect(err.httpStatus).toBe(500);
    expect(err.retryable).toBe(true);
    // The raw DB error string must not leak into the client-facing message.
    expect(err.message).not.toContain("SQLITE_BUSY");
  });
});
