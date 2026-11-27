/**
 * @file key-rotation.ts
 *
 * Staged resolver signing-key rotation with an overlap window (issue #1091).
 *
 * The resolver used to hold exactly one signing key per chain, so replacing it
 * meant stopping the process — and any order that was half-way through its
 * lifecycle had to be finished by hand.  A `ResolverKeyRing` holds the keys
 * for ONE chain and makes ownership of work explicit:
 *
 *   - **New work** (`phase: "accept"`) always binds to the current *active*
 *     key.  The binding is recorded per order.
 *   - **Existing orders** keep using the key they were accepted with for every
 *     later phase (fund / claim / refund), even after a rotation, because the
 *     on-chain order references that resolver address.
 *   - **Overlap window.**  `rotate()` makes the replacement key active and moves
 *     the old key to *retiring*.  A retiring key is never handed out for new
 *     work but keeps serving the orders bound to it.  It is retired (dropped)
 *     only once the overlap window has elapsed AND no order is bound to it —
 *     an expired window never strands an in-flight order.
 *   - **Rollback.**  `rollback()` swaps the roles back while the old key is
 *     still retiring; orders already bound to the replacement keep it.
 *   - **Emergency revocation.**  `revoke()` makes a key unusable immediately.
 *     Orders bound to it fail loudly with `KeyRevokedError` and are listed by
 *     `ordersBoundTo()` for manual reconciliation; nothing is silently
 *     re-signed with a different key.
 *
 * Secrecy: the ring never stores raw key material.  Signers are built from a
 * secret by `createEvmSigner` / `createStellarSigner`, which keep it only in a
 * closure.  Everything the ring logs or exposes (snapshots, health, metrics)
 * uses the derived `keyId` — a chain prefix plus a short SHA-256 fingerprint of
 * the PUBLIC address.
 */

import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { keyRotationEventsTotal, signingKeys } from "./metrics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Lifecycle phase of an order a signature is requested for. */
export type OrderPhase = "accept" | "fund" | "claim" | "refund";

export type KeyStatus = "active" | "retiring" | "revoked";

/**
 * A signing backend.  Only public data is exposed; the secret lives inside
 * the `sign` closure.
 */
export interface ResolverSigner {
  /** Stable, non-secret identifier (see `deriveKeyId`). */
  readonly keyId: string;
  /** Public address / account id the key controls. */
  readonly address: string;
  sign(payload: string | Uint8Array): Promise<string>;
}

export interface KeyInfo {
  keyId: string;
  address: string;
  status: KeyStatus;
  /** Epoch ms the key became active (null if it was never active). */
  activatedAt: number | null;
  /** Epoch ms after which a retiring key may be retired (null otherwise). */
  retireAfter: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
  boundOrders: number;
}

export interface KeyRingSnapshot {
  chain: string;
  activeKeyId: string | null;
  rotationInProgress: boolean;
  keys: KeyInfo[];
}

export interface ResolverKeyRingOptions {
  chain: string;
  initial: ResolverSigner;
  log: Logger;
  /** Default overlap window for `rotate()`.  Defaults to `DEFAULT_KEY_OVERLAP_MS`. */
  overlapMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** 24h: long enough for any order's timelock to elapse and be refunded. */
export const DEFAULT_KEY_OVERLAP_MS = 24 * 60 * 60 * 1000;

export class KeyRevokedError extends Error {
  constructor(readonly keyId: string, readonly orderId: string) {
    super(`signing key ${keyId} bound to order ${orderId} has been revoked — manual reconciliation required`);
    this.name = "KeyRevokedError";
  }
}

export class NoActiveKeyError extends Error {
  constructor(readonly chain: string) {
    super(`no active signing key for ${chain} — refusing new work`);
    this.name = "NoActiveKeyError";
  }
}

export class KeyRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyRotationError";
  }
}

// ── Key identifiers and signer factories ─────────────────────────────────────

/**
 * Derive a non-secret key identifier from a chain name and a PUBLIC address.
 * Never pass secret material here.
 */
export function deriveKeyId(chain: string, publicAddress: string): string {
  const fp = createHash("sha256").update(publicAddress.toLowerCase()).digest("hex").slice(0, 12);
  return `${chain}:${fp}`;
}

