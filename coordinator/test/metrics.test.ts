import { beforeEach, describe, expect, it } from "vitest";
import {
  observeListenerEventProcessing,
  recordListenerProgress,
  registry
} from "../src/metrics.js";

describe("listener metrics", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("records processed block, head block, and listener lag", async () => {
    recordListenerProgress("soroban", 120, 125);

    const metrics = await registry.metrics();

    expect(metrics).toContain('coordinator_listener_last_block{chain="soroban"} 120');
    expect(metrics).toContain('coordinator_listener_head_block{chain="soroban"} 125');
    expect(metrics).toContain('coordinator_listener_lag_blocks{chain="soroban"} 5');
  });

  it("clamps negative listener lag to zero", async () => {
    recordListenerProgress("ethereum", 130, 125);

    const metrics = await registry.metrics();

    expect(metrics).toContain('coordinator_listener_lag_blocks{chain="ethereum"} 0');
  });

  it("observes event processing durations by chain and event", async () => {
    observeListenerEventProcessing("ethereum", "OrderCreated", Date.now() - 25);

    const metrics = await registry.metrics();

    expect(metrics).toMatch(
      /coordinator_listener_event_processing_duration_seconds_count\{chain="ethereum",event="OrderCreated"\} 1/
    );
  });
});
