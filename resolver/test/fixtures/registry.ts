/**
 * Registry fixtures for resolver integration tests (issue #1097).
 *
 * `scriptedProbe` returns a RegistryProbe whose response can be swapped
 * mid-test to simulate the on-chain registry changing (deactivation, slash,
 * outage) between an order being accepted and settled.
 */
import type { ResolverConfig } from "../../src/config.js";
import type { RawRegistryInfo, RegistryProbe } from "../../src/registry-status.js";

export const ACTIVE: RawRegistryInfo = {
  registered: true,
  active: true,
  stake: 100n,
  minStake: 50n,
  totalSlashed: 0n,
  unbondingAt: null,
};

export const INACTIVE: RawRegistryInfo = { ...ACTIVE, active: false };

export const SLASHED: RawRegistryInfo = { ...ACTIVE, stake: 40n, totalSlashed: 60n };

export const LOW_STAKE: RawRegistryInfo = { ...ACTIVE, stake: 40n };

export const UNBONDING: RawRegistryInfo = { ...ACTIVE, unbondingAt: 1_700_000_000n };

export const UNREGISTERED: RawRegistryInfo = {
  ...ACTIVE,
  registered: false,
  active: false,
  stake: 0n,
};

/** Sentinel: the probe throws, as on an RPC outage. */
export const UNAVAILABLE = Symbol("registry-unavailable");
/** Sentinel: the chain has no registry configured (probe returns null). */
export const NOT_CONFIGURED = Symbol("registry-not-configured");

export type RegistryResponse = RawRegistryInfo | typeof UNAVAILABLE | typeof NOT_CONFIGURED;

export interface ScriptedProbe {
  probe: RegistryProbe;
  set(response: RegistryResponse): void;
  calls: number;
}

export function scriptedProbe(initial: RegistryResponse): ScriptedProbe {
  let current = initial;
  const handle: ScriptedProbe = {
    calls: 0,
    set(response) {
      current = response;
    },
    probe: async () => {
      handle.calls++;
      if (current === UNAVAILABLE) throw new Error("ECONNREFUSED registry rpc");
      if (current === NOT_CONFIGURED) return null;
      return current;
    },
  };
  return handle;
}

export function resolverConfig(): ResolverConfig {
  return {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "info",
    ethereum: {
      rpcUrl: "https://rpc.example/testnet",
      chainId: 11_155_111,
      htlcEscrow: null,
      resolverRegistry: null,
      resolverPrivateKey: null,
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      horizonUrl: "https://horizon-testnet.stellar.org",
      htlc: null,
      resolverRegistry: null,
      resolverSecret: null,
    },
  } as ResolverConfig;
}
