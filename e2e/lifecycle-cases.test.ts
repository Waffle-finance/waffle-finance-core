import { describe, expect, it } from "vitest";
import { generateSecret } from "@wafflefinance/sdk/secrets";
import {
  EvmHtlcSim,
  SorobanHtlcSim,
  SolanaHtlcSim,
  SimError,
  type HtlcSim,
} from "./sim.js";

/**
 * Shared cross-chain lifecycle edge-case table (issue #967).
 *
 * The in-memory simulators and the contract-level lifecycle tests must agree
 * on these invariant cases. Only cases supported across ALL THREE simulators
 * are included here.
 *
 * Chain-specific differences (documented, not hidden):
 * - EVM accepts a preimage when EITHER sha256 OR keccak256 matches the
 *   hashlock; Soroban and Solana are sha256-only. Cross-chain routes MUST
 *   therefore use sha256 end-to-end (covered in cross-chain.test.ts, not
 *   in this invariant table).
 * - Terminal states and balances below are identical on all chains: this
 *   table asserts status transitions only (the sims hold no balances).
 */

const TIMELOCK_SECONDS = 600;

interface LifecycleCase {
  /** Stable name — printed on failure so the failing case is identifiable. */
  name: string;
  run: (chain: HtlcSim) => void;
}

export const LIFECYCLE_CASES: LifecycleCase[] = [
  {
    name: "claim with correct preimage reaches Claimed",
    run: (chain) => {
      const secret = generateSecret();
      const id = chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      chain.claimOrder(id, secret.preimage);
      expect(chain.getOrder(id).status).toBe("Claimed");
    },
  },
  {
    name: "claim with invalid preimage is rejected, order stays Funded",
    run: (chain) => {
      const secret = generateSecret();
      const wrong = generateSecret();
      const id = chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      expect(() => chain.claimOrder(id, wrong.preimage)).toThrow(SimError);
      expect(chain.getOrder(id).status).toBe("Funded");
    },
  },
  {
    name: "refund before expiry is rejected with NotExpired",
    run: (chain) => {
      const secret = generateSecret();
      const id = chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      expect(() => chain.refundOrder(id)).toThrow(/NotExpired/);
      expect(chain.getOrder(id).status).toBe("Funded");
    },
  },
  {
    name: "refund after expiry reaches Refunded",
    run: (chain) => {
      const secret = generateSecret();
      const id = chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      chain.advanceTime(TIMELOCK_SECONDS + 1);
      chain.refundOrder(id);
      expect(chain.getOrder(id).status).toBe("Refunded");
    },
  },
  {
    name: "double claim is rejected, order stays Claimed",
    run: (chain) => {
      const secret = generateSecret();
      const id = chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      chain.claimOrder(id, secret.preimage);
      expect(() => chain.claimOrder(id, secret.preimage)).toThrow(/OrderNotClaimable/);
      expect(chain.getOrder(id).status).toBe("Claimed");
    },
  },
  {
    name: "claim after expiry is rejected, refund path stays open",
    run: (chain) => {
      const secret = generateSecret();
      const id = chain.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      chain.advanceTime(TIMELOCK_SECONDS + 1);
      expect(() => chain.claimOrder(id, secret.preimage)).toThrow(/Expired/);
      expect(chain.getOrder(id).status).toBe("Funded");
      chain.refundOrder(id);
      expect(chain.getOrder(id).status).toBe("Refunded");
    },
  },
];

const CHAINS: Array<{ label: string; factory: () => HtlcSim }> = [
  { label: "EVM", factory: () => new EvmHtlcSim() },
  { label: "Soroban", factory: () => new SorobanHtlcSim() },
  { label: "Solana", factory: () => new SolanaHtlcSim() },
];

describe.each(CHAINS)("$label simulator — shared lifecycle cases", ({ factory }) => {
  it.each(LIFECYCLE_CASES)("$name", ({ run }) => {
    run(factory());
  });
});
