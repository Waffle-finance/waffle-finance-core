import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSecret, hashSecret, verifyPreimage } from "@wafflefinance/sdk/secrets";
import { EvmHtlcSim, SorobanHtlcSim, SolanaHtlcSim, type HtlcSim } from "./sim.js";

const TIMELOCK_SECONDS = 600;
const PAST_TIMELOCK = TIMELOCK_SECONDS + 1;

/**
 * The 12-hour / 24-hour asymmetric timelock convention used by the
 * sol_to_eth route:
 *   - Solana (source leg): 24-hour lock gives the resolver enough time to
 *     set up the destination lock and claim.
 *   - Ethereum (destination leg): 12-hour lock must expire BEFORE the source
 *     leg so the resolver can refund on Ethereum first if needed, then refund
 *     on Solana later.  If this ordering is reversed funds can get stuck.
 */
const SOL_SRC_TIMELOCK_SECONDS  = 24 * 60 * 60; // 24 h
const ETH_DST_TIMELOCK_SECONDS  = 12 * 60 * 60; // 12 h

// Independent oracle: Node's built-in crypto module. If the SDK's sha256
// agrees with this, it also agrees with every other standards-compliant
// sha256 implementation — Solidity's `sha256(...)` precompile, the Solana
// program's `sha2` crate, and Soroban's `env.crypto().sha256(...)` included.
function canonicalSha256(hex: `0x${string}`): `0x${string}` {
  const buf = Buffer.from(hex.slice(2), "hex");
  return `0x${createHash("sha256").update(buf).digest("hex")}` as `0x${string}`;
}

