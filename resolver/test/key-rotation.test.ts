import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { generatePrivateKey } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ResolverKeyRing,
  KeyRevokedError,
  NoActiveKeyError,
  KeyRotationError,
  buildKeyRings,
  createEvmSigner,
  createStellarSigner,
  deriveKeyId,
  type ResolverSigner,
} from "../src/key-rotation.js";
import { registry } from "../src/metrics.js";

/** Mocked signer: records which key produced each signature. */
function mockSigner(name: string, chain = "ethereum"): ResolverSigner & { signed: string[] } {
  const signed: string[] = [];
  const address = `0x${name.padEnd(40, "0")}`;
  return {
    keyId: deriveKeyId(chain, address),
    address,
    signed,
    async sign(payload) {
      signed.push(String(payload));
      return `${name}:${String(payload)}`;
    },
  };
}

/** Logger that captures every line so tests can assert on what was (not) logged. */
function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { log: pino({ level: "debug" }, stream), lines };
}

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  registry.resetMetrics();
});

describe("ResolverKeyRing — selection by order lifecycle phase", () => {
  it("binds new orders to the active key and keeps that key for later phases", async () => {
    const oldKey = mockSigner("old");
    const newKey = mockSigner("new");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: oldKey, log: pino({ level: "silent" }), now });

    // Order A accepted before rotation.
    expect(ring.signerForOrder("A", "accept").keyId).toBe(oldKey.keyId);

    ring.rotate(newKey, 60_000);

    // Order B accepted after rotation uses the new key.
    expect(ring.signerForOrder("B", "accept").keyId).toBe(newKey.keyId);

    // A's later phases still use the old key — rotation does not interrupt it.
    for (const phase of ["fund", "claim", "refund"] as const) {
      await ring.signerForOrder("A", phase).sign(`A:${phase}`);
    }
    await ring.signerForOrder("B", "claim").sign("B:claim");

    expect(oldKey.signed).toEqual(["A:fund", "A:claim", "A:refund"]);
    expect(newKey.signed).toEqual(["B:claim"]);
  });

  it("re-delivered accept for a bound order keeps the original key", () => {
    const oldKey = mockSigner("old");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: oldKey, log: pino({ level: "silent" }), now });
    ring.signerForNewOrder("A");
    ring.rotate(mockSigner("new"));
    expect(ring.signerForOrder("A", "accept").keyId).toBe(oldKey.keyId);
    expect(ring.signerForNewOrder("A").keyId).toBe(oldKey.keyId);
  });

  it("binds an unknown order to the active key on first use (e.g. after restart)", () => {
    const k = mockSigner("k");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: k, log: pino({ level: "silent" }), now });
    expect(ring.signerForOrder("X", "claim").keyId).toBe(k.keyId);
    expect(ring.keyFor("X")).toBe(k.keyId);
  });
});

describe("ResolverKeyRing — overlap window", () => {
  it("retires the old key only after the window elapses and its orders settle", () => {
    const oldKey = mockSigner("old");
    const newKey = mockSigner("new");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: oldKey, log: pino({ level: "silent" }), now });
    ring.signerForNewOrder("A");
    ring.rotate(newKey, 10_000);

    // Inside the window: nothing retires.
    clock += 5_000;
    expect(ring.sweep()).toEqual([]);

    // Window elapsed but A is still in flight: key is kept.
    clock += 10_000;
    expect(ring.sweep()).toEqual([]);
    expect(ring.signerForOrder("A", "refund").keyId).toBe(oldKey.keyId);

    // A settles: the old key is retired.
    ring.releaseOrder("A");
    expect(ring.snapshot().keys.map((k) => k.keyId)).toEqual([newKey.keyId]);
    expect(ring.snapshot().rotationInProgress).toBe(false);
  });

  it("an old key with no orders is retired as soon as the window elapses", () => {
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: mockSigner("old"), log: pino({ level: "silent" }), now });
    const oldId = ring.activeKey!;
    ring.rotate(mockSigner("new"), 1_000);
    clock += 1_000;
    expect(ring.sweep()).toEqual([oldId]);
  });

  it("rejects rotating to the already-active key or a negative window", () => {
    const k = mockSigner("k");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: k, log: pino({ level: "silent" }), now });
    expect(() => ring.rotate(k)).toThrow(KeyRotationError);
    expect(() => ring.rotate(mockSigner("n"), -1)).toThrow(KeyRotationError);
  });
});

