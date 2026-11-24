/**
 * Issue #1123 — fault injection for partial chain RPC outages in E2E.
 *
 * A single chain is made unavailable (or slowed) while the other chain keeps
 * progressing. The tests assert that a chain outage never marks an order
 * terminal and that recovery replays missed events exactly once.
 */

import { afterEach, describe, expect, it } from "vitest";
import { generateSecret } from "@wafflefinance/sdk/secrets";
import {
  createEnvironment,
  orderInput,
  startCoordinator,
  startRelayer,
  type ChainEvent,
  type TestEnvironment,
} from "./service-harness.js";

let env: TestEnvironment;

afterEach(async () => {
  await env?.cleanup();
  env = undefined as unknown as TestEnvironment;
});

async function announce(): Promise<string> {
  const secret = generateSecret();
  const res = await fetch(`${env.coordinator!.url}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(orderInput("eth_to_xlm", secret.sha256, env.chains)),
  });
  return ((await res.json()) as { publicId: string }).publicId;
}

async function deliver(chain: keyof TestEnvironment["chains"], event: ChainEvent, publicId: string) {
  env.chains[chain].enqueue(event);
  return env.chains[chain].deliver(async (e) => {
    const res = await fetch(`${env.relayer!.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...e, publicId }),
    });
    if (!res.ok) throw new Error(`relayer rejected event: ${await res.text()}`);
  });
}

async function status(publicId: string) {
  return (await (await fetch(`${env.coordinator!.url}/api/orders/${publicId}`)).json()).status as string;
}

describe("partial chain RPC outage", () => {
  it("one-chain timeout does not suppress healthy-chain progress or corrupt state", async () => {
    env = createEnvironment();
    await startCoordinator(env);
    await startRelayer(env);
    const publicId = await announce();

    env.chains.ethereum.control.fail = true;
    env.chains.ethereum.enqueue({
      key: `${publicId}:src_lock`,
      kind: "src_lock",
      payload: { orderId: "1", txHash: "0xsrc", blockNumber: 1, timelock: 1200 },
    });
    await expect(
      env.chains.ethereum.deliver(async (event) => {
        const res = await fetch(`${env.relayer!.url}/api/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...event, publicId }),
        });
        expect(res.ok).toBe(true);
      })
    ).rejects.toThrow(/RPC outage/);

    // Healthy chain event is still processed over HTTP during the outage.
    const healthy = await deliver("stellar", {
      key: `${publicId}:dst_lock`,
      kind: "dst_lock",
      payload: { orderId: "2", txHash: "0xdst", blockNumber: 2, timelock: 600 },
    }, publicId);
    expect(healthy).toBe(1);
    expect(["announced", "dst_locked"]).toContain(await status(publicId));

    env.chains.ethereum.control.fail = false;
    const replayed = await env.chains.ethereum.deliver(async (event) => {
      const res = await fetch(`${env.relayer!.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...event, publicId }),
      });
      expect(res.ok).toBe(true);
    });
    expect(replayed).toBe(1);
    expect(env.relayer!.ledger!.all().filter((r) => r.key === `${publicId}:src_lock`)).toHaveLength(1);
    expect(["src_locked", "dst_locked"]).toContain(await status(publicId));
  }, 15_000);

  it("recovery replays missed events exactly once after a delayed response", async () => {
    env = createEnvironment();
    await startCoordinator(env);
    await startRelayer(env);
    const publicId = await announce();

    env.chains.stellar.control.delayMs = 10;
    // Delayed event is queued first; a second event on the healthy chain is
    // delivered while the first response is still in flight (reordering).
    env.chains.stellar.enqueue({
      key: `${publicId}:dst_lock`,
      kind: "dst_lock",
      payload: { orderId: "2", txHash: "0xdst", blockNumber: 2, timelock: 600 },
    });
    const healthyFirst = await deliver("ethereum", {
      key: `${publicId}:src_lock`,
      kind: "src_lock",
      payload: { orderId: "1", txHash: "0xsrc", blockNumber: 1, timelock: 1200 },
    }, publicId);
    expect(healthyFirst).toBe(1);
    expect(env.chains.stellar.delivered.size).toBe(0);

    env.chains.stellar.control.delayMs = 0;
    const delayed = await env.chains.stellar.deliver(async (event) => {
      const res = await fetch(`${env.relayer!.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...event, publicId }),
      });
      expect(res.ok).toBe(true);
    });
    expect(delayed).toBe(1);

    // Re-running reconciliation must not replay anything a second time.
    const secondPass = await env.chains.stellar.deliver(async () => {
      throw new Error("missed event replayed twice");
    });
    expect(secondPass).toBe(0);
    const keys = env.relayer!.ledger!.all().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`${publicId}:dst_lock`);
  }, 15_000);
});