describe("cross-chain HTLC differential harness", () => {
  describe("hash primitive parity", () => {
    it("SDK hashSecret().sha256 matches Node's canonical sha256", () => {
      const s = generateSecret();
      expect(canonicalSha256(s.preimage)).toBe(s.sha256);
    });

    it("hashSecret is deterministic for a given preimage", () => {
      const s = generateSecret();
      expect(hashSecret(s.preimage).sha256).toBe(s.sha256);
      expect(hashSecret(s.preimage).keccak256).toBe(s.keccak256);
    });
  });

  // Shared per-chain scenarios. Driving all three simulators through the same
  // assertions is the actual differential check — if any chain diverges, the
  // corresponding case fails for that chain only.
  describe.each<{ label: string; factory: () => HtlcSim }>([
    { label: "EVM HTLCEscrow",            factory: () => new EvmHtlcSim()     },
    { label: "Soroban wafflefinance-htlc", factory: () => new SorobanHtlcSim() },
    { label: "Solana wafflefinance-htlc",  factory: () => new SolanaHtlcSim()  },
  ])("$label", ({ factory }) => {
    let chain: HtlcSim;
    let secret: ReturnType<typeof generateSecret>;
    let orderId: bigint;

    beforeEach(() => {
      chain = factory();
      secret = generateSecret();
      orderId = chain.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: TIMELOCK_SECONDS
      });
    });

    it("accepts the valid preimage and marks the order Claimed", () => {
      expect(() => chain.claimOrder(orderId, secret.preimage)).not.toThrow();
      expect(chain.getOrder(orderId).status).toBe("Claimed");
    });

    it("rejects an unrelated preimage with InvalidPreimage", () => {
      const other = generateSecret();
      expect(() => chain.claimOrder(orderId, other.preimage)).toThrow(/InvalidPreimage/);
      expect(chain.getOrder(orderId).status).toBe("Funded");
    });

    it("rejects refund while the order is still inside the timelock", () => {
      expect(() => chain.refundOrder(orderId)).toThrow(/NotExpired/);
      expect(chain.getOrder(orderId).status).toBe("Funded");
    });

    it("permits refund once the timelock has expired", () => {
      chain.advanceTime(PAST_TIMELOCK);
      expect(() => chain.refundOrder(orderId)).not.toThrow();
      expect(chain.getOrder(orderId).status).toBe("Refunded");
    });

    it("rejects claim once the timelock has expired", () => {
      chain.advanceTime(PAST_TIMELOCK);
      expect(() => chain.claimOrder(orderId, secret.preimage)).toThrow(/Expired/);
    });

    it("rejects a second claim against an already-claimed order", () => {
      chain.claimOrder(orderId, secret.preimage);
      expect(() => chain.claimOrder(orderId, secret.preimage)).toThrow(/OrderNotClaimable/);
    });
  });

  // ── Existing cross-chain round-trip: EVM ↔ Soroban ────────────────────────

  describe("cross-chain round-trip (eth ↔ stellar)", () => {
    it("one sha256 hashlock unlocks BOTH chains with the same preimage", () => {
      const secret = generateSecret();
      const evm = new EvmHtlcSim();
      const soroban = new SorobanHtlcSim();

      const evmId = evm.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const sorobanId = soroban.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

      evm.claimOrder(evmId, secret.preimage);
      soroban.claimOrder(sorobanId, secret.preimage);

      expect(evm.getOrder(evmId).status).toBe("Claimed");
      expect(soroban.getOrder(sorobanId).status).toBe("Claimed");
      expect(verifyPreimage(secret.preimage, secret.sha256)).toBe("sha256");
    });

    it("a keccak256-only hashlock works on EVM but is rejected by Soroban", () => {
      // This asymmetry is intentional: HTLCEscrow.sol accepts either
      // digest so it can interop with classic EVM tooling; the Soroban
      // contract is sha256-only. Cross-chain swaps therefore MUST use
      // the sha256 digest end-to-end.
      const secret = generateSecret();
      const evm = new EvmHtlcSim();
      const soroban = new SorobanHtlcSim();

      const evmId = evm.createOrder({ hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });
      const sorobanId = soroban.createOrder({ hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });

      expect(() => evm.claimOrder(evmId, secret.preimage)).not.toThrow();
      expect(() => soroban.claimOrder(sorobanId, secret.preimage)).toThrow(/InvalidPreimage/);
    });
  });

  // ── sol_to_eth route scenarios ────────────────────────────────────────────

  describe("sol_to_eth route", () => {
    // Happy path: user locks SOL on Solana, resolver locks ETH on Ethereum,
    // user claims ETH by revealing the preimage on-chain, resolver observes
    // the revealed preimage and claims SOL.
    it("happy path: sha256 hashlock unlocks both Solana and Ethereum legs", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      // User creates the source lock on Solana with a 24-hour timelock.
      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS,
      });

      // Resolver creates the destination lock on Ethereum with a 12-hour timelock.
      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,
      });

      // User (or relayer) claims ETH by revealing the preimage on Ethereum.
      expect(() => evm.claimOrder(evmId, secret.preimage)).not.toThrow();
      expect(evm.getOrder(evmId).status).toBe("Claimed");

      // Resolver observes the preimage on-chain and claims SOL.
      expect(() => solana.claimOrder(solanaId, secret.preimage)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Claimed");

      // Both legs settled with the same preimage.
      expect(verifyPreimage(secret.preimage, secret.sha256)).toBe("sha256");
    });

    // Hashlock parity: a keccak256-only hashlock is rejected by the Solana
    // HTLC just as it is by Soroban.  The route MUST use sha256 end-to-end.
    it("keccak256-only hashlock is accepted by EVM but rejected by Solana (sha256 required for cross-chain)", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({ hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });
      const evmId    = evm.createOrder({   hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });

      // EVM accepts keccak256 hashlocks (supports both sha256 and keccak256).
      expect(() => evm.claimOrder(evmId, secret.preimage)).not.toThrow();
      // Solana HTLC is sha256-only; must reject the keccak256 hashlock match.
      expect(() => solana.claimOrder(solanaId, secret.preimage)).toThrow(/InvalidPreimage/);
    });

    // Invalid preimage: a wrong preimage must be rejected on both legs.
    it("wrong preimage is rejected on both Solana and Ethereum legs", () => {
      const secret = generateSecret();
      const wrong  = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const evmId    = evm.createOrder({   hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

      expect(() => solana.claimOrder(solanaId, wrong.preimage)).toThrow(/InvalidPreimage/);
      expect(() => evm.claimOrder(evmId, wrong.preimage)).toThrow(/InvalidPreimage/);
      expect(solana.getOrder(solanaId).status).toBe("Funded");
      expect(evm.getOrder(evmId).status).toBe("Funded");
    });

    // Timelock expiry: once the Solana source lock expires the user can refund.
    it("user can refund on Solana after the source timelock expires", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();

      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS,
      });

      // Before expiry: refund must be rejected.
      expect(() => solana.refundOrder(solanaId)).toThrow(/NotExpired/);

      // Advance past the source timelock.
      solana.advanceTime(SOL_SRC_TIMELOCK_SECONDS + 1);
      expect(() => solana.refundOrder(solanaId)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Refunded");
    });

    // Destination ETH lock expires before the source Solana lock — the correct
    // ordering.  Resolver refunds ETH first, then user refunds SOL.
    it("resolver can refund ETH destination before Solana source due to asymmetric timelocks", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS, // 24 h
      });
      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,  // 12 h
      });

      // Simulate a partial settlement scenario: neither party claims.
      // Advance past the shorter ETH destination timelock (12 h + 1 s).
      const postEthExpiry = ETH_DST_TIMELOCK_SECONDS + 1;
      solana.advanceTime(postEthExpiry);
      evm.advanceTime(postEthExpiry);

      // Resolver can refund their ETH.
      expect(() => evm.refundOrder(evmId)).not.toThrow();
      expect(evm.getOrder(evmId).status).toBe("Refunded");

      // Solana source lock has NOT yet expired — user cannot refund yet.
      expect(() => solana.refundOrder(solanaId)).toThrow(/NotExpired/);
      expect(solana.getOrder(solanaId).status).toBe("Funded");

      // Advance past the remaining Solana source timelock.
      solana.advanceTime(SOL_SRC_TIMELOCK_SECONDS - postEthExpiry + 1);
      expect(() => solana.refundOrder(solanaId)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Refunded");
    });

    // Claim/refund race: if the destination ETH lock expires while the user
    // tries to claim, the claim must be rejected.
    it("claim is rejected on the Ethereum leg after the destination timelock expires", () => {
      const secret = generateSecret();
      const evm    = new EvmHtlcSim();

      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,
      });

      evm.advanceTime(ETH_DST_TIMELOCK_SECONDS + 1);

      expect(() => evm.claimOrder(evmId, secret.preimage)).toThrow(/Expired/);
      expect(evm.getOrder(evmId).status).toBe("Funded");
    });

    // Preimage replay: a preimage that resolves one leg must NOT unlock an
    // unrelated order on the other chain.  This verifies that each order's
    // hashlock is checked independently.
    it("preimage from one order does not unlock a different order on any chain", () => {
      const secretA = generateSecret();
      const secretB = generateSecret();

      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      // Order A: Solana source
      const solIdA = solana.createOrder({ hashlock: secretA.sha256, timelockSeconds: TIMELOCK_SECONDS });
      // Order B: Ethereum destination (different secret)
      const evmIdB = evm.createOrder({   hashlock: secretB.sha256, timelockSeconds: TIMELOCK_SECONDS });

      // Trying to claim order B on EVM with secret A should fail.
      expect(() => evm.claimOrder(evmIdB, secretA.preimage)).toThrow(/InvalidPreimage/);
      // Trying to claim order A on Solana with secret B should fail.
      expect(() => solana.claimOrder(solIdA, secretB.preimage)).toThrow(/InvalidPreimage/);
    });

    // State reconciliation after partial settlement: if ETH is claimed but
    // SOL refund is attempted before expiry the contract state must be sane.
    it("partial settlement: ETH claimed, Solana refund still blocked until expiry", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS,
      });
      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,
      });

      // Resolver claims ETH immediately.
      evm.claimOrder(evmId, secret.preimage);
      expect(evm.getOrder(evmId).status).toBe("Claimed");

      // Solana source order is still Funded — user has not yet been paid.
      expect(solana.getOrder(solanaId).status).toBe("Funded");

      // Attempted refund before expiry should still fail.
      expect(() => solana.refundOrder(solanaId)).toThrow(/NotExpired/);

      // Resolver can now claim SOL using the revealed preimage.
      expect(() => solana.claimOrder(solanaId, secret.preimage)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Claimed");
    });

    // Three-way sha256 parity: the same preimage must satisfy sha256 checks on
    // all three chain simulators, confirming end-to-end hashlock compatibility.
    it("sha256 hashlock satisfies all three chain simulators with the same preimage", () => {
      const secret  = generateSecret();
      const solana  = new SolanaHtlcSim();
      const evm     = new EvmHtlcSim();
      const soroban = new SorobanHtlcSim();

      const solanaId  = solana.createOrder({  hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const evmId     = evm.createOrder({     hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const sorobanId = soroban.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

      solana.claimOrder(solanaId,   secret.preimage);
      evm.claimOrder(evmId,         secret.preimage);
      soroban.claimOrder(sorobanId, secret.preimage);

      expect(solana.getOrder(solanaId).status).toBe("Claimed");
      expect(evm.getOrder(evmId).status).toBe("Claimed");
      expect(soroban.getOrder(sorobanId).status).toBe("Claimed");
    });
  });

  // ── Stuck refund paths and order expiry backstop ──────────────────────────
  //
  // These scenarios validate the bridge's safety guarantee: regardless of
  // resolver or relayer failure, users can always recover locked funds once
  // the timelock expires. The tests advance simulated time to trigger expiry
  // without any external dependency.

  describe("stuck refund paths and expiry backstop", () => {
    // ── Scenario 1: Resolver fails before creating the destination lock ──────
    //
    // The user locks funds on the source chain. The resolver sees the order
    // but fails (crash, insufficient balance, network partition) before
    // creating the destination lock. Only a source-side order exists.
    // After the source timelock expires, the user should be able to refund.

    describe("resolver fails before destination lock (source-only stuck order)", () => {
      it.each<{ label: string; factory: () => HtlcSim }>([
        { label: "EVM source",     factory: () => new EvmHtlcSim()     },
        { label: "Soroban source", factory: () => new SorobanHtlcSim() },
        { label: "Solana source",  factory: () => new SolanaHtlcSim()  },
      ])("$label: user can refund source lock after expiry when resolver never locked destination", ({ factory }) => {
        const secret = generateSecret();
        const source = factory();

        const srcId = source.createOrder({
          hashlock: secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });

        // Resolver never creates the destination lock — simulates a crash or
        // insufficient-funds failure on the destination chain.

        // Before expiry: refund must be blocked.
        expect(() => source.refundOrder(srcId)).toThrow(/NotExpired/);
        expect(source.getOrder(srcId).status).toBe("Funded");

        // Advance past expiry — this is the backstop the bridge always provides.
        source.advanceTime(TIMELOCK_SECONDS + 1);

        // User (or any permissionless caller) refunds the source lock.
        expect(() => source.refundOrder(srcId)).not.toThrow();
        expect(source.getOrder(srcId).status).toBe("Refunded");
      });
    });

    // ── Scenario 2: Resolver locks destination but then goes offline ─────────
    //
    // Both legs are locked. The user never claims the destination (e.g. the
    // relayer is down and the user's wallet is not watching). Neither leg is
    // claimed. After the shorter destination timelock expires the resolver can
    // reclaim the destination funds; after the longer source timelock expires
    // the user can reclaim the source funds.

    describe("both legs locked, neither claimed — full stuck-order refund sequence", () => {
      it("sol_to_eth: resolver refunds ETH destination, then user refunds Solana source", () => {
        const secret = generateSecret();
        const solana = new SolanaHtlcSim();
        const evm    = new EvmHtlcSim();

        const solanaId = solana.createOrder({
          hashlock: secret.sha256,
          timelockSeconds: SOL_SRC_TIMELOCK_SECONDS, // 24 h
        });
        const evmId = evm.createOrder({
          hashlock: secret.sha256,
          timelockSeconds: ETH_DST_TIMELOCK_SECONDS, // 12 h
        });

        // Resolver goes offline; neither party claims within the destination window.
        const afterDstExpiry = ETH_DST_TIMELOCK_SECONDS + 1;
        evm.advanceTime(afterDstExpiry);

        // Resolver can still refund its ETH (it doesn't need user cooperation).
        expect(() => evm.refundOrder(evmId)).not.toThrow();
        expect(evm.getOrder(evmId).status).toBe("Refunded");

        // Source order is still live — user cannot refund yet.
        solana.advanceTime(afterDstExpiry);
        expect(() => solana.refundOrder(solanaId)).toThrow(/NotExpired/);
        expect(solana.getOrder(solanaId).status).toBe("Funded");

        // Advance the rest of the source window.
        const remaining = SOL_SRC_TIMELOCK_SECONDS - afterDstExpiry + 1;
        solana.advanceTime(remaining);

        // User (or any caller) refunds Solana source.
        expect(() => solana.refundOrder(solanaId)).not.toThrow();
        expect(solana.getOrder(solanaId).status).toBe("Refunded");
      });

      it("eth_to_stellar: both EVM and Soroban source locks refunded independently after expiry", () => {
        const secret  = generateSecret();
        const evm     = new EvmHtlcSim();
        const soroban = new SorobanHtlcSim();

        const evmId     = evm.createOrder({     hashlock: secret.sha256, timelockSeconds: SOL_SRC_TIMELOCK_SECONDS });
        const sorobanId = soroban.createOrder({ hashlock: secret.sha256, timelockSeconds: ETH_DST_TIMELOCK_SECONDS });

        // Advance past both timelocks.
        evm.advanceTime(SOL_SRC_TIMELOCK_SECONDS + 1);
        soroban.advanceTime(ETH_DST_TIMELOCK_SECONDS + 1);

        expect(() => evm.refundOrder(evmId)).not.toThrow();
        expect(() => soroban.refundOrder(sorobanId)).not.toThrow();

        expect(evm.getOrder(evmId).status).toBe("Refunded");
        expect(soroban.getOrder(sorobanId).status).toBe("Refunded");
      });
    });

    // ── Scenario 3: Coordinator/relayer-assisted backstop refund ────────────
    //
    // The coordinator (or an independent relayer) monitors pending orders and
    // calls refundOrder once the timelock has passed. This is a fully
    // permissionless operation: the coordinator does not need any special
    // privileges, and the user's funds are never at risk even if the
    // coordinator is offline.

    describe("coordinator-assisted backstop refund (permissionless trigger)", () => {
      it("coordinator triggers refund on Solana after detecting stuck source-only order", () => {
        const secret = generateSecret();
        const solana = new SolanaHtlcSim();

        const srcId = solana.createOrder({
          hashlock: secret.sha256,
          timelockSeconds: SOL_SRC_TIMELOCK_SECONDS,
        });

        // Coordinator polls orders. At this point the order is Funded and has
        // not yet expired — coordinator must not refund early.
        expect(solana.getOrder(srcId).status).toBe("Funded");
        expect(() => solana.refundOrder(srcId)).toThrow(/NotExpired/);

        // Time passes. Coordinator's next reconciliation run happens after expiry.
        solana.advanceTime(SOL_SRC_TIMELOCK_SECONDS + 1);

        // Coordinator submits the permissionless refund on behalf of the user.
        expect(() => solana.refundOrder(srcId)).not.toThrow();
        expect(solana.getOrder(srcId).status).toBe("Refunded");
      });

      it("coordinator triggers refund on EVM after detecting stuck destination lock", () => {
        const secret = generateSecret();
        const evm    = new EvmHtlcSim();

        const dstId = evm.createOrder({
          hashlock: secret.sha256,
          timelockSeconds: ETH_DST_TIMELOCK_SECONDS,
        });

        // Coordinator sees the destination lock but no claim event arrives within
        // the window. After expiry it submits the refund.
        evm.advanceTime(ETH_DST_TIMELOCK_SECONDS + 1);

        expect(() => evm.refundOrder(dstId)).not.toThrow();
        expect(evm.getOrder(dstId).status).toBe("Refunded");
      });

      it("coordinator refund on all three chains simultaneously for a three-way stuck order", () => {
        const secret  = generateSecret();
        const solana  = new SolanaHtlcSim();
        const evm     = new EvmHtlcSim();
        const soroban = new SorobanHtlcSim();

        const solanaId  = solana.createOrder({  hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
        const evmId     = evm.createOrder({     hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
        const sorobanId = soroban.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

        // All three locked, none claimed. Coordinator advances time on all three.
        solana.advanceTime(TIMELOCK_SECONDS + 1);
        evm.advanceTime(TIMELOCK_SECONDS + 1);
        soroban.advanceTime(TIMELOCK_SECONDS + 1);

        // Coordinator submits refunds on all chains — all permissionless.
        expect(() => solana.refundOrder(solanaId)).not.toThrow();
        expect(() => evm.refundOrder(evmId)).not.toThrow();
        expect(() => soroban.refundOrder(sorobanId)).not.toThrow();

        expect(solana.getOrder(solanaId).status).toBe("Refunded");
        expect(evm.getOrder(evmId).status).toBe("Refunded");
        expect(soroban.getOrder(sorobanId).status).toBe("Refunded");
      });
    });

    // ── Scenario 4: Duplicate refund attempt (idempotency guard) ────────────
    //
    // Once a refund has been executed, a second attempt must be rejected.
    // This prevents double-spend in case of network re-submission.

    describe("refund idempotency — second refund attempt rejected", () => {
      it.each<{ label: string; factory: () => HtlcSim }>([
        { label: "EVM",     factory: () => new EvmHtlcSim()     },
        { label: "Soroban", factory: () => new SorobanHtlcSim() },
        { label: "Solana",  factory: () => new SolanaHtlcSim()  },
      ])("$label: second refundOrder on an already-refunded order is rejected", ({ factory }) => {
        const secret = generateSecret();
        const chain  = factory();

        const id = chain.createOrder({
          hashlock: secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });

        chain.advanceTime(TIMELOCK_SECONDS + 1);
        chain.refundOrder(id);
        expect(chain.getOrder(id).status).toBe("Refunded");

        // A second call — e.g. from a re-submitted transaction — must fail.
        expect(() => chain.refundOrder(id)).toThrow(/OrderNotRefundable/);
      });
    });

    // ── Scenario 5: Claim attempt after expiry, then refund succeeds ─────────
    //
    // Edge case: the secret arrives too late (after the timelock). The claim
    // must be rejected and the refund path must remain open.

    describe("claim-after-expiry then refund succeeds", () => {
      it.each<{ label: string; factory: () => HtlcSim }>([
        { label: "EVM",     factory: () => new EvmHtlcSim()     },
        { label: "Soroban", factory: () => new SorobanHtlcSim() },
        { label: "Solana",  factory: () => new SolanaHtlcSim()  },
      ])("$label: expired claim is rejected, then refund completes cleanly", ({ factory }) => {
        const secret = generateSecret();
        const chain  = factory();

        const id = chain.createOrder({
          hashlock: secret.sha256,
          timelockSeconds: TIMELOCK_SECONDS,
        });

        chain.advanceTime(TIMELOCK_SECONDS + 1);

        // Late-arriving claim must be rejected — order is expired.
        expect(() => chain.claimOrder(id, secret.preimage)).toThrow(/Expired/);
        // Order state must still be Funded (claim was rejected, not partially applied).
        expect(chain.getOrder(id).status).toBe("Funded");

        // Refund path is still intact.
        expect(() => chain.refundOrder(id)).not.toThrow();
        expect(chain.getOrder(id).status).toBe("Refunded");
      });
    });
  });
});