/** Build a signer from an EVM private key.  The key is captured only in closures. */
export function createEvmSigner(privateKey: `0x${string}`, chain = "ethereum"): ResolverSigner {
  const account = privateKeyToAccount(privateKey);
  const keyId = deriveKeyId(chain, account.address);
  return Object.freeze({
    keyId,
    address: account.address,
    sign: (payload: string | Uint8Array) =>
      account.signMessage({ message: typeof payload === "string" ? payload : { raw: payload } }),
  });
}

/** Build a signer from a Stellar secret seed.  The seed is captured only in closures. */
export function createStellarSigner(secret: string, chain = "soroban"): ResolverSigner {
  const keypair = Keypair.fromSecret(secret);
  const address = keypair.publicKey();
  const keyId = deriveKeyId(chain, address);
  return Object.freeze({
    keyId,
    address,
    sign: async (payload: string | Uint8Array) => {
      const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
      return keypair.sign(bytes).toString("base64");
    },
  });
}

// ── Key ring ──────────────────────────────────────────────────────────────────

interface KeyEntry {
  signer: ResolverSigner;
  status: KeyStatus;
  activatedAt: number | null;
  retireAfter: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
}

export class ResolverKeyRing {
  readonly chain: string;
  private readonly log: Logger;
  private readonly overlapMs: number;
  private readonly now: () => number;
  /** Insertion-ordered: oldest first. */
  private readonly keys = new Map<string, KeyEntry>();
  /** orderId -> keyId the order was accepted with. */
  private readonly bindings = new Map<string, string>();
  private activeKeyId: string | null;

  constructor(opts: ResolverKeyRingOptions) {
    this.chain = opts.chain;
    this.log = opts.log.child({ component: "ResolverKeyRing", chain: opts.chain });
    this.overlapMs = opts.overlapMs ?? DEFAULT_KEY_OVERLAP_MS;
    this.now = opts.now ?? Date.now;
    this.keys.set(opts.initial.keyId, {
      signer: opts.initial,
      status: "active",
      activatedAt: this.now(),
      retireAfter: null,
      revokedAt: null,
      revokeReason: null,
    });
    this.activeKeyId = opts.initial.keyId;
    this.publishMetrics();
    this.log.info({ keyId: opts.initial.keyId }, "signing key loaded");
  }

  get activeKey(): string | null {
    return this.activeKeyId;
  }

  /**
   * Begin a staged rotation: `next` becomes active for new work, the current
   * active key becomes retiring and keeps serving its bound orders for at
   * least `overlapMs`.
   */
  rotate(next: ResolverSigner, overlapMs: number = this.overlapMs): void {
    if (overlapMs < 0 || !Number.isFinite(overlapMs)) {
      throw new KeyRotationError(`overlap window must be a non-negative finite number, got ${overlapMs}`);
    }
    const existing = this.keys.get(next.keyId);
    if (existing?.status === "revoked") {
      throw new KeyRotationError(`cannot rotate to revoked key ${next.keyId}`);
    }
    if (next.keyId === this.activeKeyId) {
      throw new KeyRotationError(`key ${next.keyId} is already active`);
    }

    const now = this.now();
    const previousId = this.activeKeyId;
    if (previousId) {
      const prev = this.keys.get(previousId)!;
      prev.status = "retiring";
      prev.retireAfter = now + overlapMs;
    }
    this.keys.set(next.keyId, {
      signer: next,
      status: "active",
      activatedAt: now,
      retireAfter: null,
      revokedAt: null,
      revokeReason: null,
    });
    this.activeKeyId = next.keyId;

    keyRotationEventsTotal.inc({ chain: this.chain, action: "rotate" });
    this.publishMetrics();
    this.log.info(
      {
        previousKeyId: previousId,
        newKeyId: next.keyId,
        overlapMs,
        ordersOnPreviousKey: previousId ? this.ordersBoundTo(previousId).length : 0,
      },
      "signing key rotation started — new orders use the new key, existing orders keep theirs"
    );
  }

