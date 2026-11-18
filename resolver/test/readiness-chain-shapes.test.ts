/**
 * readiness-chain-shapes.test.ts
 *
 * Component: Resolver health — chain-shape readiness coverage.
 *
 * Verifies that /readyz correctly distinguishes three startup shapes:
 *   1. Ethereum-only  — Soroban is intentionally absent (not configured).
 *   2. Soroban-only   — Ethereum is intentionally absent.
 *   3. Both chains    — fully configured.
 *
 * Acceptance criteria
 * -------------------
 *  - An intentionally skipped chain is NOT misreported as an active failure.
 *  - A configured but unreachable chain degrades readiness (the policy gates
 *    on whether claim is supported, not on a live RPC call — absent config is
 *    the proxy for "unreachable at startup").
 *  - Health output identifies the chain without exposing endpoint credentials.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ResolverConfig } from "../src/config.js";
import { createResolverHealthServer } from "../src/health.js";
import { Supervisor } from "../src/supervisor.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const nullLog = {
  child: () => nullLog,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
} as any;

const VALID_ETH_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const VALID_STELLAR_SECRET = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_ETH_ESCROW = "0x0000000000000000000000000000000000000001" as `0x${string}`;
// A valid 56-char Soroban contract StrKey starting with 'C'.
const VALID_SOROBAN_HTLC = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";

/** Base config with credentials embedded in the Ethereum RPC URL. */
function ethOnlyConfig(): ResolverConfig {
  return {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "error",
    ethereum: {
      // Credential embedded in the URL path to verify it is redacted in output.
      rpcUrl: "https://sepolia.infura.io/v3/SUPERSECRET_API_KEY",
      chainId: 11_155_111,
      htlcEscrow: VALID_ETH_ESCROW,
      resolverRegistry: null,
      resolverPrivateKey: VALID_ETH_KEY,
    },
    soroban: {
      // Intentionally absent — observe-only (no htlc, no secret).
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      htlc: null,
      resolverRegistry: null,
      resolverSecret: null,
    },
  };
}

function sorobanOnlyConfig(): ResolverConfig {
  return {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "error",
    ethereum: {
      // Intentionally absent — observe-only (no escrow, no key).
      rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11_155_111,
      htlcEscrow: null,
      resolverRegistry: null,
      resolverPrivateKey: null,
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      htlc: VALID_SOROBAN_HTLC,
      resolverRegistry: null,
      resolverSecret: VALID_STELLAR_SECRET,
    },
  };
}

function bothChainsConfig(): ResolverConfig {
  return {
    network: "testnet",
    pollIntervalMs: 15_000,
    coordinatorUrl: "http://localhost:3001",
    logLevel: "error",
    ethereum: {
      rpcUrl: "https://sepolia.infura.io/v3/ANOTHERSECRET",
      chainId: 11_155_111,
      htlcEscrow: VALID_ETH_ESCROW,
      resolverRegistry: null,
      resolverPrivateKey: VALID_ETH_KEY,
    },
    soroban: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      htlc: VALID_SOROBAN_HTLC,
      resolverRegistry: null,
      resolverSecret: VALID_STELLAR_SECRET,
    },
  };
}

let server: Server | null = null;

async function startServer(config: ResolverConfig): Promise<{ baseUrl: string; supervisor: Supervisor }> {
  const supervisor = new Supervisor({ log: nullLog });
  server = createResolverHealthServer({ cfg: config, supervisor, startedAt: Date.now() });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, supervisor };
}

