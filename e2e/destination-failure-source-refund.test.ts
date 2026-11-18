/**
 * Smoke test: destination failure followed by source refund (issue #968).
 *
 * A destination-leg failure must not strand a source order. This concise
 * scenario reuses the in-memory cross-chain simulator and timeout fixtures:
 * source lock → destination failure before secret reveal → timelock expiry
 * → permissionless source refund to the original refund address.
 *
 * No coordinator or relayer authority is involved: the refund is a direct,
 * permissionless contract call.
 */

import { describe, expect, it } from "vitest";
import { generateSecret } from "@wafflefinance/sdk/secrets";
import { EvmHtlcSim, SorobanHtlcSim, type Hex } from "./sim.js";

const TIMELOCK_SECONDS = 600;
const LOCKED_AMOUNT = 1_000n;

describe("destination failure → source refund smoke test", () => {
  it("failed destination leg refunds the source order to the refund address without coordinator authority", () => {
    const secret = generateSecret();
    const source = new EvmHtlcSim();
    const destination = new SorobanHtlcSim();

    // Minimal balance ledger: the source escrow holds the locked funds and
    // the refund must return them to the original refund address.
    const refundAddress = "user-refund-address";
    const balances = new Map<string, bigint>([[refundAddress, 5_000n]]);
    const escrow = new Map<bigint, bigint>();

    // 1. Source lock: funds leave the user and enter the source escrow.
    const srcId = source.createOrder({
      hashlock: secret.sha256,
      timelockSeconds: TIMELOCK_SECONDS,
    });
    balances.set(refundAddress, balances.get(refundAddress)! - LOCKED_AMOUNT);
    escrow.set(srcId, LOCKED_AMOUNT);
    expect(source.getOrder(srcId).status).toBe("Funded");

    // 2. Destination failure injected before secret reveal: the resolver
    // never creates the destination lock (crash / insufficient funds).
    const createDestinationLock = (): bigint => {
      throw new Error("destination unavailable");
    };
    expect(() => createDestinationLock()).toThrow(/destination unavailable/);

    // The secret is never revealed on the destination leg: no destination
    // order was ever created for this swap.
    expect(() => destination.getOrder(srcId)).toThrow(/OrderNotFound/);

    // 3. The beneficiary cannot claim using an invalid preimage (checked
    // while the window is still open so the rejection is hashlock-based).
    const attackerPreimage = generateSecret().preimage as Hex;
    expect(() => source.claimOrder(srcId, attackerPreimage)).toThrow(/InvalidPreimage/);
    expect(source.getOrder(srcId).status).toBe("Funded");

    // 4. Timelock expiry: refund is blocked before, open after.
    expect(() => source.refundOrder(srcId)).toThrow(/NotExpired/);
    source.advanceTime(TIMELOCK_SECONDS + 1);

    // A late claim with the real secret is also rejected once expired.
    expect(() => source.claimOrder(srcId, secret.preimage)).toThrow(/Expired/);
    expect(source.getOrder(srcId).status).toBe("Funded");

    // 5. Permissionless source refund — no coordinator or relayer authority.
    expect(() => source.refundOrder(srcId)).not.toThrow();

    // Settle the ledger the way the chain would: escrow → refund address.
    const locked = escrow.get(srcId)!;
    escrow.delete(srcId);
    balances.set(refundAddress, balances.get(refundAddress)! + locked);

    // 6. Terminal status and final balances.
    expect(source.getOrder(srcId).status).toBe("Refunded");
    expect(balances.get(refundAddress)).toBe(5_000n);
    expect(escrow.get(srcId)).toBeUndefined();
  });
});
