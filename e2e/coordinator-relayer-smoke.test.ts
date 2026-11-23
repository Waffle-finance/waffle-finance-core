/**
 * Issue #1119 — real-service coordinator ↔ relayer order smoke test.
 *
 * Starts both services as separate HTTP processes with a temporary database
 * and deterministic chain fixtures, then drives an order's metadata lifecycle
 * across the real HTTP boundary and verifies API-visible persisted state.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvironment,
  startCoordinator,
  startRelayer,
  restart,
  runSettlement,
  orderInput,
  type TestEnvironment,
} from "./service-harness.js";
import { generateSecret } from "@wafflefinance/sdk/secrets";

let env: TestEnvironment;

afterEach(async () => {
  await env?.cleanup();
});

describe("coordinator ↔ relayer real-service smoke", () => {
  it("starts both services, announces an order, and completes its metadata lifecycle", async () => {
    env = createEnvironment();
    await startCoordinator(env);
    await startRelayer(env);

    const secret = generateSecret();
    const input = orderInput("eth_to_xlm", secret.sha256, env.chains);

    const first = await fetch(`${env.coordinator!.url}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(first.status).toBe(201);
    const order = await first.json();

    // Idempotency: a repeated announce over HTTP returns the same order.
    const repeat = await fetch(`${env.coordinator!.url}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).publicId).toBe(order.publicId);

    // Relayer reads the same order over HTTP, not via a shared repository call.
    const viaRelayer = await fetch(`${env.relayer!.url}/api/orders/${order.publicId}`);
    expect(viaRelayer.status).toBe(200);
    expect((await viaRelayer.json()).hashlock).toBe(secret.sha256);

    // Deliver the lifecycle events through the relayer and assert API state.
    const result = await runSettlement(env);
    expect(result.order.status).toBe("completed");
    expect(result.transitions).toContain("status.transitioned");

    const persisted = await fetch(`${env.coordinator!.url}/api/orders/${result.publicId}`);
    expect((await persisted.json()).status).toBe("completed");

    // Restart the coordinator: the same state must be visible from a fresh
    // service process backed by the same temporary database.
    await restart(env, "coordinator");
    const afterRestart = await fetch(`${env.coordinator!.url}/api/orders/${result.publicId}`);
    expect((await afterRestart.json()).status).toBe("completed");
    expect(env.relayer!.ledger!.count()).toBeGreaterThan(0);
  }, 15_000);

  it("cleans up all processes and temp data and is repeatable", async () => {
    for (let run = 0; run < 2; run++) {
      env = createEnvironment();
      await startCoordinator(env);
      await startRelayer(env);
      const result = await runSettlement(env);
      expect(result.order.status).toBe("completed");
      expect(env.coordinator!.url).not.toBe(env.relayer!.url);
      await env.cleanup();
      env = undefined as unknown as TestEnvironment;
    }
  }, 15_000);
});