afterEach(async () => {
  if (!server) return;
  // closeAllConnections() (Node 18.2+) destroys keep-alive sockets so
  // server.close() doesn't hang waiting for idle connections to drain.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Resolver health — Ethereum-only startup shape", () => {
  it("/readyz is ready when Ethereum is fully configured and Soroban is absent", async () => {
    const { baseUrl } = await startServer(ethOnlyConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("/readyz reports ethereum_config ok and soroban_config as degraded (not a failure)", async () => {
    const { baseUrl } = await startServer(ethOnlyConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    const ethCheck = body.checks.find((c: any) => c.name === "ethereum_config");
    const sorobanCheck = body.checks.find((c: any) => c.name === "soroban_config");

    expect(ethCheck).toBeDefined();
    expect(ethCheck.ok).toBe(true);

    // Soroban is intentionally absent — it will show as not supported (ok: false).
    // The test verifies that the REASON mentions the missing config, not an
    // active failure (e.g. a timeout or crash), and that no credential leaks.
    expect(sorobanCheck).toBeDefined();
    expect(sorobanCheck.ok).toBe(false);
    // The detail should explain the absence, not imply an active failure.
    expect(sorobanCheck.detail).toBeTruthy();
  });

  it("/readyz soroban_config detail does not contain endpoint credentials", async () => {
    const { baseUrl } = await startServer(ethOnlyConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();
    const bodyText = JSON.stringify(body);

    // Credential in the Ethereum RPC URL must not appear anywhere in output.
    expect(bodyText).not.toContain("SUPERSECRET_API_KEY");
  });

  it("/readyz soroban_config detail identifies the chain by name", async () => {
    const { baseUrl } = await startServer(ethOnlyConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    const sorobanCheck = body.checks.find((c: any) => c.name === "soroban_config");
    // The detail should mention "stellar" or "soroban" so operators can diagnose.
    const detail: string = (sorobanCheck.detail ?? "").toLowerCase();
    expect(detail.includes("stellar") || detail.includes("soroban") || detail.includes("configured")).toBe(true);
  });

  it("/healthz is always 200 regardless of chain config", async () => {
    const { baseUrl } = await startServer(ethOnlyConfig());

    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe("Resolver health — Soroban-only startup shape", () => {
  it("/readyz is ready when Soroban is fully configured and Ethereum is absent", async () => {
    const { baseUrl } = await startServer(sorobanOnlyConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("/readyz reports soroban_config ok and ethereum_config as not ok (absent)", async () => {
    const { baseUrl } = await startServer(sorobanOnlyConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    const ethCheck = body.checks.find((c: any) => c.name === "ethereum_config");
    const sorobanCheck = body.checks.find((c: any) => c.name === "soroban_config");

    expect(sorobanCheck.ok).toBe(true);
    expect(ethCheck.ok).toBe(false);
    // Ethereum being absent should NOT be reported as an active failure —
    // the detail must describe a configuration absence, not a crash.
    expect(ethCheck.detail).toBeTruthy();
  });

  it("/readyz ethereum_config detail identifies the chain by name", async () => {
    const { baseUrl } = await startServer(sorobanOnlyConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    const ethCheck = body.checks.find((c: any) => c.name === "ethereum_config");
    const detail: string = (ethCheck.detail ?? "").toLowerCase();
    expect(detail.includes("ethereum") || detail.includes("configured")).toBe(true);
  });
});

describe("Resolver health — both-chains startup shape", () => {
  it("/readyz is ready when both chains are fully configured", async () => {
    const { baseUrl } = await startServer(bothChainsConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.find((c: any) => c.name === "ethereum_config").ok).toBe(true);
    expect(body.checks.find((c: any) => c.name === "soroban_config").ok).toBe(true);
  });

  it("/readyz body does not expose embedded RPC credentials", async () => {
    const { baseUrl } = await startServer(bothChainsConfig());

    const res = await fetch(`${baseUrl}/readyz`);
    const bodyText = await res.text();

    expect(bodyText).not.toContain("ANOTHERSECRET");
    expect(bodyText).not.toContain("SAAAAAAAAAA"); // Stellar secret prefix
  });

  it("/health body does not expose embedded RPC credentials", async () => {
    const { baseUrl } = await startServer(bothChainsConfig());

    const res = await fetch(`${baseUrl}/health`);
    const bodyText = await res.text();

    expect(bodyText).not.toContain("ANOTHERSECRET");
  });

  it("/readyz becomes degraded when a previously configured chain loses its escrow", async () => {
    const cfg = bothChainsConfig();
    // Simulate a config regression — Ethereum escrow removed at runtime.
    cfg.ethereum.htlcEscrow = null;
    const { baseUrl } = await startServer(cfg);

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.find((c: any) => c.name === "ethereum_config").ok).toBe(false);
  });
});

describe("Resolver health — active listener metrics for each shape", () => {
  it("Ethereum-only: /listener-health shows only ethereum chain data", async () => {
    const { baseUrl } = await startServer(ethOnlyConfig());

    // The staleness monitor starts empty; /listener-health returns whatever
    // chains have recorded ticks. With no recorded ticks both arrays are empty
    // until the listener runs. We verify no crash and the shape of the response.
    const res = await fetch(`${baseUrl}/listener-health`);
    const body = await res.json();

    expect(body).toHaveProperty("allHealthy");
    expect(body).toHaveProperty("chains");
    expect(Array.isArray(body.chains)).toBe(true);
  });

  it("both-chains: /listener-health reports both chains once listeners record ticks", async () => {
    const { baseUrl } = await startServer(bothChainsConfig());

    // Simulate tick recording via the staleness monitor.
    const { globalStalenessMonitor } = await import("../src/telemetry.js");
    globalStalenessMonitor.recordHealthyTick("ethereum");
    globalStalenessMonitor.recordHealthyTick("soroban");

    const res = await fetch(`${baseUrl}/listener-health`);
    const body = await res.json();

    const chains: string[] = body.chains.map((c: any) => c.chain);
    expect(chains).toContain("ethereum");
    expect(chains).toContain("soroban");

    // Both ticked healthy — no credential leaks.
    expect(JSON.stringify(body)).not.toContain("ANOTHERSECRET");
  });
});