describe("ResolverKeyRing — rollback and revocation", () => {
  it("rollback restores the old key for new work; orders on the new key keep it", () => {
    const oldKey = mockSigner("old");
    const newKey = mockSigner("new");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: oldKey, log: pino({ level: "silent" }), now });
    ring.rotate(newKey);
    ring.signerForNewOrder("B"); // bound to new key
    ring.rollback();

    expect(ring.activeKey).toBe(oldKey.keyId);
    expect(ring.signerForNewOrder("C").keyId).toBe(oldKey.keyId);
    expect(ring.signerForOrder("B", "claim").keyId).toBe(newKey.keyId);
    expect(ring.snapshot().keys.find((k) => k.keyId === newKey.keyId)?.status).toBe("retiring");
  });

  it("rollback without a rotation in progress is an error", () => {
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: mockSigner("k"), log: pino({ level: "silent" }), now });
    expect(() => ring.rollback()).toThrow(KeyRotationError);
  });

  it("revocation stops the key immediately and reports affected orders", () => {
    const oldKey = mockSigner("old");
    const newKey = mockSigner("new");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: oldKey, log: pino({ level: "silent" }), now });
    ring.signerForNewOrder("A");
    ring.rotate(newKey);

    expect(ring.revoke(oldKey.keyId, "suspected compromise")).toEqual(["A"]);
    expect(() => ring.signerForOrder("A", "claim")).toThrow(KeyRevokedError);
    // New work is unaffected.
    expect(ring.signerForNewOrder("B").keyId).toBe(newKey.keyId);
    // A revoked key can never be rotated back in.
    expect(() => ring.rotate(oldKey)).toThrow(KeyRotationError);
  });

  it("revoking the only active key refuses new work", () => {
    const k = mockSigner("k");
    const ring = new ResolverKeyRing({ chain: "ethereum", initial: k, log: pino({ level: "silent" }), now });
    ring.revoke(k.keyId, "emergency");
    expect(ring.activeKey).toBeNull();
    expect(() => ring.signerForNewOrder("A")).toThrow(NoActiveKeyError);
  });
});

describe("key material never leaks", () => {
  it("snapshots, logs and metrics expose key ids only", async () => {
    const pk = generatePrivateKey();
    const nextPk = generatePrivateKey();
    const secret = Keypair.random().secret();
    const { log, lines } = capturingLogger();

    const rings = buildKeyRings(
      { ethereumPrivateKey: pk, stellarSecret: secret },
      { RESOLVER_ETH_PRIVATE_KEY_NEXT: nextPk, RESOLVER_KEY_OVERLAP_MS: "5000" },
      log,
      now
    );
    const eth = rings.get("ethereum")!;
    eth.signerForNewOrder("A");
    eth.revoke(eth.snapshot().keys[0]!.keyId, "test");

    const surfaces = [
      JSON.stringify([...rings.values()].map((r) => r.snapshot())),
      JSON.stringify([...rings.values()]),
      lines.join("\n"),
      await registry.metrics(),
    ].join("\n");

    for (const material of [pk, pk.slice(2), nextPk, nextPk.slice(2), secret]) {
      expect(surfaces).not.toContain(material);
    }
    expect(surfaces).toContain(eth.activeKey!);
  });

  it("buildKeyRings starts mid-rotation when a NEXT key is supplied", () => {
    const pk = generatePrivateKey();
    const nextPk = generatePrivateKey();
    const rings = buildKeyRings(
      { ethereumPrivateKey: pk, stellarSecret: null },
      { RESOLVER_ETH_PRIVATE_KEY_NEXT: nextPk },
      pino({ level: "silent" }),
      now
    );
    const snap = rings.get("ethereum")!.snapshot();
    expect(rings.has("soroban")).toBe(false);
    expect(snap.activeKeyId).toBe(createEvmSigner(nextPk).keyId);
    expect(snap.keys.map((k) => k.status)).toEqual(["retiring", "active"]);
  });

  it("rejects an invalid overlap window", () => {
    expect(() =>
      buildKeyRings(
        { ethereumPrivateKey: generatePrivateKey(), stellarSecret: null },
        { RESOLVER_KEY_OVERLAP_MS: "-5" },
        pino({ level: "silent" })
      )
    ).toThrow(KeyRotationError);
  });

  it("real signer backends produce signatures and stable ids", async () => {
    const evm = createEvmSigner(generatePrivateKey());
    const stellarKp = Keypair.random();
    const stellar = createStellarSigner(stellarKp.secret());
    expect(evm.keyId).toMatch(/^ethereum:[0-9a-f]{12}$/);
    expect(stellar.keyId).toMatch(/^soroban:[0-9a-f]{12}$/);
    expect(stellar.address).toBe(stellarKp.publicKey());
    expect(await evm.sign("hello")).toMatch(/^0x[0-9a-f]+$/);
    const sig = await stellar.sign("hello");
    expect(stellarKp.verify(Buffer.from("hello"), Buffer.from(sig, "base64"))).toBe(true);
  });
});