  /**
   * Undo the most recent rotation while the previous key is still retiring.
   * The previous key becomes active again; the replacement becomes retiring so
   * orders already bound to it can still finish.
   */
  rollback(overlapMs: number = this.overlapMs): void {
    const retiring = [...this.keys.entries()].filter(([, e]) => e.status === "retiring");
    const target = retiring[retiring.length - 1];
    if (!target) {
      throw new KeyRotationError("no retiring key to roll back to");
    }
    const [targetId, targetEntry] = target;
    const now = this.now();
    const replacedId = this.activeKeyId;
    if (replacedId) {
      const replaced = this.keys.get(replacedId)!;
      replaced.status = "retiring";
      replaced.retireAfter = now + overlapMs;
    }
    targetEntry.status = "active";
    targetEntry.retireAfter = null;
    targetEntry.activatedAt = now;
    this.activeKeyId = targetId;

    keyRotationEventsTotal.inc({ chain: this.chain, action: "rollback" });
    this.publishMetrics();
    this.log.warn(
      { restoredKeyId: targetId, replacedKeyId: replacedId },
      "signing key rotation rolled back"
    );
  }

  /**
   * Emergency revocation: the key stops signing immediately.  Orders bound to
   * it are NOT moved to another key (the on-chain order names the original
   * resolver address); they are reported so an operator can reconcile them.
   */
  revoke(keyId: string, reason: string): string[] {
    const entry = this.keys.get(keyId);
    if (!entry) throw new KeyRotationError(`unknown key ${keyId}`);
    if (entry.status === "revoked") return this.ordersBoundTo(keyId);

    entry.status = "revoked";
    entry.revokedAt = this.now();
    entry.revokeReason = reason;
    entry.retireAfter = null;
    if (this.activeKeyId === keyId) this.activeKeyId = null;

    const affected = this.ordersBoundTo(keyId);
    keyRotationEventsTotal.inc({ chain: this.chain, action: "revoke" });
    this.publishMetrics();
    this.log.error(
      { keyId, reason, affectedOrders: affected.length, activeKeyId: this.activeKeyId },
      this.activeKeyId
        ? "signing key revoked"
        : "signing key revoked — no active key remains, new work is refused until a replacement is rotated in"
    );
    return affected;
  }

  /** Signer for a brand-new order; records the binding. */
  signerForNewOrder(orderId: string): ResolverSigner {
    const existing = this.bindings.get(orderId);
    if (existing) return this.signerForOrder(orderId, "fund");
    if (!this.activeKeyId) throw new NoActiveKeyError(this.chain);
    this.bindings.set(orderId, this.activeKeyId);
    this.publishMetrics();
    return this.keys.get(this.activeKeyId)!.signer;
  }

  /**
   * Signer for an order at a given lifecycle phase.  `accept` binds new work
   * to the active key; every later phase uses the order's bound key.  An order
   * observed without a binding (e.g. accepted before a restart) is bound to
   * the active key on first use.
   */
  signerForOrder(orderId: string, phase: OrderPhase): ResolverSigner {
    const boundId = this.bindings.get(orderId);
    if (!boundId) {
      if (phase !== "accept") {
        this.log.warn({ orderId, phase }, "order has no key binding — binding to the active key");
      }
      return this.signerForNewOrder(orderId);
    }
    // A re-delivered accept for an already-bound order keeps its binding.
    const entry = this.keys.get(boundId);
    if (!entry || entry.status === "revoked") {
      throw new KeyRevokedError(boundId, orderId);
    }
    return entry.signer;
  }

  /** The key an order is bound to, if any. */
  keyFor(orderId: string): string | undefined {
    return this.bindings.get(orderId);
  }

  /** Release an order once it has settled (claimed or refunded). */
  releaseOrder(orderId: string): void {
    if (this.bindings.delete(orderId)) {
      this.sweep();
      this.publishMetrics();
    }
  }

  ordersBoundTo(keyId: string): string[] {
    const out: string[] = [];
    for (const [orderId, k] of this.bindings) if (k === keyId) out.push(orderId);
    return out;
  }

