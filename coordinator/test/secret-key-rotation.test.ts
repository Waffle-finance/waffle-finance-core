/**
 * Versioned key identifiers and rotation behaviour for stored coordinator secrets.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import type { OrderService } from "../src/services/order-service.js";
import {
  deriveKey,
  encryptSecret,
  decryptSecret,
  readKeyId
} from "../src/crypto/secret-cipher.js";
import { SecretService } from "../src/services/secret-service.js";

const log = pino({ level: "silent" });
const OLD_KEY = "a".repeat(64);
const NEW_KEY = "b".repeat(64);
const PREIMAGE = "0x" + "ab".repeat(32);

function mockOrders(stored?: string) {
  let value = stored;
  return {
    value: () => value,
    set: (next: string) => { value = next; },
    service: {
      get: vi.fn(async () => (value ? { preimage: value } : null)),
      recordSecret: vi.fn(async (_id: string, next: string) => { value = next; })
    } as unknown as OrderService
  };
}

describe("versioned ciphertext for key rotation", () => {
  it("adds a key id to new blobs while retaining legacy decode", () => {
    const key = deriveKey(OLD_KEY);
    const legacy = encryptSecret(PREIMAGE, key);
    const versioned = encryptSecret(PREIMAGE, key, "k-2026-01");

    expect(readKeyId(legacy)).toBeUndefined();
    expect(readKeyId(versioned)).toBe("k-2026-01");
    expect(decryptSecret(legacy, key)).toBe(PREIMAGE);
    expect(decryptSecret(versioned, key)).toBe(PREIMAGE);
    expect(() => decryptSecret(versioned, deriveKey(NEW_KEY))).toThrow("Decryption failed");
  });

  it("rejects an over-long key identifier", () => {
    expect(() => encryptSecret(PREIMAGE, deriveKey(OLD_KEY), "k".repeat(65))).toThrow(
      /at most 64 bytes/
    );
  });

  it("keeps old-key records readable while the new key writes versioned blobs", async () => {
    const legacyBlob = encryptSecret(PREIMAGE, deriveKey(OLD_KEY));
    const orders = mockOrders(legacyBlob);
    // Rotation in progress: both keys remain in the ring; new keys get an id.
    const rotating = new SecretService(orders.service, log, {
      current: NEW_KEY,
      previous: OLD_KEY,
      currentKeyId: "k-2026-01"
    });
    expect(await rotating.get("order-1")).toBe(PREIMAGE);
    // Reading with a legacy key triggers opportunistic re-encryption.
    expect(readKeyId(orders.value()!)).toBe("k-2026-01");
  });

  it("supports rollback to the old key and old-key retirement", async () => {
    const legacyBlob = encryptSecret(PREIMAGE, deriveKey(OLD_KEY));
    const oldOnly = new SecretService(mockOrders(legacyBlob).service, log, OLD_KEY);
    expect(await oldOnly.get("order-1")).toBe(PREIMAGE);

    const finalBlob = encryptSecret(PREIMAGE, deriveKey(NEW_KEY), "k-2026-01");
    const newOnly = new SecretService(mockOrders(finalBlob).service, log, {
      current: NEW_KEY,
      currentKeyId: "k-2026-01"
    });
    expect(await newOnly.get("order-1")).toBe(PREIMAGE);
    expect(readKeyId(finalBlob)).toBe("k-2026-01");
  });
});
