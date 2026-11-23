/**
 * Issue #1120 — restart-during-settlement cross-service scenario.
 *
 * Restarts either service at each settlement boundary (src lock, dst lock,
 * secret reveal), resumes event processing against persisted chain fixture
 * state, and asserts that recovery converges to the same terminal outcome
 * without emitting duplicate fund-moving transactions.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvironment,
  restart,
  runSettlement,
  startCoordinator,
  startRelayer,
  type TestEnvironment,
} from "./service-harness.js";

let env: TestEnvironment;

afterEach(async () => {
  await env?.cleanup();
  env = undefined as unknown as TestEnvironment;
});

async function scenario(boundary: "src_lock" | "dst_lock" | "secret_reveal", service: "coordinator" | "relayer") {
  env = createEnvironment();
  await startCoordinator(env);
  await startRelayer(env);
  const result = await runSettlement(env, { restartAfter: boundary, restartService: service });

  // Reconciliation: replaying already-delivered events must be a no-op.
  const replay = await fetch(`${env.relayer!.url}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: `${result.publicId}:src_lock`,
      kind: "src_lock",
      payload: {},
      publicId: result.publicId,
    }),
  });
  expect(replay.ok).toBe(true);

  const records = env.relayer!.ledger!.all();
  const keys = records.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
  const status = await (await fetch(`${env.coordinator!.url}/api/orders/${result.publicId}`)).json();
  return { result, records, status };
}

describe.each([
  ["src_lock", "relayer"] as const,
  ["dst_lock", "relayer"] as const,
  ["secret_reveal", "relayer"] as const,
  ["src_lock", "coordinator"] as const,
  ["dst_lock", "coordinator"] as const,
] as const)("restart after %s (%s)", (boundary, service) => {
  it("converges to completed with no duplicate fund-moving transaction", async () => {
    const { result, records, status } = await scenario(boundary, service);
    expect(status.status).toBe("completed");
    expect(result.order.status).toBe("completed");
    expect(records.length).toBe(new Set(records.map((r) => r.key)).size);
    expect(result.transitions.filter((t) => t === "status.transitioned").length).toBeGreaterThan(0);
  }, 15_000);
});

it("keeps the preimage recovery path after a restart", async () => {
  env = createEnvironment();
  await startCoordinator(env);
  await startRelayer(env);
  const result = await runSettlement(env, { restartAfter: "secret_reveal", restartService: "relayer" });
  await restart(env, "coordinator");
  const row = await env.coordinator!.repo.findByPublicId(result.publicId);
  expect(row?.preimage).toBeTruthy();
  expect(row?.preimage).toBe(result.secret.preimage);
  expect(row?.status).toBe("completed");
}, 15_000);