  /**
   * Retire retiring keys whose overlap window has elapsed and that no longer
   * serve any order.  A key whose window has elapsed but still has bound
   * orders is kept (and logged) — rotation must never interrupt in-flight work.
   * Returns the ids of keys retired by this call.
   */
  sweep(): string[] {
    const now = this.now();
    const retired: string[] = [];
    for (const [keyId, entry] of this.keys) {
      if (entry.status !== "retiring" || entry.retireAfter === null || now < entry.retireAfter) continue;
      const bound = this.ordersBoundTo(keyId).length;
      if (bound > 0) {
        this.log.warn(
          { keyId, boundOrders: bound },
          "overlap window elapsed but in-flight orders still use this key — keeping it until they settle"
        );
        continue;
      }
      this.keys.delete(keyId);
      retired.push(keyId);
      keyRotationEventsTotal.inc({ chain: this.chain, action: "retire" });
      this.log.info({ keyId }, "retiring signing key retired");
    }
    if (retired.length > 0) this.publishMetrics();
    return retired;
  }

  snapshot(): KeyRingSnapshot {
    const keys: KeyInfo[] = [...this.keys.entries()].map(([keyId, e]) => ({
      keyId,
      address: e.signer.address,
      status: e.status,
      activatedAt: e.activatedAt,
      retireAfter: e.retireAfter,
      revokedAt: e.revokedAt,
      revokeReason: e.revokeReason,
      boundOrders: this.ordersBoundTo(keyId).length,
    }));
    return {
      chain: this.chain,
      activeKeyId: this.activeKeyId,
      rotationInProgress: keys.some((k) => k.status === "retiring"),
      keys,
    };
  }

  private publishMetrics(): void {
    const counts: Record<KeyStatus, number> = { active: 0, retiring: 0, revoked: 0 };
    for (const e of this.keys.values()) counts[e.status]++;
    for (const state of Object.keys(counts) as KeyStatus[]) {
      signingKeys.set({ chain: this.chain, state }, counts[state]);
    }
  }
}

// ── Environment loading ──────────────────────────────────────────────────────

export interface KeyRingEnvInput {
  ethereumPrivateKey: `0x${string}` | null;
  stellarSecret: string | null;
}

/**
 * Build key rings for every chain that has a signing key.  When the matching
 * `*_NEXT` variable is set, the ring starts mid-rotation: the NEXT key is
 * active for new orders and the current key keeps serving existing ones for
 * `RESOLVER_KEY_OVERLAP_MS` (default 24h).
 *
 *   RESOLVER_ETH_PRIVATE_KEY_NEXT   replacement EVM key
 *   RESOLVER_STELLAR_SECRET_NEXT    replacement Stellar secret
 *   RESOLVER_KEY_OVERLAP_MS         overlap window in ms
 */
export function buildKeyRings(
  keys: KeyRingEnvInput,
  env: NodeJS.ProcessEnv,
  log: Logger,
  now: () => number = Date.now
): Map<string, ResolverKeyRing> {
  const rings = new Map<string, ResolverKeyRing>();
  const overlapRaw = env.RESOLVER_KEY_OVERLAP_MS;
  const overlapMs = overlapRaw !== undefined && overlapRaw !== "" ? Number(overlapRaw) : DEFAULT_KEY_OVERLAP_MS;
  if (!Number.isFinite(overlapMs) || overlapMs < 0) {
    throw new KeyRotationError("RESOLVER_KEY_OVERLAP_MS must be a non-negative number of milliseconds");
  }

  if (keys.ethereumPrivateKey) {
    const ring = new ResolverKeyRing({
      chain: "ethereum",
      initial: createEvmSigner(keys.ethereumPrivateKey),
      log,
      overlapMs,
      now,
    });
    const next = env.RESOLVER_ETH_PRIVATE_KEY_NEXT;
    if (next) ring.rotate(createEvmSigner(next as `0x${string}`));
    rings.set("ethereum", ring);
  }

  if (keys.stellarSecret) {
    const ring = new ResolverKeyRing({
      chain: "soroban",
      initial: createStellarSigner(keys.stellarSecret),
      log,
      overlapMs,
      now,
    });
    const next = env.RESOLVER_STELLAR_SECRET_NEXT;
    if (next) ring.rotate(createStellarSigner(next));
    rings.set("soroban", ring);
  }

  return rings;
}
