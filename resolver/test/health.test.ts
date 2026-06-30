import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ResolverConfig } from "../src/config.js";
import { createResolverHealthServer } from "../src/health.js";
import { Supervisor } from "../src/supervisor.js";

const log = {
  child: () => log,
  error: () => undefined,
  warn: () => undefined,
} as any;

const cfg: ResolverConfig = {
  network: "testnet",
  pollIntervalMs: 15_000,
  coordinatorUrl: "http://localhost:3001",
  logLevel: "error",
  ethereum: {
    rpcUrl: "https://ethereum.example/rpc",
    chainId: 11_155_111,
    htlcEscrow: "0x0000000000000000000000000000000000000001",
    resolverRegistry: null,
    resolverPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
  },
  soroban: {
    rpcUrl: "https://soroban.example/rpc",
    horizonUrl: "https://horizon.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    htlc: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    resolverRegistry: null,
    resolverSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
};

let server: Server | null = null;

async function start(config: ResolverConfig = cfg) {
  const supervisor = new Supervisor({ log });
  server = createResolverHealthServer({ cfg: config, supervisor, startedAt: Date.now() });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, supervisor };
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("resolver health endpoints", () => {
  it("returns liveness without checking dependencies", async () => {
    const { baseUrl } = await start({
      ...cfg,
      ethereum: { ...cfg.ethereum, htlcEscrow: null },
    });

    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("wafflefinance-resolver");
  });

  it("returns readiness checks for configured dependencies", async () => {
    const { baseUrl } = await start();

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "ethereum_config", ok: true }),
        expect.objectContaining({ name: "soroban_config", ok: true }),
        expect.objectContaining({ name: "supervisor", ok: true }),
      ])
    );
  });

  it("marks readiness degraded when required chain config is missing", async () => {
    const { baseUrl } = await start({
      ...cfg,
      soroban: { ...cfg.soroban, htlc: null },
    });

    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks).toContainEqual(
      expect.objectContaining({ name: "soroban_config", ok: false })
    );
  });
});
